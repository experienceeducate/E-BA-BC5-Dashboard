"""
Centralized environment configuration.

This module must be the first thing that reads env vars: it calls
`dotenv.load_dotenv()` via the `dotenv` module attribute (not a bound `from
dotenv import load_dotenv`) so tests can neutralise it by monkeypatching
`dotenv.load_dotenv` before `app.core.config` is first imported.

`Settings` fails fast on missing required vars: better a crashloop with a clear
message than a silently insecure boot. We wrap the underlying pydantic
ValidationError in RuntimeError so callers see a single, obvious exception type.
"""

import dotenv

dotenv.load_dotenv(override=True)

from pydantic import ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    # ─── Required — fail fast if missing ───────────────────────────────────
    JWT_SECRET: str
    DASHBOARD_PASSWORD: str
    EBA_ID_SALT: str  # HMAC salt for youth pseudonymisation — guard like JWT_SECRET

    # ─── Defaulted ──────────────────────────────────────────────────────────
    EBA_CLIENT_TOKEN: str = "eba-dashboard-v1"
    BQ_PROJECT_ID: str = "educate-data-warehouse-test"
    BQ_DATASET: str = "gold_eba"
    BQ_TABLE: str = "eba_recruitment_funnel"
    JWT_ALGORITHM: str = "HS256"
    TOKEN_EXPIRE_HOURS: int = 8
    FRONTEND_URL: str = "http://localhost:3000"
    OAUTH_ALLOWED_DOMAIN: str = "experienceeducate.org"

    # ─── Optional (may be unset) ────────────────────────────────────────────
    GOOGLE_SERVICE_ACCOUNT_KEY: str | None = None
    GOOGLE_OAUTH_CLIENT_ID: str | None = None
    GOOGLE_OAUTH_CLIENT_SECRET: str | None = None
    GOOGLE_OAUTH_REDIRECT_URI: str | None = None


def _load_settings() -> Settings:
    try:
        return Settings()
    except ValidationError as exc:
        missing = [
            str(err["loc"][0])
            for err in exc.errors()
            if err.get("type") == "missing"
        ]
        if missing:
            raise RuntimeError(
                f"Missing required environment variable(s): {', '.join(missing)}"
            ) from exc
        raise RuntimeError(str(exc)) from exc


settings = _load_settings()
