import time

from cache import TTLCache


def test_set_and_get():
    c = TTLCache(ttl_seconds=10)
    c.set("k", "v")
    assert c.get("k") == "v"


def test_get_missing_key():
    c = TTLCache(ttl_seconds=10)
    assert c.get("nope") is None


def test_expiry():
    c = TTLCache(ttl_seconds=0.05)
    c.set("k", 42)
    assert c.get("k") == 42
    time.sleep(0.06)
    assert c.get("k") is None


def test_clear():
    c = TTLCache(ttl_seconds=10)
    c.set("a", 1)
    c.set("b", 2)
    c.clear()
    assert c.get("a") is None
    assert c.get("b") is None


def test_overwrite():
    c = TTLCache(ttl_seconds=10)
    c.set("k", "old")
    c.set("k", "new")
    assert c.get("k") == "new"


def test_per_key_ttl():
    c = TTLCache(ttl_seconds=10)
    c.set("short", "val", ttl=0.05)
    c.set("long", "val", ttl=10)
    assert c.get("short") == "val"
    assert c.get("long") == "val"
    time.sleep(0.06)
    assert c.get("short") is None  # expired by custom TTL
    assert c.get("long") == "val"  # still alive
