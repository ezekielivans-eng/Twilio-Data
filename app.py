import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

from flask import Flask, g, jsonify, render_template, request
from flask_compress import Compress

import config

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


class ValidationError(ValueError):
    """Raised for invalid client input (results in 400 response)."""
    pass


_SID_RE = re.compile(r"^AC[0-9a-fA-F]{32}$")
from cache import TTLCache
from data_aggregator import (
    aggregate_billing,
    aggregate_by_date,
    aggregate_by_template,
    aggregate_daily_spend,
    aggregate_message_statuses,
    build_subaccount_summary,
)
from twilio_client import (
    get_content_templates,
    get_messages,
    get_subaccounts,
    get_usage_records,
)

app = Flask(__name__)
app.secret_key = config.FLASK_SECRET_KEY
Compress(app)

cache = TTLCache(ttl_seconds=config.CACHE_TTL_SECONDS)


@app.before_request
def _start_timer():
    g.start_time = time.time()


@app.after_request
def _log_request(response):
    if request.path.startswith("/api/"):
        duration = time.time() - getattr(g, "start_time", time.time())
        logger.info("%s %s %s %.2fs", request.method, request.path, response.status_code, duration)
    return response


MAX_DATE_RANGE_DAYS = 30


def parse_date_params():
    date_to = request.args.get("date_to")
    date_from = request.args.get("date_from")
    try:
        if date_to:
            date_to = datetime.strptime(date_to, "%Y-%m-%d")
        else:
            date_to = datetime.utcnow()
    except ValueError:
        raise ValidationError(f"Invalid date_to format: expected YYYY-MM-DD, got '{date_to}'")
    try:
        if date_from:
            date_from = datetime.strptime(date_from, "%Y-%m-%d")
        else:
            date_from = date_to - timedelta(days=config.DATE_RANGE_DAYS)
    except ValueError:
        raise ValidationError(f"Invalid date_from format: expected YYYY-MM-DD, got '{date_from}'")
    if date_from > date_to:
        raise ValidationError("date_from must not be after date_to")
    # Cap to maximum 30 days
    if (date_to - date_from).days > MAX_DATE_RANGE_DAYS:
        date_from = date_to - timedelta(days=MAX_DATE_RANGE_DAYS)
    return date_from, date_to


def validate_account_sid(sid):
    """Validate and clean an account SID parameter."""
    sid = sid.strip()
    if not _SID_RE.match(sid):
        raise ValidationError(f"Invalid account SID format: '{sid}'")
    return sid


SLOW_CHANGE_TTL = 3600  # 1 hour for data that rarely changes


def cached_subaccounts():
    key = "subaccounts"
    data = cache.get(key)
    if data is None:
        data = get_subaccounts()
        cache.set(key, data, ttl=SLOW_CHANGE_TTL)
    return data


def cached_messages(account_sid, date_from, date_to):
    key = f"messages:{account_sid}:{date_from}:{date_to}"
    data = cache.get(key)
    if data is None:
        result = get_messages(account_sid, date_from, date_to)
        # get_messages now returns {"messages": [...], "limit_reached": bool}
        data = result
        cache.set(key, data)
    return data


def cached_usage(account_sid, date_from, date_to):
    key = f"usage:{account_sid}:{date_from}:{date_to}"
    data = cache.get(key)
    if data is None:
        data = get_usage_records(account_sid, date_from, date_to)
        cache.set(key, data)
    return data


def cached_templates():
    key = "content_templates"
    data = cache.get(key)
    if data is None:
        data = get_content_templates()
        cache.set(key, data, ttl=SLOW_CHANGE_TTL)
    return data


def get_all_subaccount_data(date_from, date_to):
    subaccounts = cached_subaccounts()
    # Always include the main account, but deduplicate by SID
    seen_sids = set()
    all_accounts = []
    main_entry = {"sid": config.TWILIO_ACCOUNT_SID, "friendly_name": "Main Account"}
    all_accounts.append(main_entry)
    seen_sids.add(config.TWILIO_ACCOUNT_SID)
    for acct in subaccounts:
        if acct["sid"] not in seen_sids:
            all_accounts.append(acct)
            seen_sids.add(acct["sid"])

    def fetch_one(acct):
        sid = acct["sid"]
        msg_data = cached_messages(sid, date_from, date_to)
        usage = cached_usage(sid, date_from, date_to)
        return {
            "sid": sid,
            "friendly_name": acct["friendly_name"],
            "messages": msg_data["messages"],
            "limit_reached": msg_data["limit_reached"],
            "usage": usage,
        }

    results = []
    errors = []
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {executor.submit(fetch_one, acct): acct for acct in all_accounts}
        for future in as_completed(futures, timeout=150):
            try:
                results.append(future.result(timeout=60))
            except Exception as e:
                acct = futures[future]
                logger.warning("Failed to fetch data for %s (%s): %s", acct["friendly_name"], acct["sid"], e)
                errors.append(f"Failed to fetch data for {acct['friendly_name']}: {e}")
                results.append(
                    {
                        "sid": acct["sid"],
                        "friendly_name": acct["friendly_name"],
                        "messages": [],
                        "limit_reached": False,
                        "usage": [],
                    }
                )

    return results, errors


ALL_STATUSES = {"delivered", "read", "sent", "failed", "undelivered", "queued", "sending"}


def apply_message_filters(messages, direction_filter, status_values):
    """Filter messages by direction and status. status_values is a set of statuses."""
    if direction_filter == "outbound":
        messages = [m for m in messages if m.get("direction", "").startswith("outbound")]
    elif direction_filter == "inbound":
        messages = [m for m in messages if m.get("direction", "") == "inbound"]
    if status_values and status_values != ALL_STATUSES:
        messages = [m for m in messages if m.get("status") in status_values]
    return messages


def parse_status_filter():
    """Parse comma-separated status filter param into a set."""
    raw = request.args.get("status", "")
    if not raw:
        return ALL_STATUSES  # no filter = all
    return set(raw.split(",")) & ALL_STATUSES


def get_account_list():
    """Return deduplicated account list for filter dropdowns."""
    subaccounts = cached_subaccounts()
    account_list = [
        {"sid": config.TWILIO_ACCOUNT_SID, "friendly_name": "Main Account"}
    ]
    seen = {config.TWILIO_ACCOUNT_SID}
    for a in subaccounts:
        if a["sid"] not in seen:
            account_list.append({"sid": a["sid"], "friendly_name": a["friendly_name"]})
            seen.add(a["sid"])
    return account_list


def filter_data_by_accounts(all_data, account_filter, exclude_accounts):
    """Filter all_data by account_sid or exclude_accounts."""
    if account_filter:
        all_data = [e for e in all_data if e["sid"] == account_filter]
    elif exclude_accounts:
        exclude_set = set(exclude_accounts.split(","))
        all_data = [e for e in all_data if e["sid"] not in exclude_set]
    return all_data


# ── Page Routes ──────────────────────────────────────────────


@app.route("/")
def index():
    return render_template("dashboard.html")


@app.route("/dashboard")
def dashboard_page():
    return render_template("dashboard.html")


@app.route("/subaccounts")
def subaccounts_page():
    return render_template("subaccounts.html")


@app.route("/subaccounts/<sid>")
def subaccount_detail_page(sid):
    return render_template("subaccount_detail.html", account_sid=sid)


@app.route("/templates")
def templates_page():
    return render_template("templates.html")


@app.route("/billing")
def billing_page():
    return render_template("billing.html")


# ── API Routes ───────────────────────────────────────────────


@app.route("/api/dashboard")
def api_dashboard():
    try:
        date_from, date_to = parse_date_params()
        direction_filter = request.args.get("direction", "")
        status_values = parse_status_filter()
        account_filter = request.args.get("account_sid", "").strip()
        exclude_accounts = request.args.get("exclude_accounts", "").strip()
        all_data, fetch_errors = get_all_subaccount_data(date_from, date_to)
        all_data = filter_data_by_accounts(all_data, account_filter, exclude_accounts)

        all_messages = []
        any_limit_reached = False
        for entry in all_data:
            all_messages.extend(entry["messages"])
            if entry.get("limit_reached"):
                any_limit_reached = True

        all_messages = apply_message_filters(all_messages, direction_filter, status_values)

        status_summary = aggregate_message_statuses(all_messages)
        daily = aggregate_by_date(all_messages)

        # Top sub-accounts by volume (apply filters to per-account data too)
        filtered_data = []
        for entry in all_data:
            msgs = apply_message_filters(entry["messages"], direction_filter, status_values)
            filtered_data.append({**entry, "messages": msgs})
        sub_summary = build_subaccount_summary(filtered_data)

        # Top templates by delivery rate
        template_map = cached_templates()
        all_template_stats = aggregate_by_template(all_messages, template_map)
        template_stats = sorted(
            [t for t in all_template_stats if t["total"] > 0],
            key=lambda t: t["delivery_rate"],
            reverse=True,
        )[:10]

        result = {
            "status_summary": status_summary,
            "daily": daily,
            "top_subaccounts": sub_summary[:10],
            "top_templates": template_stats,
            "date_from": date_from.strftime("%Y-%m-%d"),
            "date_to": date_to.strftime("%Y-%m-%d"),
            "limit_reached": any_limit_reached,
        }
        if fetch_errors:
            result["warnings"] = fetch_errors
            result["partial_data"] = True
        return jsonify(result)
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.exception("api_dashboard failed")
        return jsonify({"error": "Internal server error"}), 500


@app.route("/api/subaccounts")
def api_subaccounts():
    try:
        date_from, date_to = parse_date_params()
        direction_filter = request.args.get("direction", "")
        status_values = parse_status_filter()
        account_filter = request.args.get("account_sid", "").strip()
        exclude_accounts = request.args.get("exclude_accounts", "").strip()
        all_data, fetch_errors = get_all_subaccount_data(date_from, date_to)
        all_data = filter_data_by_accounts(all_data, account_filter, exclude_accounts)

        # Apply filters to messages within each account
        filtered_data = []
        for entry in all_data:
            msgs = apply_message_filters(entry["messages"], direction_filter, status_values)
            filtered_data.append({**entry, "messages": msgs})
        all_data = filtered_data

        summary = build_subaccount_summary(all_data)
        result = {
            "subaccounts": summary,
            "date_from": date_from.strftime("%Y-%m-%d"),
            "date_to": date_to.strftime("%Y-%m-%d"),
        }
        if fetch_errors:
            result["warnings"] = fetch_errors
            result["partial_data"] = True
        return jsonify(result)
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.exception("api_subaccounts failed")
        return jsonify({"error": "Internal server error"}), 500


@app.route("/api/subaccounts/<sid>")
def api_subaccount_detail(sid):
    try:
        sid = validate_account_sid(sid)
        date_from, date_to = parse_date_params()
        direction_filter = request.args.get("direction", "")
        status_values = parse_status_filter()
        msg_data = cached_messages(sid, date_from, date_to)
        messages = msg_data["messages"]
        limit_reached = msg_data["limit_reached"]
        usage = cached_usage(sid, date_from, date_to)

        messages = apply_message_filters(messages, direction_filter, status_values)

        status_summary = aggregate_message_statuses(messages)
        daily = aggregate_by_date(messages)

        template_map = cached_templates()
        template_stats = aggregate_by_template(messages, template_map)

        # Find account name
        subaccounts = cached_subaccounts()
        account_name = sid
        if sid == config.TWILIO_ACCOUNT_SID:
            account_name = "Main Account"
        else:
            for a in subaccounts:
                if a["sid"] == sid:
                    account_name = a["friendly_name"]
                    break

        return jsonify(
            {
                "account_sid": sid,
                "account_name": account_name,
                "status_summary": status_summary,
                "daily": daily,
                "templates": template_stats,
                "usage": usage,
                "date_from": date_from.strftime("%Y-%m-%d"),
                "date_to": date_to.strftime("%Y-%m-%d"),
                "limit_reached": limit_reached,
            }
        )
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.exception("api_subaccount_detail failed for sid=%s", sid)
        return jsonify({"error": "Internal server error"}), 500


@app.route("/api/templates")
def api_templates():
    try:
        date_from, date_to = parse_date_params()
        account_filter = request.args.get("account_sid", "").strip()
        exclude_accounts = request.args.get("exclude_accounts", "").strip()
        direction_filter = request.args.get("direction", "")
        status_values = parse_status_filter()

        all_data, fetch_errors = get_all_subaccount_data(date_from, date_to)
        all_data = filter_data_by_accounts(all_data, account_filter, exclude_accounts)
        all_messages = []
        for entry in all_data:
            # Tag each message with its account info for per-template tracking
            for m in entry["messages"]:
                m["_account_name"] = entry["friendly_name"]
            all_messages.extend(entry["messages"])

        all_messages = apply_message_filters(all_messages, direction_filter, status_values)

        template_map = cached_templates()
        include_unused = request.args.get("include_unused", "0") == "1"
        template_stats = aggregate_by_template(all_messages, template_map, include_unused=include_unused)

        # Count messages with/without content_sid for diagnostics
        with_sid = sum(1 for m in all_messages if m.get("content_sid"))
        outbound_count = sum(1 for m in all_messages if m.get("direction", "").startswith("outbound"))

        account_list = get_account_list()

        result = {
            "templates": template_stats,
            "subaccounts": account_list,
            "total_filtered": len(all_messages),
            "date_from": date_from.strftime("%Y-%m-%d"),
            "date_to": date_to.strftime("%Y-%m-%d"),
            "debug": {
                "total_messages": len(all_messages),
                "outbound_messages": outbound_count,
                "with_content_sid": with_sid,
                "template_map_size": len(template_map),
            },
        }
        if fetch_errors:
            result["warnings"] = fetch_errors
            result["partial_data"] = True
        return jsonify(result)
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.exception("api_templates failed")
        return jsonify({"error": "Internal server error"}), 500


@app.route("/api/billing")
def api_billing():
    try:
        date_from, date_to = parse_date_params()
        account_filter = request.args.get("account_sid", "").strip()
        exclude_accounts = request.args.get("exclude_accounts", "").strip()
        all_data, fetch_errors = get_all_subaccount_data(date_from, date_to)
        all_data = filter_data_by_accounts(all_data, account_filter, exclude_accounts)

        usage_by_account = {}
        account_names = {}
        for entry in all_data:
            usage_by_account[entry["sid"]] = entry["usage"]
            account_names[entry["sid"]] = entry["friendly_name"]

        billing = aggregate_billing(usage_by_account, account_names)

        # Calculate daily average and projection
        days_in_range = (date_to - date_from).days or 1
        daily_avg = billing["total_spend"] / days_in_range

        billing["daily_average"] = round(daily_avg, 4)
        # Only project monthly spend if we have at least 3 days of data
        if days_in_range >= 3:
            billing["projected_monthly"] = round(daily_avg * 30, 2)
        else:
            billing["projected_monthly"] = None
        billing["date_from"] = date_from.strftime("%Y-%m-%d")
        billing["date_to"] = date_to.strftime("%Y-%m-%d")
        billing["daily"] = aggregate_daily_spend(all_data)

        if fetch_errors:
            billing["warnings"] = fetch_errors
            billing["partial_data"] = True
        return jsonify(billing)
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.exception("api_billing failed")
        return jsonify({"error": "Internal server error"}), 500


@app.route("/api/accounts")
def api_accounts():
    try:
        return jsonify({"accounts": get_account_list(), "main_sid": config.TWILIO_ACCOUNT_SID})
    except Exception as e:
        logger.exception("api_accounts failed")
        return jsonify({"error": "Internal server error"}), 500


@app.route("/api/cache/clear", methods=["POST"])
def api_clear_cache():
    cache.clear()
    return jsonify({"status": "ok", "message": "Cache cleared"})


@app.route("/healthz")
def healthz():
    """Lightweight health check — no Twilio API calls."""
    return "ok", 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=config.FLASK_DEBUG)
