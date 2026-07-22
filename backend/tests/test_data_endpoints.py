"""Data endpoints reshape mocked BigQuery rows correctly and hit the run_query seam.

/api/overview/funnel and /api/overview/kpis now span three live tables
(AWARENESS_SUMMARY, DAILY_ACQUISITION_SUMMARY, SITE_FUNNEL_METRICS — see
_stage_counts in app/routers/overview.py), so these tests use set_side_effect
to hand back the right shape per table rather than one set_rows() for a single
query.
"""

from app.core.tables import AWARENESS_SUMMARY, FUNNEL_STAGES


def test_filters_shape(as_staff, mock_run_query):
    # get_filters is a single UNION query across two tables in one run_query call.
    mock_run_query.set_rows([{"district": "BUGIRI"}, {"district": "BUGWERI"}])
    r = as_staff.get("/api/filters")
    assert r.status_code == 200
    assert r.json()["districts"] == ["BUGIRI", "BUGWERI"]
    assert r.json()["genders"] == ["FEMALE", "MALE"]
    assert r.json()["cohorts"] == ["BOOTCAMP_4"]


def test_overview_funnel_orders_and_computes_pct(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if AWARENESS_SUMMARY in sql:
            return [{"registered": 100, "interested": 80, "eligible": 0}]
        return [{}]
    mock_run_query.set_side_effect(side_effect)

    r = as_staff.get("/api/overview/funnel")
    assert r.status_code == 200
    stages = r.json()["stages"]
    # Endpoint now always returns the full 10-stage funnel, in pipeline order.
    assert [s["stage"] for s in stages] == FUNNEL_STAGES
    by_stage = {s["stage"]: s for s in stages}
    assert by_stage["Registered"]["count"] == 100
    assert by_stage["Registered"]["pct_of_previous"] == 100.0
    assert by_stage["Interested"]["count"] == 80
    assert by_stage["Interested"]["pct_of_previous"] == 80.0
    assert by_stage["Interested"]["lost"] == 20


def test_overview_kpis_rates(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if AWARENESS_SUMMARY in sql:
            return [{"registered": 0, "interested": 100, "eligible": 75}]
        return [{}]
    mock_run_query.set_side_effect(side_effect)

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
