"""
Proactive query-cache warm-up.

The heaviest dashboard endpoints (mobilisation-heatmap, call-centre-insights)
each make 6-10 sequential BigQuery calls per request — fine once cached, but a
20-30s wait on a cold cache. Rather than wait for a user to pay that cost,
this re-runs those endpoints' default (no-filter) view on a timer, so the
cache (see core/cache.py) is refreshed before it would naturally expire.

One asyncio task in the one uvicorn process — consistent with the
single-process invariant in core/cache.py's docstring; this is not a second
writer, just a scheduled caller of the same `database.run_query` seam every
real request goes through.

Only the unfiltered view is warmed (the one most users land on first); a
request with district/gender/cohort filters still falls back to normal
on-demand caching.
"""

import asyncio
import logging

from app.auth import User

logger = logging.getLogger("app.warmup")

WARM_INTERVAL_SECONDS = 15 * 60


def _warm_targets():
    # Imported lazily (not at module load time) to avoid a circular import —
    # app.routers.recruitment doesn't import this module, but app.main wires
    # both up and we want warmup.py importable standalone regardless of order.
    from app.routers.recruitment import call_centre_insights, mobilisation, mobilisation_heatmap
    # cohort=["BOOTCAMP_5"], NOT []: the frontend's actual default filter
    # state is `cohort: "BOOTCAMP_5"` (see App.jsx's useState default), not
    # "all cohorts" — confirmed live 2026-08-05 that warming with `cohort=[]`
    # silently cached the WRONG variant, a different query/cache-key than what
    # any real page load sends, so the real default request still missed and
    # paid the full cold-query cost. Now that ACTIVE_COHORTS is BOOTCAMP_5-only
    # (BC4 dropped 2026-08-08, see tables.py), cohort=[] would actually resolve
    # to the same thing — kept explicit anyway so this doesn't silently regress
    # if ACTIVE_COHORTS ever changes again.
    return [
        (mobilisation, {"district": [], "gender": None, "cohort": ["BOOTCAMP_5"]}),
        (mobilisation_heatmap, {"district": [], "cohort": ["BOOTCAMP_5"]}),
        (call_centre_insights, {}),
    ]


def warm_once():
    """Run every warm target once, for every role — PII masking differs by
    role (see core/pii.py), so a guest-cached response can't stand in for
    staff. Each call is isolated: one failing query (e.g. a transient
    BigQuery hiccup) must not stop the rest from warming."""
    for role in ("guest", "staff"):
        user = User(role=role)
        for fn, kwargs in _warm_targets():
            try:
                fn(user=user, **kwargs)
            except Exception:
                logger.exception("Cache warm-up failed: %s (role=%s)", fn.__name__, role)


async def warm_loop():
    """Warms immediately on startup, then every WARM_INTERVAL_SECONDS after —
    run as a background asyncio task from app.main's lifespan. `run_query`
    itself is a blocking BigQuery call, so each pass runs in a worker thread
    (asyncio.to_thread) rather than blocking the event loop."""
    while True:
        try:
            await asyncio.to_thread(warm_once)
        except Exception:
            logger.exception("Cache warm-up loop iteration failed")
        await asyncio.sleep(WARM_INTERVAL_SECONDS)
