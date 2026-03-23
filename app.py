from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

from flask import Flask, jsonify, render_template, request

import config
from cache import TTLCache
from data_aggregator import (
    aggregate_billing,
    aggregate_by_date,
    aggregate_by_template,
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

cache = TTLCache(ttl_seconds=config.CACHE_TTL_SECONDS)


def parse_date_params():
    date_to = request.args.get("date_to")
    date_from = request.args.get("date_from")
    if date_to:
        date_to = datetime.strptime(date_to, "%Y-%m-%d")
    else:
        date_to = datetime.utcnow()
    if date_from:
        date_from = datetime.strptime(date_from, "%Y-%m-%d")
    else:
        date_from = date_to - timedelta(days=config.DATE_RANGE_DAYS)
    return date_from, date_to


def cached_subaccounts():
    key = "subaccounts"
    data = cache.get(key)
    if data is None:
        data = get_subaccounts()
        cache.set(key, data)
    return data


def cached_messages(account_sid, date_from, date_to):
    key = f"messages:{account_sid}:{date_from}:{date_to}"
    data = cache.get(key)
    if data is None:
        data = get_messages(account_sid, date_from, date_to)
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
        cache.set(key, data)
    return data


def get_all_subaccount_data(date_from, date_to):
    subaccounts = cached_subaccounts()
    # Always include the main account too
    all_accounts = [
        {"sid": config.TWILIO_ACCOUNT_SID, "friendly_name": "Main Account"}
    ] + subaccounts

    def fetch_one(acct):
        sid = acct["sid"]
        messages = cached_messages(sid, date_from, date_to)
        usage = cached_usage(sid, date_from, date_to)
        return {
            "sid": sid,
            "friendly_name": acct["friendly_name"],
            "messages": messages,
            "usage": usage,
        }

    results = []
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {executor.submit(fetch_one, acct): acct for acct in all_accounts}
        for future in as_completed(futures):
            try:
                results.append(future.result())
            except Exception:
                acct = futures[future]
                results.append(
                    {
                        "sid": acct["sid"],
                        "friendly_name": acct["friendly_name"],
                        "messages": [],
                        "usage": [],
                    }
                )
    return results


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
        all_data = get_all_subaccount_data(date_from, date_to)

        all_messages = []
        for entry in all_data:
            all_messages.extend(entry["messages"])

        status_summary = aggregate_message_statuses(all_messages)
        daily = aggregate_by_date(all_messages)

        # Top sub-accounts by volume
        sub_summary = build_subaccount_summary(all_data)

        # Top templates
        template_map = cached_templates()
        template_stats = aggregate_by_template(all_messages, template_map)[:10]

        return jsonify(
            {
                "status_summary": status_summary,
                "daily": daily,
                "top_subaccounts": sub_summary[:10],
                "top_templates": template_stats,
                "date_from": date_from.strftime("%Y-%m-%d"),
                "date_to": date_to.strftime("%Y-%m-%d"),
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/subaccounts")
def api_subaccounts():
    try:
        date_from, date_to = parse_date_params()
        all_data = get_all_subaccount_data(date_from, date_to)
        summary = build_subaccount_summary(all_data)
        return jsonify(
            {
                "subaccounts": summary,
                "date_from": date_from.strftime("%Y-%m-%d"),
                "date_to": date_to.strftime("%Y-%m-%d"),
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/subaccounts/<sid>")
def api_subaccount_detail(sid):
    try:
        date_from, date_to = parse_date_params()
        messages = cached_messages(sid, date_from, date_to)
        usage = cached_usage(sid, date_from, date_to)

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
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/templates")
def api_templates():
    try:
        date_from, date_to = parse_date_params()
        account_filter = request.args.get("account_sid")

        if account_filter:
            all_messages = cached_messages(account_filter, date_from, date_to)
        else:
            all_data = get_all_subaccount_data(date_from, date_to)
            all_messages = []
            for entry in all_data:
                all_messages.extend(entry["messages"])

        template_map = cached_templates()
        template_stats = aggregate_by_template(all_messages, template_map)

        # Also return list of sub-accounts for the filter dropdown
        subaccounts = cached_subaccounts()
        account_list = [
            {"sid": config.TWILIO_ACCOUNT_SID, "friendly_name": "Main Account"}
        ] + [{"sid": a["sid"], "friendly_name": a["friendly_name"]} for a in subaccounts]

        return jsonify(
            {
                "templates": template_stats,
                "subaccounts": account_list,
                "date_from": date_from.strftime("%Y-%m-%d"),
                "date_to": date_to.strftime("%Y-%m-%d"),
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/billing")
def api_billing():
    try:
        date_from, date_to = parse_date_params()
        all_data = get_all_subaccount_data(date_from, date_to)

        usage_by_account = {}
        account_names = {}
        for entry in all_data:
            usage_by_account[entry["sid"]] = entry["usage"]
            account_names[entry["sid"]] = entry["friendly_name"]

        billing = aggregate_billing(usage_by_account, account_names)

        # Calculate daily average and projection
        days_in_range = (date_to - date_from).days or 1
        daily_avg = billing["total_spend"] / days_in_range
        projected_monthly = daily_avg * 30

        billing["daily_average"] = round(daily_avg, 4)
        billing["projected_monthly"] = round(projected_monthly, 2)
        billing["date_from"] = date_from.strftime("%Y-%m-%d")
        billing["date_to"] = date_to.strftime("%Y-%m-%d")

        return jsonify(billing)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/cache/clear", methods=["POST"])
def api_clear_cache():
    cache.clear()
    return jsonify({"status": "ok", "message": "Cache cleared"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=config.FLASK_DEBUG)
