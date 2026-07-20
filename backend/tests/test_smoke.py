"""Smoke tests — the app boots and health is reachable without auth."""


def test_health_no_auth_no_header(client_no_header):
    r = client_no_header.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_openapi_served(client):
    assert client.get("/openapi.json").status_code == 200


def test_app_title():
    import app.main as main_module
    assert main_module.app.title == "Take Off Dashboard API"
