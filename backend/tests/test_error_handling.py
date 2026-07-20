"""
Error-response behaviour for the two-layer failure path.

Two guarantees the SPA depends on:
1. A missing upstream BigQuery table (the BC5 feed not being live yet) surfaces
   as a handled 503 — not a raw 500 — so it flows back through CORSMiddleware.
2. Any *other* unhandled exception still returns a 500 that carries CORS headers,
   so a genuine error is readable in the browser instead of "Failed to fetch".
"""

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from google.api_core.exceptions import NotFound

import app.auth as auth_module
import app.core.database as database_module
import app.main as main_module


def test_run_query_translates_bq_notfound_to_503(monkeypatch):
    """A BigQuery NotFound becomes HTTPException(503), not a bare 500."""

    class _FakeJob:
        def result(self):
            raise NotFound("Table gold_eba.eba_recruitment_funnel was not found")

    class _FakeClient:
        def query(self, sql, job_config=None):
            return _FakeJob()

    monkeypatch.setattr(database_module, "get_bq_client", lambda: _FakeClient())

    with pytest.raises(HTTPException) as excinfo:
        database_module.run_query("SELECT 1", [], role="staff")
    assert excinfo.value.status_code == 503


def test_unhandled_500_keeps_cors_headers(override_auth, staff_user, mock_run_query):
    """A non-HTTP error still returns a 500 that echoes the allowlisted Origin,
    so the browser can read it rather than reporting a CORS 'Failed to fetch'."""

    def _boom(sql, params, role):
        raise RuntimeError("unexpected boom")

    mock_run_query.set_side_effect(_boom)
    override_auth(staff_user)

    # raise_server_exceptions=False so we inspect the 500 response the client
    # would receive, instead of the exception being re-raised into the test.
    with TestClient(main_module.app, raise_server_exceptions=False) as c:
        c.headers.update({"X-EBA-Client": "eba-dashboard-v1"})
        r = c.get("/api/filters", headers={"Origin": "http://localhost:3000"})

    assert r.status_code == 500
    assert r.headers.get("access-control-allow-origin") == "http://localhost:3000"


def test_error_cors_headers_not_echoed_for_unlisted_origin(
    override_auth, staff_user, mock_run_query
):
    """A 500 must not echo an Origin that isn't on the allowlist."""

    def _boom(sql, params, role):
        raise RuntimeError("unexpected boom")

    mock_run_query.set_side_effect(_boom)
    override_auth(staff_user)

    with TestClient(main_module.app, raise_server_exceptions=False) as c:
        c.headers.update({"X-EBA-Client": "eba-dashboard-v1"})
        r = c.get("/api/filters", headers={"Origin": "https://evil.example.com"})

    assert r.status_code == 500
    assert "access-control-allow-origin" not in {k.lower() for k in r.headers}
