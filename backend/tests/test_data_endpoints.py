"""Data endpoints reshape mocked BigQuery rows correctly and hit the run_query seam.

/api/overview/funnel and /api/overview/kpis now span three live tables
(AWARENESS_SUMMARY, DAILY_ACQUISITION_SUMMARY, SITE_FUNNEL_METRICS -- see
_stage_counts in app/routers/overview.py), so these tests use set_side_effect
to hand back the right shape per table rather than one set_rows() for a single
query.
"""

import app.core.pii as pii_module
from app.core.tables import AWARENESS_SUMMARY, AWARENESS_KYC, FUNNEL_STAGES
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
    assert "GROUP BY trainer_name, trainer_gender, venue, district, cohort" in register_sql


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


# ─── Trainer Quality: per-trainer detail (trend/comparisons/insights drill) ──

class _FakeQueryResult:
    def __init__(self, rows):
        self._rows = rows

    def result(self):
        return self._rows


class _FakeBQClient:
    """Stands in for the real bigquery.Client used only by pii.py's
    trainer_key reverse-lookup (name_from_trainer_key) — that helper bypasses
    database.run_query by design (same precedent as phone_from_youth_id), so
    mock_run_query alone doesn't cover it."""

    def __init__(self, trainer_names):
        self._rows = [{"trainer_name": n} for n in trainer_names]

    def query(self, sql, job_config=None):
        return _FakeQueryResult(self._rows)


def test_trainer_detail_happy_path(as_staff, mock_run_query, monkeypatch):
    monkeypatch.setattr(pii_module, "get_bq_client", lambda: _FakeBQClient(["Jane Doe"]))
    mock_run_query.set_rows([
        {
            "observation_date": "2026-08-01", "cohort": "BC5 TOT",
            "training_week": "WEEK1", "training_day": "Day01",
            "observer_name": "Bob Observer", "venue": "BC5 TOT", "district": "JINJA",
            "score": 3.8,
            "avg_pck": 3.5, "avg_fds": 4.0, "avg_em": 3.2, "avg_gr": 3.9,
            "avg_cm": 3.6, "avg_language": 4.1, "avg_leadership": 3.4,
        },
    ])
    key = pii_module.trainer_key("Jane Doe")

    r = as_staff.get(f"/api/implementation/trainer-detail?trainer_key={key}")

    assert r.status_code == 200
    body = r.json()
    assert body["trainer_name"] == "Jane Doe"  # staff sees the raw name
    assert body["trainer_key"] == key
    assert len(body["observations"]) == 1
    assert body["observations"][0]["observer_name"] == "Bob Observer"
    assert body["observations"][0]["score"] == 3.8
    assert [d["key"] for d in body["domains"]] == ["pck", "fds", "em", "gr", "cm", "language", "leadership"]


def test_trainer_detail_masks_names_for_guest(as_guest, mock_run_query, monkeypatch):
    monkeypatch.setattr(pii_module, "get_bq_client", lambda: _FakeBQClient(["Jane Doe"]))
    mock_run_query.set_rows([
        {"observation_date": "2026-08-01", "cohort": "BC5 TOT", "observer_name": "Bob Observer", "score": 3.8},
    ])
    key = pii_module.trainer_key("Jane Doe")

    r = as_guest.get(f"/api/implementation/trainer-detail?trainer_key={key}")

    assert r.status_code == 200
    body = r.json()
    assert body["trainer_name"] == "J. D."
    assert body["observations"][0]["observer_name"] == "B. O."


def test_trainer_detail_unknown_key_404s(as_staff, mock_run_query, monkeypatch):
    monkeypatch.setattr(pii_module, "get_bq_client", lambda: _FakeBQClient(["Jane Doe"]))

    r = as_staff.get("/api/implementation/trainer-detail?trainer_key=T-DEADBEEF")

    assert r.status_code == 404
    assert not mock_run_query.calls  # never reaches the observation query


def test_trainer_detail_rejects_unknown_cohort(as_staff, mock_run_query, monkeypatch):
    monkeypatch.setattr(pii_module, "get_bq_client", lambda: _FakeBQClient(["Jane Doe"]))
    key = pii_module.trainer_key("Jane Doe")
    assert as_staff.get(f"/api/implementation/trainer-detail?trainer_key={key}&phase=BOOTCAMP_9").status_code == 422


def test_trainers_register_includes_trainer_key_and_gender(as_staff, mock_run_query):
    mock_run_query.set_rows([
        {"trainer_name": "Jane Doe", "trainer_gender": "Female", "venue": "BC5 TOT", "district": "JINJA", "score": 3.8},
    ])

    r = as_staff.get("/api/implementation/trainers")

    assert r.status_code == 200
    row = r.json()["trainers"][0]
    assert row["trainer_gender"] == "Female"
    assert row["trainer_key"] == pii_module.trainer_key("Jane Doe")


# --- Awareness eligible-assignment (Treatment/Control) -----------------------
# RCT assignment lives per-youth on AWARENESS_KYC (silver), not on the gold
# parish summary the rest of Awareness Overview reads. Coverage is sparse and
# cohort-dependent (confirmed against live data: ~0% on BOOTCAMP_2/3, ~11% on
# BOOTCAMP_4, ~84% on BOOTCAMP_5), so pct_treatment/pct_control are of the
# assigned pool only -- never of eligible_count, which would make both
# percentages read as single digits for a reason unrelated to the split itself.


def test_awareness_eligible_assignment_shape(as_staff, mock_run_query):
    mock_run_query.set_rows([
        {"eligible_count": 8072, "treatment_count": 1338, "control_count": 677, "unassigned_count": 6057},
    ])
    r = as_staff.get("/api/recruitment/awareness-eligible-assignment")
    assert r.status_code == 200
    body = r.json()
    assert body["eligible_count"] == 8072
    assert body["treatment_count"] == 1338
    assert body["control_count"] == 677
    assert body["unassigned_count"] == 6057
    assert body["assigned_count"] == 2015  # 1338 + 677
    # Percentages are of the ASSIGNED pool, not eligible_count -- must sum to 100.
    assert body["pct_treatment"] == 66.4
    assert body["pct_control"] == 33.6
    assert body["pct_treatment"] + body["pct_control"] == 100.0
    # pct_unassigned is a separate share, of eligible_count.
    assert body["pct_unassigned"] == 75.0


def test_awareness_eligible_assignment_zero_assigned_returns_null_pct(as_staff, mock_run_query):
    """No assigned youth at all (e.g. BOOTCAMP_2/3 alone) must not divide by
    zero -- pct_treatment/pct_control are None, not a ZeroDivisionError 500."""
    mock_run_query.set_rows([
        {"eligible_count": 5500, "treatment_count": 0, "control_count": 0, "unassigned_count": 5500},
    ])
    r = as_staff.get("/api/recruitment/awareness-eligible-assignment")
    assert r.status_code == 200
    body = r.json()
    assert body["assigned_count"] == 0
    assert body["pct_treatment"] is None
    assert body["pct_control"] is None
    assert body["pct_unassigned"] == 100.0


def test_awareness_eligible_assignment_zero_eligible_returns_null_pct_unassigned(as_staff, mock_run_query):
    mock_run_query.set_rows([
        {"eligible_count": 0, "treatment_count": 0, "control_count": 0, "unassigned_count": 0},
    ])
    r = as_staff.get("/api/recruitment/awareness-eligible-assignment")
    assert r.status_code == 200
    assert r.json()["pct_unassigned"] is None


def test_awareness_eligible_assignment_filters_to_elligible_true(as_staff, mock_run_query):
    mock_run_query.set_rows([{}])
    as_staff.get("/api/recruitment/awareness-eligible-assignment")
    sql = mock_run_query.calls[0]["sql"]
    assert AWARENESS_KYC in sql
    assert "elligible = TRUE" in sql


def test_awareness_eligible_assignment_accepts_district_gender_cohort(as_staff, mock_run_query):
    mock_run_query.set_rows([{}])
    r = as_staff.get(
        "/api/recruitment/awareness-eligible-assignment",
        params={"district": "BUGIRI", "gender": "FEMALE", "cohort": "BOOTCAMP_5"},
    )
    assert r.status_code == 200
    sql = mock_run_query.calls[0]["sql"]
    assert "youth_district" in sql
    assert "youth_gender" in sql
