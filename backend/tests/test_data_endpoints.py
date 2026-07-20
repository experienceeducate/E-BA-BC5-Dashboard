"""Data endpoints reshape mocked BigQuery rows correctly and hit the run_query seam."""


def test_filters_shape(as_staff, mock_run_query):
    mock_run_query.set_rows([{"districts": ["BUGIRI"], "genders": ["FEMALE", "MALE"], "cohorts": ["BC5"]}])
    r = as_staff.get("/api/filters")
    assert r.status_code == 200
    assert r.json()["districts"] == ["BUGIRI"]


def test_overview_funnel_orders_and_computes_pct(as_staff, mock_run_query):
    # Returned out of pipeline order — endpoint must re-order by funnel stage.
    mock_run_query.set_rows([
        {"stage": "Interested", "count": 80},
        {"stage": "Registered", "count": 100},
    ])
    r = as_staff.get("/api/overview/funnel")
    assert r.status_code == 200
    stages = r.json()["stages"]
    assert [s["stage"] for s in stages] == ["Registered", "Interested"]
    assert stages[0]["pct_of_previous"] == 100.0
    assert stages[1]["pct_of_previous"] == 80.0
    assert stages[1]["lost"] == 20


def test_overview_kpis_rates(as_staff, mock_run_query):
    mock_run_query.set_rows([
        {"stage": "Interested", "count": 100},
        {"stage": "Eligible", "count": 75},
    ])
    r = as_staff.get("/api/overview/kpis")
    assert r.status_code == 200
    assert r.json()["rates"]["eligibility_rate"] == 75.0


def test_run_query_receives_caller_role(as_guest, mock_run_query):
    mock_run_query.set_rows([])
    as_guest.get("/api/overview/funnel")
    assert mock_run_query.calls
    assert all(c["role"] == "guest" for c in mock_run_query.calls)


def test_endpoints_require_auth(client, mock_run_query):
    # Header present (client fixture) but no JWT override -> current_user 401s.
    assert client.get("/api/overview/funnel").status_code == 401
