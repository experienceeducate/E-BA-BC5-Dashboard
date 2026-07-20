"""
BigQuery client + the shared query runner.

`run_query` is the seam the test suite mocks (`tests/conftest.py`'s
`mock_run_query` fixture does `monkeypatch.setattr(database, "run_query", ...)`
against this module). Routers must call it as `database.run_query(...)`
through the module object — never `from app.core.database import run_query`,
which would bind a copy that the monkeypatch can't reach.
"""

from datetime import date, datetime

from fastapi import HTTPException
from google.api_core.exceptions import NotFound
from google.cloud import bigquery
from google.oauth2 import service_account
import json

from app.core.cache import cache_key, cached_query
from app.core.config import settings

PROJECT_ID = settings.BQ_PROJECT_ID
DATASET    = settings.BQ_DATASET
TABLE      = settings.BQ_TABLE
SA_KEY     = settings.GOOGLE_SERVICE_ACCOUNT_KEY


def get_bq_client() -> bigquery.Client:
    if SA_KEY:
        try:
            key_data = json.loads(SA_KEY)
            credentials = service_account.Credentials.from_service_account_info(
                key_data,
                scopes=["https://www.googleapis.com/auth/bigquery"]
            )
        except json.JSONDecodeError:
            credentials = service_account.Credentials.from_service_account_file(
                SA_KEY,
                scopes=["https://www.googleapis.com/auth/bigquery"]
            )
        return bigquery.Client(credentials=credentials, project=PROJECT_ID)
    else:
        return bigquery.Client(project=PROJECT_ID)


def _param_to_key(p) -> tuple:
    """Stable cache-key fragment for a BigQuery query parameter."""
    if isinstance(p, bigquery.ArrayQueryParameter):
        return ("array", p.name, p.array_type, tuple(p.values or ()))
    return ("scalar", p.name, p.type_, p.value)


def run_query(sql: str, params: list | None = None, role: str = "none") -> list[dict]:
    # role is part of the cache key so role-masked responses can't be served
    # across roles. Default "none" preserves behavior for callers that don't mask.
    params = params or []
    key = cache_key(role, sql, tuple(_param_to_key(p) for p in params))
    def _run():
        client = get_bq_client()
        job_config = bigquery.QueryJobConfig(query_parameters=params) if params else None
        result = client.query(sql, job_config=job_config).result()
        rows = []
        for row in result:
            r = dict(row)
            for k, v in r.items():
                if isinstance(v, (date, datetime)):
                    r[k] = v.isoformat()
            rows.append(r)
        return rows
    try:
        return cached_query(key, _run)
    except NotFound as exc:
        # An upstream BigQuery table/dataset doesn't exist (e.g. the BC5 feed is
        # not live yet — see docs/CONTEXT.md). Translate to a handled 503 so the
        # response flows back through CORSMiddleware and the SPA renders its
        # graceful "data unavailable" state instead of a CORS-less 500 that the
        # browser reports as "Failed to fetch". NotFound is not cached (only
        # successful results are), so it re-raises on every call until the feed lands.
        raise HTTPException(
            status_code=503,
            detail="Data source not available (upstream table not found)",
        ) from exc


# ─── SQL parameter helpers ─────────────────────────────────────────────────────
# Build clauses + parameter lists for the common filter inputs. Each helper
# returns a (clause, params) pair so callers can splice them into WHERE
# clauses without ever interpolating user input into SQL.

def _scalar(name: str, type_: str, value) -> bigquery.ScalarQueryParameter:
    return bigquery.ScalarQueryParameter(name, type_, value)


def _array(name: str, type_: str, values: list) -> bigquery.ArrayQueryParameter:
    return bigquery.ArrayQueryParameter(name, type_, values)
