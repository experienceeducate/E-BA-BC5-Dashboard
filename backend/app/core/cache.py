"""
Process-local query cache.

A single module-global TTLCache shared by every `run_query()` call (see
`core/database.py`) and the PII reverse youth-id map lookup (`core/pii.py`).
In-memory only — correct as long as the backend runs a single uvicorn
process/replica. Do NOT add replicas or `uvicorn --workers` without first
moving this to a shared store (Redis); with multiple processes a cache hit
could land on a process that never saw the entry. See CLAUDE.md §single-process.
"""

import hashlib
import json

from cachetools import TTLCache

CACHE_TTL     = 300  # 5 minutes
CACHE_MAXSIZE = 512  # max number of cached responses
_cache: TTLCache = TTLCache(maxsize=CACHE_MAXSIZE, ttl=CACHE_TTL)


def cache_key(*args, **kwargs) -> str:
    """Generate a cache key from positional and keyword arguments."""
    raw = json.dumps({"args": args, "kwargs": kwargs}, sort_keys=True, default=str)
    return hashlib.md5(raw.encode()).hexdigest()


def cached_query(key: str, fn):
    """Return cached result if available, otherwise run fn() and cache it."""
    if key in _cache:
        return _cache[key]
    result = fn()
    _cache[key] = result
    return result
