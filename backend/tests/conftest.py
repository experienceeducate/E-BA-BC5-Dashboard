"""
Shared fixtures for the backend test suite.

Import order matters: app/auth.py and app/main.py read required env vars and
raise RuntimeError at import time if they're missing (JWT_SECRET,
DASHBOARD_PASSWORD, EBA_ID_SALT). We also neutralise the `load_dotenv(override=True)`
call so a developer's local backend/.env (real secrets, real BigQuery config)
can never leak into the test process. Both must happen BEFORE the first
`import app.main`.
"""

import os

# ─── Deterministic test env — set before any app import ───────────────────────

os.environ["JWT_SECRET"] = "test-jwt-secret-not-a-real-secret"
os.environ["DASHBOARD_PASSWORD"] = "test-dashboard-password"
os.environ["EBA_ID_SALT"] = "test-eba-id-salt-0123456789abcdef"
os.environ["EBA_CLIENT_TOKEN"] = "eba-dashboard-v1"
os.environ.setdefault("BQ_PROJECT_ID", "test-project")
os.environ.setdefault("BQ_DATASET", "test_dataset")
os.environ.setdefault("BQ_TABLE", "test_table")
# Leave GOOGLE_SERVICE_ACCOUNT_KEY / OAuth client id+secret unset: no test here
# should ever construct a real bigquery.Client or hit real Google OAuth — every
# BigQuery call goes through the mock_run_query fixture, and OAuth exchange is
# mocked directly on `oauth.google`.

import dotenv  # noqa: E402

dotenv.load_dotenv = lambda *a, **k: False  # neutralise before app import

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app.auth as auth_module  # noqa: E402
import app.core.cache as cache_module  # noqa: E402
import app.core.database as database_module  # noqa: E402
import app.main as main_module  # noqa: E402

CLIENT_HEADER = {"X-EBA-Client": os.environ["EBA_CLIENT_TOKEN"]}


# ─── Isolation ──────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clear_module_state():
    """The query cache is a module-level TTLCache shared across the whole
    process — clear it before AND after every test so results from one test
    never leak into the next."""
    cache_module._cache.clear()
    yield
    cache_module._cache.clear()


@pytest.fixture(autouse=True)
def _clear_dependency_overrides():
    yield
    main_module.app.dependency_overrides.clear()


# ─── Users / auth ───────────────────────────────────────────────────────────────


@pytest.fixture
def staff_user():
    return auth_module.User(role="staff", email="staff@experienceeducate.org")


@pytest.fixture
def guest_user():
    return auth_module.User(role="guest", email=None)


@pytest.fixture
def override_auth():
    """override_auth(user) swaps the current_user dependency for the given User
    for the rest of the test. Cleared automatically afterwards."""

    def _override(user):
        main_module.app.dependency_overrides[auth_module.current_user] = lambda: user

    return _override


@pytest.fixture
def make_token():
    """make_token(payload, secret=None, algorithm=None) -> raw JWT string.
    Bypasses create_jwt for security tests that need deliberately malformed/
    expired/mis-signed tokens."""
    from jose import jwt as jose_jwt

    def _make(payload, secret=None, algorithm=None):
        secret = auth_module.JWT_SECRET if secret is None else secret
        algorithm = algorithm or auth_module.JWT_ALGORITHM
        return jose_jwt.encode(payload, secret, algorithm=algorithm)

    return _make


# ─── HTTP clients ───────────────────────────────────────────────────────────────


@pytest.fixture
def client():
    """Bare TestClient with the required X-EBA-Client header pre-set.
    No auth override — endpoints still need a real/overridden JWT."""
    with TestClient(main_module.app) as c:
        c.headers.update(CLIENT_HEADER)
        yield c


@pytest.fixture
def client_no_header():
    """TestClient WITHOUT the client header, for asserting the 403 guard."""
    with TestClient(main_module.app) as c:
        yield c


@pytest.fixture
def as_staff(client, override_auth, staff_user):
    """TestClient with the header set AND current_user overridden to staff."""
    override_auth(staff_user)
    return client


@pytest.fixture
def as_guest(client, override_auth, guest_user):
    """TestClient with the header set AND current_user overridden to guest."""
    override_auth(guest_user)
    return client


# ─── BigQuery mock seam ─────────────────────────────────────────────────────────


class _RunQueryRecorder:
    """Records every call to database.run_query and returns configurable rows.

    Usage:
        mock_run_query.set_rows([{"a": 1}])           # every call returns this
        mock_run_query.set_side_effect(lambda sql, params, role: [...])
        mock_run_query.calls -> [{"sql": ..., "params": [...], "role": ...}, ...]
    """

    def __init__(self):
        self.calls: list[dict] = []
        self._rows: list[dict] = []
        self._side_effect = None

    def set_rows(self, rows):
        self._rows = rows

    def set_side_effect(self, fn):
        self._side_effect = fn

    def __call__(self, sql, params=None, role="none"):
        params = params or []
        self.calls.append({"sql": sql, "params": params, "role": role})
        if self._side_effect is not None:
            return self._side_effect(sql, params, role)
        return self._rows


@pytest.fixture
def mock_run_query(monkeypatch):
    recorder = _RunQueryRecorder()
    monkeypatch.setattr(database_module, "run_query", recorder)
    return recorder
