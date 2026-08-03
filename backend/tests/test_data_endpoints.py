"""Data endpoints reshape mocked BigQuery rows correctly and hit the run_query seam.

/api/overview/funnel and /api/overview/kpis now span three live tables
(AWARENESS_SUMMARY, DAILY_ACQUISITION_SUMMARY, SITE_FUNNEL_METRICS -- see
_stage_counts in app/routers/overview.py), so these tests use set_side_effect
to hand back the right shape per table rather than one set_rows() for a single
query.
"""

from app.core.tables import AWARENESS_SUMMARY, FUNNEL_STAGES
from app.routers.implementation import TRAINER_COHORTS


def test_filters_shape(as_staff, mock_run_query):
    # get_filters unions DISTINCT values across every live table for each of
    # district/cohort/gender -- three run_query calls total (one big UNION
    # DISTINCT per dimension), every row aliased AS v. Distinguish by which
    # column each dimension's UNION references.
    def side_effect(sql, params, role):
        if "bootcamp_cycle" in sql:
            return [{"v": "BOOTCAMP_2"}, {"v": "BOOTCAMP_4"}, {"v": "BOOTCAMP_5"}]
        if "gender" in sql:
            return [{"v": "FEMALE"}, {"v": "MALE"}]
        return [{"v": "BUGIRI"}, {"v": "BUGWERI"}]
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/filters")
    assert r.status_code == 200
    assert r.json()["districts"] == ["BUGIRI", "BUGWERI"]
    assert r.json()["genders"] == ["FEMALE", "MALE"]
    assert r.json()["cohorts"] == ["BOOTCAMP_2", "BOOTCAMP_4", "BOOTCAMP_5"]


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


# --- Trainer Quality cohort filter -------------------------------------------
# The observation table has no bootcamp_cycle column, so a cohort IS a
# submission-date window (see tables.py). These pin the parts of that mapping
# that are easy to break silently: the allowed values, the un-cohorted gap
# between BOOTCAMP_4 and BC5 TOT, and the rollup's chronological order.


def test_trainers_rejects_unknown_cohort(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    # phase is a Literal, so a bad value is a 422 from FastAPI -- not a silent
    # fall-through to the all-cohorts window, which is what a bare str did.
    assert as_staff.get("/api/implementation/trainers?phase=BOOTCAMP_9").status_code == 422
    assert as_staff.get("/api/implementation/trainers?phase=").status_code == 422


def test_trainers_accepts_every_declared_cohort(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    for cohort in TRAINER_COHORTS:
        r = as_staff.get("/api/implementation/trainers", params={"phase": cohort})
        assert r.status_code == 200, cohort
    assert as_staff.get("/api/implementation/trainers").json()["cohorts"] == TRAINER_COHORTS


def test_trainers_all_cohorts_excludes_the_gap_between_windows(as_staff, mock_run_query):
    """No phase must OR the cohort windows, not span one wide range -- otherwise
    2026-05-30..2026-07-28 (no cohort) would be swept in with a NULL label."""
    mock_run_query.set_rows([])
    as_staff.get("/api/implementation/trainers")
    register_sql = mock_run_query.calls[0]["sql"]
    assert " OR " in register_sql
    # One BETWEEN per cohort window, in both the filter and the labelling CASE.
    assert register_sql.count("BETWEEN") >= 2 * len(TRAINER_COHORTS)
    # Cohort is part of the register's grain, so a trainer seen in two cohorts
    # yields a row per cohort rather than one blended score.
    assert "GROUP BY trainer_name, venue, district, cohort" in register_sql


def test_trainers_narrowing_to_one_cohort_drops_the_or(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    as_staff.get("/api/implementation/trainers", params={"phase": "BOOTCAMP_4"})
    where = mock_run_query.calls[0]["sql"].split("WHERE", 1)[1].split("GROUP BY")[0]
    assert " OR " not in where
    # ... but every window param stays bound, since the labelling CASE uses them.
    names = {p.name for p in mock_run_query.calls[0]["params"]}
    assert {"tq_c0s", "tq_c0e", "tq_c1s", "tq_c1e", "tq_c2s", "tq_c2e"} <= names


def test_trainers_rollup_is_chronological_not_alphabetical(as_staff, mock_run_query):
    # "BC5 TOT" sorts before "BOOTCAMP_4" alphabetically; the endpoint must
    # reorder to the real cohort sequence.
    def side_effect(sql, params, role):
        if "COUNT(DISTINCT trainer_name)" in sql:
            return [
                {"phase": "BC5 TOT", "trainers_observed": 35, "score": 3.71},
                {"phase": "BOOTCAMP_4", "trainers_observed": 79, "score": 3.70},
            ]
        return []
    mock_run_query.set_side_effect(side_effect)
    body = as_staff.get("/api/implementation/trainers").json()
    assert [p["phase"] for p in body["by_phase"]] == ["BOOTCAMP_4", "BC5 TOT"]
