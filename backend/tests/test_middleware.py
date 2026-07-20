"""The X-EBA-Client header guard on /api/* routes."""


def test_api_route_without_client_header_403(client_no_header):
    # /api/auth/login is under /api/ and not exempt, so the guard fires first.
    r = client_no_header.post("/api/auth/login", json={"password": "x"})
    assert r.status_code == 403
    assert r.json() == {"detail": "Forbidden"}


def test_api_route_with_wrong_client_header_403(client_no_header):
    r = client_no_header.post(
        "/api/auth/login",
        json={"password": "x"},
        headers={"X-EBA-Client": "wrong-token"},
    )
    assert r.status_code == 403


def test_health_exempt_from_guard(client_no_header):
    assert client_no_header.get("/health").status_code == 200


def test_oauth_callback_exempt_from_guard(client_no_header):
    # Exempt path — guard must not 403 it (it fails later for other reasons,
    # but never with the 403 Forbidden the guard would return).
    r = client_no_header.get("/api/auth/google/callback")
    assert r.status_code != 403


def test_correct_client_header_passes_guard(client):
    # client fixture pre-sets the header; a valid guest login proves it passes.
    r = client.post("/api/auth/login", json={"password": "test-dashboard-password"})
    assert r.status_code == 200
