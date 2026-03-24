import threading
import time
from collections import OrderedDict


class TTLCache:
    def __init__(self, ttl_seconds=300, max_size=200):
        self._store = OrderedDict()
        self._ttl = ttl_seconds
        self._max_size = max_size
        self._lock = threading.Lock()
        self._hits = 0
        self._misses = 0

    def get(self, key):
        with self._lock:
            if key in self._store:
                value, timestamp, ttl = self._store[key]
                if time.time() - timestamp < ttl:
                    self._store.move_to_end(key)
                    self._hits += 1
                    return value
                del self._store[key]
            self._misses += 1
            return None

    def set(self, key, value, ttl=None):
        with self._lock:
            if key in self._store:
                del self._store[key]
            self._store[key] = (value, time.time(), ttl or self._ttl)
            while len(self._store) > self._max_size:
                self._store.popitem(last=False)

    def clear(self):
        with self._lock:
            self._store.clear()

    def stats(self):
        with self._lock:
            total = self._hits + self._misses
            return {
                "hits": self._hits,
                "misses": self._misses,
                "total_requests": total,
                "hit_rate": round(self._hits / total * 100, 1) if total > 0 else 0.0,
                "size": len(self._store),
                "max_size": self._max_size,
            }
