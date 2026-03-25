from collections import defaultdict
from datetime import datetime


def aggregate_message_statuses(messages):
    counts = defaultdict(int)
    for m in messages:
        counts[m["status"]] += 1
    total = len(messages)
    delivered = counts.get("delivered", 0)
    read = counts.get("read", 0)
    failed = counts.get("failed", 0)
    undelivered = counts.get("undelivered", 0)
    errors = failed + undelivered

    return {
        "queued": counts.get("queued", 0),
        "sending": counts.get("sending", 0),
        "sent": counts.get("sent", 0),
        "delivered": delivered,
        "read": read,
        "undelivered": undelivered,
        "failed": failed,
        "total": total,
        "delivery_rate": round((delivered + read) / total * 100, 2) if total else 0,
        "read_rate": round(read / total * 100, 2) if total else 0,
        "error_rate": round(errors / total * 100, 2) if total else 0,
    }


def aggregate_by_date(messages):
    daily = defaultdict(lambda: defaultdict(int))
    for m in messages:
        date_str = m.get("date_sent") or m.get("date_created") or ""
        if date_str:
            try:
                day = datetime.fromisoformat(date_str.replace("+00:00", "")).strftime(
                    "%Y-%m-%d"
                )
            except (ValueError, AttributeError):
                day = date_str[:10]
        else:
            continue
        daily[day][m["status"]] += 1
        daily[day]["total"] += 1

    sorted_days = sorted(daily.keys())
    return {
        "dates": sorted_days,
        "series": {
            status: [daily[d].get(status, 0) for d in sorted_days]
            for status in ["sent", "delivered", "read", "failed", "undelivered"]
        },
        "totals": [daily[d].get("total", 0) for d in sorted_days],
    }


_MIN_BODY_TEMPLATE_MESSAGES = 10  # filter out low-volume body-hash noise


def aggregate_by_template(messages, template_map=None, include_unused=False):
    if template_map is None:
        template_map = {}

    # Build reverse lookup: body prefix → content SID
    body_prefix_to_sid = {}
    for sid, info in template_map.items():
        body = (info.get("body") or "").strip()
        if body:
            body_prefix_to_sid[body[:500]] = sid

    def _account_names(msgs):
        """Collect unique account names from messages (if tagged)."""
        names = sorted({m["_account_name"] for m in msgs if m.get("_account_name")})
        return ", ".join(names) if names else ""

    groups = defaultdict(list)
    body_groups = defaultdict(list)

    for m in messages:
        content_sid = m.get("content_sid")
        if content_sid and content_sid in template_map:
            groups[content_sid].append(m)
        elif m.get("direction") == "outbound-api" and m.get("body"):
            body_key = m["body"].strip()
            if not body_key:
                continue
            # Try to match against a known template body before falling back to hash
            matched_sid = body_prefix_to_sid.get(body_key[:500])
            if matched_sid:
                groups[matched_sid].append(m)
            else:
                body_groups[body_key].append(m)

    results = []

    # Process content_sid-based templates
    for key, msgs in groups.items():
        stats = aggregate_message_statuses(msgs)
        template_info = template_map.get(key, {})
        name = template_info.get("friendly_name", key)
        body = template_info.get("body", "")
        template_type = template_info.get("template_type", "unknown")

        results.append(
            {
                "template_id": key,
                "template_name": name,
                "body": body,
                "template_type": template_type,
                "accounts": _account_names(msgs),
                "total": stats["total"],
                "delivered": stats["delivered"],
                "read": stats["read"],
                "failed": stats["failed"],
                "undelivered": stats["undelivered"],
                "delivery_rate": stats["delivery_rate"],
                "read_rate": stats["read_rate"],
                "error_rate": stats["error_rate"],
            }
        )

    # Process body-text-based groups (messages sent without content_sid)
    # Skip low-volume entries — they are noise, not meaningful templates.
    for body_text, msgs in body_groups.items():
        if len(msgs) < _MIN_BODY_TEMPLATE_MESSAGES:
            continue
        stats = aggregate_message_statuses(msgs)
        # Use truncated body as name
        display_name = body_text[:50] + ("..." if len(body_text) > 50 else "")

        results.append(
            {
                "template_id": f"body:{hash(body_text) & 0xFFFFFFFF:08x}",
                "template_name": display_name,
                "body": body_text,
                "template_type": "text (no content_sid)",
                "accounts": _account_names(msgs),
                "total": stats["total"],
                "delivered": stats["delivered"],
                "read": stats["read"],
                "failed": stats["failed"],
                "undelivered": stats["undelivered"],
                "delivery_rate": stats["delivery_rate"],
                "read_rate": stats["read_rate"],
                "error_rate": stats["error_rate"],
            }
        )

    # Optionally include all known templates with 0 messages
    if include_unused and template_map:
        used_sids = {r["template_id"] for r in results}
        for sid, info in template_map.items():
            if sid not in used_sids:
                results.append(
                    {
                        "template_id": sid,
                        "template_name": info.get("friendly_name", sid),
                        "body": info.get("body", ""),
                        "template_type": info.get("template_type", "unknown"),
                        "accounts": "",
                        "total": 0,
                        "delivered": 0,
                        "read": 0,
                        "failed": 0,
                        "undelivered": 0,
                        "delivery_rate": 0,
                        "read_rate": 0,
                        "error_rate": 0,
                    }
                )

    results.sort(key=lambda x: x["total"], reverse=True)
    return results


def aggregate_daily_spend(all_data):
    """Compute approximate daily spend from per-message price fields."""
    daily = defaultdict(float)
    for entry in all_data:
        for m in entry.get("messages", []):
            date_str = m.get("date_sent") or m.get("date_created") or ""
            if not date_str:
                continue
            day = date_str[:10]
            price = m.get("price")
            if price is not None:
                try:
                    daily[day] += abs(float(price))
                except (ValueError, TypeError):
                    pass
    return [{"date": d, "spend": round(daily[d], 4)} for d in sorted(daily.keys())]


def aggregate_billing(usage_records_by_account, account_names=None):
    if account_names is None:
        account_names = {}

    per_account = []
    total_spend = 0.0

    for account_sid, records in usage_records_by_account.items():
        account_total = sum(r["price"] for r in records)
        total_spend += account_total
        per_account.append(
            {
                "account_sid": account_sid,
                "account_name": account_names.get(account_sid, account_sid),
                "total_spend": round(account_total, 4),
                "categories": _group_by_category(records),
            }
        )

    per_account.sort(key=lambda x: x["total_spend"], reverse=True)
    return {
        "total_spend": round(total_spend, 4),
        "per_account": per_account,
    }


def _group_by_category(records):
    cats = defaultdict(float)
    for r in records:
        cats[r["category"]] += r["price"]
    return {k: round(v, 4) for k, v in sorted(cats.items(), key=lambda x: -x[1])}


def build_subaccount_summary(subaccounts_data):
    summary = []
    for entry in subaccounts_data:
        stats = aggregate_message_statuses(entry["messages"])
        spend = sum(r["price"] for r in entry.get("usage", []))
        summary.append(
            {
                "sid": entry["sid"],
                "friendly_name": entry["friendly_name"],
                "total_messages": stats["total"],
                "delivered": stats["delivered"],
                "read": stats["read"],
                "failed": stats["failed"],
                "undelivered": stats["undelivered"],
                "delivery_rate": stats["delivery_rate"],
                "read_rate": stats["read_rate"],
                "error_rate": stats["error_rate"],
                "spend": round(spend, 4),
                "limit_reached": entry.get("limit_reached", False),
            }
        )
    summary.sort(key=lambda x: x["total_messages"], reverse=True)
    return summary


def aggregate_errors(messages):
    """Group failed/undelivered messages by error_code."""
    error_msgs = [m for m in messages if m.get("status") in ("failed", "undelivered")]
    failed_count = sum(1 for m in error_msgs if m["status"] == "failed")
    undelivered_count = sum(1 for m in error_msgs if m["status"] == "undelivered")

    by_code = defaultdict(list)
    for m in error_msgs:
        code = m.get("error_code") or "unknown"
        by_code[code].append(m)

    total = len(error_msgs)
    results = []
    for code, msgs in by_code.items():
        count = len(msgs)
        results.append({
            "error_code": code,
            "count": count,
            "pct": round(count / total * 100, 1) if total else 0,
            "statuses": {
                "failed": sum(1 for m in msgs if m["status"] == "failed"),
                "undelivered": sum(1 for m in msgs if m["status"] == "undelivered"),
            },
        })

    results.sort(key=lambda x: x["count"], reverse=True)
    return {
        "errors": results,
        "summary": {
            "total": total,
            "failed": failed_count,
            "undelivered": undelivered_count,
        },
    }
