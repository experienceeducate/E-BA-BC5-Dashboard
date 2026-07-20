"""Security invariants: PII never leaks raw, guest names masked, JWTs validated."""

import app.auth as auth_module

_YOUTH_ROW = {
    "phone_number": "+256700123456",
    "name": "Nabirye Sarah",
    "gender": "Female",
    "age": 22,
    "district": "BUGIRI",
    "parish": "BUBUGO",
    "village": "Kaiti",
    "education": "S3",
    "income": "20000",
    "channel": "offline",
}


def test_personas_never_serialises_raw_phone(as_staff, mock_run_query):
    mock_run_query.set_rows([dict(_YOUTH_ROW)])
    r = as_staff.get("/api/recruitment/personas")
    assert r.status_code == 200
    # Raw phone must not appear anywhere in the response, even for staff.
    assert "+256700123456" not in r.text
    youth = r.json()["youth"][0]
    assert "phone_number" not in youth
    assert youth["youth_id"].startswith("Y-")


def test_personas_masks_name_for_guest(as_guest, mock_run_query):
    mock_run_query.set_rows([dict(_YOUTH_ROW)])
    youth = as_guest.get("/api/recruitment/personas").json()["youth"][0]
    assert youth["name"] == "N. S."


def test_personas_full_name_for_staff(as_staff, mock_run_query):
    mock_run_query.set_rows([dict(_YOUTH_ROW)])
    youth = as_staff.get("/api/recruitment/personas").json()["youth"][0]
    assert youth["name"] == "Nabirye Sarah"


def test_mis_signed_jwt_rejected(client, make_token):
    bad = make_token({"role": "staff", "email": "x@experienceeducate.org"}, secret="wrong-secret")
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {bad}"})
    assert r.status_code == 401


def test_unknown_role_rejected(client, make_token):
    bad = make_token({"role": "admin", "sub": "x"})
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {bad}"})
    assert r.status_code == 401


def test_user_filter_values_are_parameterised(as_staff, mock_run_query):
    # A district that looks like SQL injection must be sent as a bound param,
    # never interpolated into the query string.
    mock_run_query.set_rows([])
    as_staff.get("/api/overview/funnel?district=BUGIRI'; DROP TABLE x;--")
    call = mock_run_query.calls[0]
    assert "DROP TABLE" not in call["sql"]
    assert any("DROP TABLE" in str(getattr(p, "values", "")) for p in call["params"])
