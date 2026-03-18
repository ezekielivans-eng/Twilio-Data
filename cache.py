import time


class TTLCache:
    def __init__(self, ttl_seconds=300):
        self._store = {}
        self._ttl = ttl_seconds

    def get(self, key):
        if key in self._store:
            value, timestamp = self._store[key]
            if time.time() - timestamp < self._ttl:
                return value
            del self._store[key]
        return None

    def set(self, key, value):
        self._store[key] = (value, time.time())

    def clear(self):
        self._store.clear()
