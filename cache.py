import threading
import time


class TTLCache:
    def __init__(self, ttl_seconds=300):
        self._store = {}
        self._ttl = ttl_seconds
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            if key in self._store:
                value, timestamp = self._store[key]
                if time.time() - timestamp < self._ttl:
                    return value
                del self._store[key]
            return None

    def set(self, key, value):
        with self._lock:
            self._store[key] = (value, time.time())

    def clear(self):
        with self._lock:
            self._store.clear()
