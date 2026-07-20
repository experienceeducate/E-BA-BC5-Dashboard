"""
Authentication: Google SSO for Educate staff + shared password for guests.

All auth routes live under /api/auth. Other modules use current_user as a
FastAPI dependency to get the authenticated User on a request.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from authlib.integrations.starlette_client import OAuth, OAuthError

from app.core.config import settings

# ─── Config ────────────────────────────────────────────────────────────────────
# Re-exported as module attributes (not just referenced via `settings.*`)
# because other modules and tests read them directly, e.g. `auth_module.JWT_SECRET`.
# Settings() already validates JWT_SECRET/DASHBOARD_PASSWORD are present at import.

DASHBOARD_PASSWORD = settings.DASHBOARD_PASSWORD
JWT_SECRET         = settings.JWT_SECRET
JWT_ALGORITHM      = settings.JWT_ALGORITHM
TOKEN_EXPIRE_HOURS = settings.TOKEN_EXPIRE_HOURS

GOOGLE_OAUTH_CLIENT_ID     = settings.GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET = settings.GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_OAUTH_REDIRECT_URI  = settings.GOOGLE_OAUTH_REDIRECT_URI
OAUTH_ALLOWED_DOMAIN       = settings.OAUTH_ALLOWED_DOMAIN
FRONTEND_URL               = settings.FRONTEND_URL

Role = Literal["staff", "guest"]

@dataclass
class User:
    role: Role
    email: Optional[str] = None

# ─── JWT ───────────────────────────────────────────────────────────────────────

def create_jwt(role: Role, email: Optional[str] = None) -> str:
    expire = datetime.utcnow() + timedelta(hours=TOKEN_EXPIRE_HOURS)
    payload = {"exp": expire, "role": role, "sub": email or "guest"}
    if email:
        payload["email"] = email
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

_bearer = HTTPBearer(auto_error=False)

def current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> User:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    try:
        payload = jwt.decode(
            credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM]
        )
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    role = payload.get("role")
    if role not in ("staff", "guest"):
        raise HTTPException(status_code=401, detail="Invalid token role")
    return User(role=role, email=payload.get("email"))

# ─── Google OAuth client ───────────────────────────────────────────────────────

oauth = OAuth()
oauth.register(
    name="google",
    client_id=GOOGLE_OAUTH_CLIENT_ID,
    client_secret=GOOGLE_OAUTH_CLIENT_SECRET,
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)

# ─── Routes ────────────────────────────────────────────────────────────────────

router = APIRouter(prefix="/api/auth", tags=["auth"])

@router.post("/login")
def guest_login(body: dict = Body(...)):
    if body.get("password") != DASHBOARD_PASSWORD:
        raise HTTPException(status_code=401, detail="Incorrect password")
    return {
        "token": create_jwt(role="guest"),
        "role": "guest",
        "expires_in_hours": TOKEN_EXPIRE_HOURS,
    }

@router.get("/google/login")
async def google_login(request: Request):
    if not (GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI):
        raise HTTPException(status_code=503, detail="Google SSO not configured")
    return await oauth.google.authorize_redirect(request, GOOGLE_OAUTH_REDIRECT_URI)

@router.get("/google/callback")
async def google_callback(request: Request):
    try:
        token = await oauth.google.authorize_access_token(request)
    except OAuthError:
        raise HTTPException(status_code=401, detail="OAuth exchange failed")

    userinfo = token.get("userinfo") or {}
    email = (userinfo.get("email") or "").lower()
    email_verified = userinfo.get("email_verified", False)

    if not email or not email_verified or not email.endswith(f"@{OAUTH_ALLOWED_DOMAIN}"):
        raise HTTPException(status_code=403, detail="Not an authorised Educate account")

    jwt_token = create_jwt(role="staff", email=email)
    # URL fragment so the token isn't sent to servers or logged in proxies.
    return RedirectResponse(url=f"{FRONTEND_URL}/#token={jwt_token}")

@router.get("/me")
def me(user: User = Depends(current_user)):
    return {"role": user.role, "email": user.email}
