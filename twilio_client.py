import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

from twilio.rest import Client
from twilio.base.exceptions import TwilioRestException
from twilio.http.http_client import TwilioHttpClient
import config

logger = logging.getLogger(__name__)

TWILIO_TIMEOUT = 30  # seconds


def get_client():
    http_client = TwilioHttpClient(max_retries=0, timeout=TWILIO_TIMEOUT)
    return Client(
        config.TWILIO_ACCOUNT_SID,
        config.TWILIO_AUTH_TOKEN,
        http_client=http_client,
    )


def get_subaccount_client(subaccount_sid):
    http_client = TwilioHttpClient(max_retries=0, timeout=TWILIO_TIMEOUT)
    return Client(
        config.TWILIO_ACCOUNT_SID,
        config.TWILIO_AUTH_TOKEN,
        account_sid=subaccount_sid,
        http_client=http_client,
    )


def get_subaccounts():
    try:
        client = get_client()
        accounts = client.api.accounts.list(status="active")
        return [
            {
                "sid": a.sid,
                "friendly_name": a.friendly_name,
                "status": a.status,
                "date_created": str(a.date_created),
            }
            for a in accounts
        ]
    except Exception as e:
        logger.error("Failed to fetch subaccounts: %s", e)
        return []


def get_messages(account_sid, date_from, date_to, limit=1000):
    try:
        client = get_subaccount_client(account_sid)
        messages = client.messages.list(
            date_sent_after=date_from,
            date_sent_before=date_to,
            limit=limit,
        )
    except Exception as e:
        logger.error("Failed to fetch messages for %s: %s", account_sid, e)
        return {"messages": [], "limit_reached": False}
    whatsapp_messages = []
    for m in messages:
        is_whatsapp = (m.from_ and m.from_.startswith("whatsapp:")) or (
            m.to and m.to.startswith("whatsapp:")
        )
        if is_whatsapp:
            whatsapp_messages.append(
                {
                    "status": m.status,
                    "date_sent": str(m.date_sent) if m.date_sent else None,
                    "date_created": str(m.date_created),
                    "direction": m.direction,
                    "body": (m.body or "")[:100],
                    "error_code": m.error_code,
                    "price": m.price,
                    "content_sid": getattr(m, "content_sid", None),
                }
            )
    return {"messages": whatsapp_messages, "limit_reached": len(messages) >= limit}


def _extract_template_body(content_obj):
    """Extract body text and type from a Twilio Content template object."""
    types = getattr(content_obj, "types", None) or {}
    if isinstance(types, str):
        return "", "unknown"
    body_parts = []
    template_type = "unknown"
    for type_key, type_val in types.items():
        template_type = type_key.replace("twilio/", "")
        if isinstance(type_val, dict):
            # Direct body field
            if type_val.get("body"):
                body_parts.append(type_val["body"])
            # Card title + body
            if type_val.get("title"):
                body_parts.append(type_val["title"])
            # Subtitle for cards
            if type_val.get("subtitle"):
                body_parts.append(type_val["subtitle"])
            # List picker body + items
            if type_val.get("items"):
                for item in type_val["items"]:
                    if isinstance(item, dict) and item.get("item"):
                        body_parts.append(item["item"])
    return "\n".join(body_parts) if body_parts else "", template_type


def _fetch_templates_for_client(client):
    """Fetch content templates using a given Twilio client."""
    result = {}
    try:
        contents = client.content.v1.contents.list(limit=200)
        for c in contents:
            body, template_type = _extract_template_body(c)
            result[c.sid] = {
                "sid": c.sid,
                "friendly_name": c.friendly_name,
                "language": getattr(c, "language", "unknown"),
                "body": body,
                "template_type": template_type,
            }
    except Exception as e:
        logger.debug("Failed to fetch templates: %s", e)
    return result


def get_content_templates(account_sid=None):
    """Fetch content templates from the main account and all sub-accounts in parallel."""
    result = {}
    # Main account templates
    result.update(_fetch_templates_for_client(get_client()))

    # Sub-account templates fetched in parallel
    try:
        subaccounts = get_subaccounts()

        def fetch_sub_templates(acct):
            sub_client = get_subaccount_client(acct["sid"])
            return _fetch_templates_for_client(sub_client)

        with ThreadPoolExecutor(max_workers=5) as executor:
            futures = {
                executor.submit(fetch_sub_templates, acct): acct
                for acct in subaccounts
            }
            for future in as_completed(futures, timeout=60):
                try:
                    result.update(future.result(timeout=30))
                except Exception as e:
                    acct = futures[future]
                    logger.debug(
                        "Failed templates for %s: %s", acct["sid"], e
                    )
    except Exception as e:
        logger.debug("Failed to fetch sub-account templates: %s", e)

    return result


def get_usage_records(account_sid, date_from, date_to):
    try:
        client = get_subaccount_client(account_sid)
        records = client.usage.records.list(
            start_date=date_from,
            end_date=date_to,
        )
    except Exception as e:
        logger.error("Failed to fetch usage for %s: %s", account_sid, e)
        return []
    whatsapp_records = []
    for r in records:
        category = r.category.lower() if r.category else ""
        if "whatsapp" in category or "conversations" in category:
            whatsapp_records.append(
                {
                    "category": r.category,
                    "description": r.description,
                    "count": r.count,
                    "usage": r.usage,
                    "price": float(r.price) if r.price else 0.0,
                    "price_unit": r.price_unit,
                    "start_date": str(r.start_date),
                    "end_date": str(r.end_date),
                }
            )
    return whatsapp_records
