"""Typed query params return 422 on malformed input, never a 500."""


def test_personas_limit_below_min_422(as_staff, mock_run_query):
    assert as_staff.get("/api/recruitment/personas?limit=0").status_code == 422


def test_personas_limit_above_max_422(as_staff, mock_run_query):
    assert as_staff.get("/api/recruitment/personas?limit=99999").status_code == 422


def test_personas_limit_not_an_int_422(as_staff, mock_run_query):
    assert as_staff.get("/api/recruitment/personas?limit=abc").status_code == 422


def test_personas_valid_limit_ok(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    assert as_staff.get("/api/recruitment/personas?limit=50").status_code == 200
