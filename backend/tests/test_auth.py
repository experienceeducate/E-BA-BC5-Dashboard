"""Auth: guest login, JWT validation, /me."""

import app.auth as auth_module


def test_guest_login_success(client):
    r = client.post("/api/auth/login", json={"password": "test-dashboard-password"})
    assert r.status_code == 200
    body = r.json()
    assert body["role"] == "guest"
    assert body["token"]
    assert body["expires_in_hours"] == auth_module.TOKEN_EXPIRE_HOURS


def test_guest_login_wrong_password(client):
    r = client.post("/api/auth/login", json={"password": "nope"})
    assert r.status_code == 401


def test_me_requires_token(client):
    # No Authorization header -> 401 from current_user.
    assert client.get("/api/auth/me").status_code == 401


def test_me_with_valid_guest_token(client):
    token = auth_module.create_jwt(role="guest")
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json() == {"role": "guest", "email": None}


def test_me_with_valid_staff_token(client):
    token = auth_module.create_jwt(role="staff", email="staff@experienceeducate.org")
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json() == {"role": "staff", "email": "staff@experienceeducate.org"}
