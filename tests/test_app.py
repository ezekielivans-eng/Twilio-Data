import json
from unittest.mock import patch

import pytest

flask = pytest.importorskip("flask", reason="Flask not installed")


@pytest.fixture()
def client():
    from app import app
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


# ── Date validation ──────────────────────────────────────────


def test_invalid_date_from(client):
    resp = client.get("/api/dashboard?date_from=bad-date")
    assert resp.status_code == 400
    data = json.loads(resp.data)
    assert "date_from" in data["error"].lower() or "Invalid" in data["error"]


def test_invalid_date_to(client):
    resp = client.get("/api/dashboard?date_to=nope")
    assert resp.status_code == 400


def test_reversed_date_range(client):
    resp = client.get("/api/dashboard?date_from=2024-12-31&date_to=2024-01-01")
    assert resp.status_code == 400
    data = json.loads(resp.data)
    assert "after" in data["error"].lower() or "must not" in data["error"].lower()


# ── SID validation ───────────────────────────────────────────


def test_invalid_sid_in_detail(client):
    resp = client.get("/api/subaccounts/not-a-sid")
    assert resp.status_code == 400
    data = json.loads(resp.data)
    assert "SID" in data["error"] or "Invalid" in data["error"]


# ── Page routes ──────────────────────────────────────────────


def test_index_page(client):
    resp = client.get("/")
    assert resp.status_code == 200


def test_dashboard_page(client):
    resp = client.get("/dashboard")
    assert resp.status_code == 200


def test_subaccounts_page(client):
    resp = client.get("/subaccounts")
    assert resp.status_code == 200


def test_templates_page(client):
    resp = client.get("/templates")
    assert resp.status_code == 200


def test_billing_page(client):
    resp = client.get("/billing")
    assert resp.status_code == 200


def test_errors_page(client):
    resp = client.get("/errors")
    assert resp.status_code == 200


def test_subaccount_detail_page(client):
    resp = client.get("/subaccounts/ACaaaabbbbccccdddd00001111222233334444")
    assert resp.status_code == 200


# ── Cache clear / stats ──────────────────────────────────────


def test_cache_clear(client):
    resp = client.post("/api/cache/clear")
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data["status"] == "ok"


def test_cache_stats(client):
    resp = client.get("/api/cache/stats")
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert "hits" in data
    assert "misses" in data
    assert "hit_rate" in data


# ── Health check ─────────────────────────────────────────────


def test_healthz(client):
    resp = client.get("/healthz")
    assert resp.status_code == 200


def test_healthz_detail(client):
    resp = client.get("/healthz?detail=1")
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert data["status"] == "ok"
    assert "cache_size" in data
    assert "cache_hit_rate" in data


# ── API: accounts ────────────────────────────────────────────


def test_api_accounts(client):
    with patch("app.get_subaccounts", return_value=[]):
        resp = client.get("/api/accounts")
    assert resp.status_code == 200
    data = json.loads(resp.data)
    assert "accounts" in data
    assert "main_sid" in data
    assert isinstance(data["accounts"], list)


# ── API: errors validation ───────────────────────────────────


def test_api_errors_invalid_date(client):
    resp = client.get("/api/errors?date_from=not-a-date")
    assert resp.status_code == 400
    data = json.loads(resp.data)
    assert "error" in data
