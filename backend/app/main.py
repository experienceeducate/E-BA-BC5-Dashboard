"""
Take Off Dashboard Backend (Educate! E!BA Recruitment)
FastAPI + BigQuery service account auth
"""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.sessions import SessionMiddleware

from app.core.config import settings

app = FastAPI(title="Take Off Dashboard API", version="1.0.0")

# Import after settings so auth.py picks up env vars at import time.
from app.auth import router as auth_router  # noqa: E402

# ─── CORS + client-header guard ────────────────────────────────────────────────

# Browsers from any other site are blocked by CORS; non-browser callers (curl,
# scripts) bypass CORS but are blocked by the X-EBA-Client middleware below.
# Neither is true authentication — they raise the floor against casual abuse.

ALLOWED_ORIGINS = [
    "https://eba-dashboard.educateapps.work",
    "http://localhost:3000",
]
ALLOWED_CLIENT_TOKEN = settings.EBA_CLIENT_TOKEN
# Paths exempt from the client-header requirement: health/docs, plus the OAuth
# endpoints — browsers don't attach custom headers on cross-site redirects, so
# the Google callback would 403. The OAuth flow + email-domain check protect them.
CLIENT_GUARD_EXEMPT_PATHS = {
    "/health", "/docs", "/redoc", "/openapi.json",
    "/api/auth/google/login", "/api/auth/google/callback",
}

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-EBA-Client"],
)

# authlib stores OAuth state in a Starlette session between the redirect to
# Google and the callback. JWT_SECRET doubles as the session signing key.
app.add_middleware(SessionMiddleware, secret_key=settings.JWT_SECRET)


def _error_cors_headers(request: Request) -> dict:
    """CORS headers to attach to error responses that bypass CORSMiddleware.

    Unhandled exceptions become a 500 in Starlette's ServerErrorMiddleware, which
    sits OUTSIDE CORSMiddleware — so that 500 would otherwise carry no
    Access-Control-Allow-Origin header, and the browser reports it as an opaque
    "Failed to fetch" instead of a readable error. Mirror the allowlist echo
    CORSMiddleware would have done so genuine 500s stay debuggable from the SPA.
    """
    origin = request.headers.get("origin")
    if origin in ALLOWED_ORIGINS:
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            "Vary": "Origin",
        }
    return {}


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    # Only reached for non-HTTPException errors: HTTPException is handled by
    # ExceptionMiddleware (below CORSMiddleware) and already gets CORS headers.
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
        headers=_error_cors_headers(request),
    )

app.include_router(auth_router)

# One router per URL-prefix domain. New routes go in the matching routers/<domain>.py,
# never here — main.py is the app factory only.
from app.routers import health as health_router  # noqa: E402
from app.routers import overview as overview_router  # noqa: E402
from app.routers import recruitment as recruitment_router  # noqa: E402
from app.routers import implementation as implementation_router  # noqa: E402
from app.routers import operations as operations_router  # noqa: E402
app.include_router(health_router.router)
app.include_router(overview_router.router)
app.include_router(recruitment_router.router)
app.include_router(implementation_router.router)
app.include_router(operations_router.router)


@app.middleware("http")
async def require_client_header(request: Request, call_next):
    # Skip preflight + exempt paths.
    if request.method == "OPTIONS" or request.url.path in CLIENT_GUARD_EXEMPT_PATHS:
        return await call_next(request)
    if request.url.path.startswith("/api/"):
        if request.headers.get("X-EBA-Client") != ALLOWED_CLIENT_TOKEN:
            return JSONResponse(status_code=403, content={"detail": "Forbidden"})
    return await call_next(request)
