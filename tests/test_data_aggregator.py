from data_aggregator import (
    aggregate_billing,
    aggregate_by_date,
    aggregate_by_template,
    aggregate_errors,
    aggregate_message_statuses,
    build_subaccount_summary,
)


# ── aggregate_message_statuses ──────────────────────────────


def test_statuses_empty():
    result = aggregate_message_statuses([])
    assert result["total"] == 0
    assert result["delivery_rate"] == 0
    assert result["read_rate"] == 0
    assert result["error_rate"] == 0


def test_statuses_basic():
    msgs = [
        {"status": "delivered"},
        {"status": "delivered"},
        {"status": "read"},
        {"status": "failed"},
    ]
    result = aggregate_message_statuses(msgs)
    assert result["total"] == 4
    assert result["delivered"] == 2
    assert result["read"] == 1
    assert result["failed"] == 1
    # delivery_rate = (delivered + read) / total * 100 = 75%
    assert result["delivery_rate"] == 75.0
    assert result["read_rate"] == 25.0
    assert result["error_rate"] == 25.0


def test_statuses_all_read():
    msgs = [{"status": "read"}, {"status": "read"}]
    result = aggregate_message_statuses(msgs)
    assert result["delivery_rate"] == 100.0
    assert result["read_rate"] == 100.0
    assert result["error_rate"] == 0


# ── aggregate_by_date ────────────────────────────────────────


def test_by_date_empty():
    result = aggregate_by_date([])
    assert result["dates"] == []
    assert result["totals"] == []


def test_by_date_groups_by_day():
    msgs = [
        {"date_sent": "2024-01-15T10:00:00+00:00", "status": "delivered"},
        {"date_sent": "2024-01-15T11:00:00+00:00", "status": "read"},
        {"date_sent": "2024-01-16T09:00:00+00:00", "status": "sent"},
    ]
    result = aggregate_by_date(msgs)
    assert result["dates"] == ["2024-01-15", "2024-01-16"]
    assert result["totals"] == [2, 1]
    assert result["series"]["delivered"] == [1, 0]
    assert result["series"]["sent"] == [0, 1]
    # Only delivery statuses in series
    assert "failed" not in result["series"]


def test_by_date_falls_back_to_date_created():
    msgs = [{"date_created": "2024-03-01T00:00:00+00:00", "status": "sent"}]
    result = aggregate_by_date(msgs)
    assert result["dates"] == ["2024-03-01"]


def test_by_date_skips_missing_date():
    msgs = [{"status": "sent"}]  # no date_sent or date_created
    result = aggregate_by_date(msgs)
    assert result["dates"] == []


# ── aggregate_by_template ────────────────────────────────────


def _make_msg(content_sid=None, body=None, status="delivered", direction="outbound-api", account_name=None):
    m = {"status": status, "direction": direction}
    if content_sid:
        m["content_sid"] = content_sid
    if body:
        m["body"] = body
    if account_name:
        m["_account_name"] = account_name
    return m


def test_template_by_content_sid():
    template_map = {
        "HX123": {"friendly_name": "Welcome", "body": "Hello!", "template_type": "whatsapp"},
    }
    msgs = [_make_msg(content_sid="HX123") for _ in range(5)]
    result = aggregate_by_template(msgs, template_map)
    assert len(result) == 1
    assert result[0]["template_name"] == "Welcome"
    assert result[0]["total"] == 5


def test_template_tracks_accounts():
    template_map = {
        "HX123": {"friendly_name": "Welcome", "body": "Hello!", "template_type": "whatsapp"},
    }
    msgs = [
        _make_msg(content_sid="HX123", account_name="Acct A"),
        _make_msg(content_sid="HX123", account_name="Acct B"),
        _make_msg(content_sid="HX123", account_name="Acct A"),
    ]
    result = aggregate_by_template(msgs, template_map)
    assert result[0]["accounts"] == "Acct A, Acct B"


def test_template_accounts_empty_when_untagged():
    template_map = {
        "HX123": {"friendly_name": "Welcome", "body": "Hello!", "template_type": "whatsapp"},
    }
    msgs = [_make_msg(content_sid="HX123")]
    result = aggregate_by_template(msgs, template_map)
    assert result[0]["accounts"] == ""


def test_template_body_prefix_matching():
    body = "This is a long message body that should be matched by prefix"
    template_map = {
        "HX456": {"friendly_name": "LongMsg", "body": body, "template_type": "whatsapp"},
    }
    msgs = [_make_msg(body=body) for _ in range(3)]
    result = aggregate_by_template(msgs, template_map)
    assert len(result) == 1
    assert result[0]["template_id"] == "HX456"


def test_template_body_group_below_threshold():
    """Body-text groups below _MIN_BODY_TEMPLATE_MESSAGES are excluded."""
    msgs = [_make_msg(body="rare message") for _ in range(5)]
    result = aggregate_by_template(msgs, {})
    assert len(result) == 0  # 5 < 10 threshold


def test_template_body_group_above_threshold():
    """Body-text groups at or above threshold are included."""
    msgs = [_make_msg(body="common message") for _ in range(10)]
    result = aggregate_by_template(msgs, {})
    assert len(result) == 1
    assert result[0]["template_type"] == "text (no content_sid)"


def test_template_include_unused():
    template_map = {
        "HX1": {"friendly_name": "Used", "body": "hi", "template_type": "whatsapp"},
        "HX2": {"friendly_name": "Unused", "body": "bye", "template_type": "whatsapp"},
    }
    msgs = [_make_msg(content_sid="HX1")]
    result = aggregate_by_template(msgs, template_map, include_unused=True)
    names = {r["template_name"] for r in result}
    assert "Used" in names
    assert "Unused" in names
    unused = [r for r in result if r["template_name"] == "Unused"][0]
    assert unused["total"] == 0


def test_template_empty():
    result = aggregate_by_template([], {})
    assert result == []


# ── aggregate_billing ────────────────────────────────────────


def test_billing_basic():
    records = {
        "AC1": [{"price": 1.50, "category": "sms"}, {"price": 0.50, "category": "mms"}],
        "AC2": [{"price": 3.00, "category": "sms"}],
    }
    names = {"AC1": "Account One", "AC2": "Account Two"}
    result = aggregate_billing(records, names)
    assert result["total_spend"] == 5.0
    assert len(result["per_account"]) == 2
    # Sorted by spend descending
    assert result["per_account"][0]["account_name"] == "Account Two"


def test_billing_empty():
    result = aggregate_billing({}, {})
    assert result["total_spend"] == 0
    assert result["per_account"] == []


# ── build_subaccount_summary ─────────────────────────────────


def test_subaccount_summary():
    data = [
        {
            "sid": "AC1",
            "friendly_name": "Test",
            "messages": [{"status": "delivered"}, {"status": "failed"}],
            "usage": [{"price": 1.0}],
            "limit_reached": True,
        }
    ]
    result = build_subaccount_summary(data)
    assert len(result) == 1
    assert result[0]["total_messages"] == 2
    assert result[0]["spend"] == 1.0
    assert result[0]["limit_reached"] is True


def test_subaccount_summary_empty():
    result = build_subaccount_summary([])
    assert result == []


# ── aggregate_errors ─────────────────────────────────────────


def test_errors_basic():
    msgs = [
        {"status": "failed", "error_code": 63016},
        {"status": "failed", "error_code": 63016},
        {"status": "undelivered", "error_code": 63015},
        {"status": "delivered"},  # should be ignored
    ]
    result = aggregate_errors(msgs)
    assert result["summary"]["total"] == 3
    assert result["summary"]["failed"] == 2
    assert result["summary"]["undelivered"] == 1
    assert len(result["errors"]) == 2
    # Sorted by count desc
    assert result["errors"][0]["error_code"] == 63016
    assert result["errors"][0]["count"] == 2


def test_errors_empty():
    result = aggregate_errors([])
    assert result["summary"]["total"] == 0
    assert result["errors"] == []


def test_errors_unknown_code():
    msgs = [{"status": "failed", "error_code": None}]
    result = aggregate_errors(msgs)
    assert result["errors"][0]["error_code"] == "unknown"
