"""Data endpoints reshape mocked BigQuery rows correctly and hit the run_query seam.

/api/overview/funnel and /api/overview/kpis now span three live tables
(AWARENESS_SUMMARY, DAILY_ACQUISITION_SUMMARY, SITE_FUNNEL_METRICS -- see
_stage_counts in app/routers/overview.py), so these tests use set_side_effect
to hand back the right shape per table rather than one set_rows() for a single
query.
"""

import pytest

import app.core.pii as pii_module
from app.core.question_themes import classify_question
from app.core.sql import multiselect_array_sql, normalized_parish_sql
from app.core.tables import AWARENESS_SUMMARY, AWARENESS_KYC, FUNNEL_STAGES, venue_mobilisation_target, canonical_venue_sql, QA_CALLS_START_DATE, LAST_ACQUISITION_CALL_DATE, QUALITY_ASSURANCE_BC5, QA_MEASURE_CUMULATIVE, QA_MEASURE_DAILY
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
        if AWARENESS_KYC in sql:
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


def test_overview_funnel_assigned_excludes_auto_confirm_pilot(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if "SUM(preload_youth) AS assigned" in sql:
            return [{"assigned": 2073}]
        if "elligible = TRUE AND is_treatment = TRUE" in sql:
            return [{"n": 908}]
        return [{}]
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/overview/funnel")
    assert r.status_code == 200
    by_stage = {s["stage"]: s for s in r.json()["stages"]}
    # Assigned is the call-center preload list alone -- NOT blended with the
    # auto-confirm pilot population (908), matching Mobilisation Overview's
    # own "Assigned to treatment" scope. The two used to disagree (2073 vs
    # 2981 for the same live data), which read as a bug, not a design choice.
    assert by_stage["Assigned"]["count"] == 2073


def test_overview_kpis_rates(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if AWARENESS_KYC in sql:
            return [{"registered": 0, "interested": 100, "eligible": 75}]
        return [{}]
    mock_run_query.set_side_effect(side_effect)

    r = as_staff.get("/api/overview/kpis")
    assert r.status_code == 200
    assert r.json()["rates"]["eligibility_rate"] == 75.0


# --- Recruitment funnel split (Waiting List vs New Recruits) ----------------
# Waiting List is pure call-center/acquisition data (DAILY_ACQUISITION_
# SUMMARY/DEDUPED) with no Registered/Interested/Eligible stages at all; New
# Recruits is the awareness table (AWARENESS_KYC), split by RCT arm once
# eligible. Both converge into one merged Verified..Retained tail.

def test_funnel_split_shape(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    r = as_staff.get("/api/overview/funnel-split")
    assert r.status_code == 200
    body = r.json()
    assert [s["stage"] for s in body["waiting_list"]] == ["Assigned", "Reached", "Confirmed"]
    assert [s["stage"] for s in body["new_recruits"]] == ["Registered", "Interested", "Eligible"]
    assert [s["stage"] for s in body["merged"]] == ["Verified", "Acquired", "Activated", "Retained"]
    assert body["new_recruits_treatment"] == 0
    assert body["new_recruits_control"] == 0


def test_funnel_split_new_recruits_sourced_from_awareness_kyc(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if AWARENESS_KYC in sql:
            return [{"registered": 200, "interested": 180, "eligible": 150, "treatment": 60, "control": 40}]
        return [{}]
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/overview/funnel-split")
    assert r.status_code == 200
    body = r.json()
    by_stage = {s["stage"]: s["count"] for s in body["new_recruits"]}
    assert by_stage["Registered"] == 200
    assert by_stage["Interested"] == 180
    assert by_stage["Eligible"] == 150
    assert "Randomised" not in by_stage
    assert "Confirmed" not in by_stage
    assert body["new_recruits_treatment"] == 60
    assert body["new_recruits_control"] == 40


# --- Gender split (mirrors funnel-split's BC3 Control List vs New Recruits) -

def test_gender_split_shape(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    r = as_staff.get("/api/overview/gender-split")
    assert r.status_code == 200
    body = r.json()
    assert [s["stage"] for s in body["bc3_control_list"]] == ["Reached", "Confirmed"]
    assert [s["stage"] for s in body["new_recruits"]] == ["Registered", "Interested", "Eligible"]
    assert [s["stage"] for s in body["merged"]] == ["Acquired", "Activated", "Retained"]
    assert body["new_recruits_treatment"]["female"] == 0
    assert body["new_recruits_control"]["female"] == 0


def test_gender_split_new_recruits_sourced_from_awareness_kyc(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if AWARENESS_KYC in sql:
            return [{
                "registered_f": 120, "registered_m": 80,
                "interested_f": 110, "interested_m": 75,
                "eligible_f": 100, "eligible_m": 60,
                "treatment_f": 40, "treatment_m": 20,
                "control_f": 30, "control_m": 15,
            }]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/overview/gender-split")
    assert r.status_code == 200
    body = r.json()
    by_stage = {s["stage"]: s for s in body["new_recruits"]}
    assert by_stage["Registered"]["female"] == 120
    assert by_stage["Registered"]["male"] == 80
    assert by_stage["Eligible"]["pct_female"] == 62.5
    assert body["new_recruits_treatment"]["female"] == 40
    assert body["new_recruits_treatment"]["male"] == 20
    assert body["new_recruits_control"]["female"] == 30
    assert body["new_recruits_control"]["male"] == 15

    # Retention is per-gender, stage-to-stage, within this one pathway.
    assert by_stage["Registered"]["female_pct_of_previous"] is None  # first stage — "start"
    assert by_stage["Interested"]["female_pct_of_previous"] == round(100 * 110 / 120, 1)
    assert by_stage["Interested"]["male_pct_of_previous"] == round(100 * 75 / 80, 1)
    assert by_stage["Eligible"]["female_pct_of_previous"] == round(100 * 100 / 110, 1)
    # Treatment/Control retention is measured against Eligible, not each other.
    assert body["new_recruits_treatment"]["female_pct_of_previous"] == round(100 * 40 / 100, 1)
    assert body["new_recruits_control"]["male_pct_of_previous"] == round(100 * 15 / 60, 1)


def test_gender_split_omits_stages_with_no_gender_data(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    r = as_staff.get("/api/overview/gender-split")
    assert r.status_code == 200
    body = r.json()
    all_stages = {s["stage"] for group in ("bc3_control_list", "new_recruits", "merged") for s in body[group]}
    assert "Assigned" not in all_stages
    assert "Verified" not in all_stages


def test_gender_omits_assigned_stage(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    r = as_staff.get("/api/overview/gender")
    assert r.status_code == 200
    by_stage = {s["stage"]: s for s in r.json()["stages"]}
    assert by_stage["Assigned"]["female"] is None
    assert by_stage["Assigned"]["male"] is None
    assert by_stage["Assigned"]["pct_female"] is None


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


# --- Awareness parish (incl. RCT Treatment/Control) --------------------------
# awareness_parish is backed by the live per-youth AWARENESS_KYC table, not
# the gold AWARENESS_SUMMARY mart (which lags live registrations -- see the
# function's docstring). The RCT assignment card's Treatment/Control/
# Unassigned split is read straight off AWARENESS_KYC's per-youth
# is_treatment BOOL column (TRUE/FALSE/NULL), the same query awareness_parish
# already feeds the rest of Awareness Overview from -- one parish-grain fetch
# for everything, so the card is automatically as search/filter-scoped as
# every other card on the page. Confirmed against live data (2026-08-05):
# COUNTIF(is_treatment = TRUE)/COUNTIF(is_treatment = FALSE) match the gold
# mart's own treatment/control totals exactly for both cohorts that carry
# is_treatment data (BOOTCAMP_4: 596/100; BOOTCAMP_5: 870/679) -- BOOTCAMP_2/3
# carry no is_treatment data on this table, same as the gold mart's own
# 0%/fully-randomized-elsewhere gap for those cohorts.


def test_awareness_parish_shape_includes_treatment_control(as_staff, mock_run_query):
    mock_run_query.set_rows([{
        "district": "BUGIRI", "parish": "BULIDHA",
        "reached": 500, "reached_female": 300, "reached_male": 200,
        "interested": 400, "interested_female": 250, "interested_male": 150,
        "eligible": 350, "eligible_female": 220, "eligible_male": 130,
        "pct_female": 62.9,
        "eligible_treatment": 150, "eligible_treatment_female": 95, "eligible_treatment_male": 55,
        "eligible_control": 100, "eligible_control_female": 63, "eligible_control_male": 37,
    }])
    r = as_staff.get("/api/recruitment/awareness-parish")
    assert r.status_code == 200
    row = r.json()["parishes"][0]
    assert row["eligible_treatment"] == 150
    assert row["eligible_treatment_female"] == 95
    assert row["eligible_treatment_male"] == 55
    assert row["eligible_control"] == 100
    assert row["eligible_control_female"] == 63
    assert row["eligible_control_male"] == 37


def test_awareness_parish_sql_sums_treatment_control_columns(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    as_staff.get("/api/recruitment/awareness-parish")
    sql = mock_run_query.calls[0]["sql"]
    assert AWARENESS_KYC in sql
    assert "COUNTIF(elligible = TRUE AND is_treatment = TRUE) AS eligible_treatment" in sql
    assert "COUNTIF(elligible = TRUE AND is_treatment = TRUE AND UPPER(youth_gender) = 'FEMALE') AS eligible_treatment_female" in sql
    assert "COUNTIF(elligible = TRUE AND is_treatment = TRUE AND UPPER(youth_gender) = 'MALE') AS eligible_treatment_male" in sql
    assert "COUNTIF(elligible = TRUE AND is_treatment = FALSE) AS eligible_control" in sql
    assert "COUNTIF(elligible = TRUE AND is_treatment = FALSE AND UPPER(youth_gender) = 'FEMALE') AS eligible_control_female" in sql
    assert "COUNTIF(elligible = TRUE AND is_treatment = FALSE AND UPPER(youth_gender) = 'MALE') AS eligible_control_male" in sql


def test_awareness_parish_hardcoded_target_only_row_zeroes_treatment_control(as_staff, mock_run_query):
    """A parish with a hardcoded target but no awareness activity recorded
    yet gets a zeroed row (existing behavior for reached/interested/eligible)
    -- the new treatment/control fields must be zeroed the same way, not
    missing, so the frontend's sums don't see undefined."""
    mock_run_query.set_rows([])
    r = as_staff.get("/api/recruitment/awareness-parish", params={"district": "MAYUGE"})
    assert r.status_code == 200
    for row in r.json()["parishes"]:
        assert "eligible_treatment" in row
        assert "eligible_control" in row


# --- multiselect_array_sql / KYC multiselect columns --------------------------
# current_activty/registration_reasons/decision_consultation/
# bc5_support_required/open_questions were captured in three inconsistent
# string formats across bootcamp cycles/form versions (confirmed against
# live data, 2026-08-04): a valid JSON array, a quoted fragment missing its
# enclosing brackets, or a single bare unquoted value. A bare
# JSON_EXTRACT_STRING_ARRAY(column) silently drops any row it can't parse --
# these tests lock in that all three shapes are now handled.

def test_multiselect_array_sql_handles_all_three_formats():
    sql = multiselect_array_sql("current_activty")
    assert "STARTS_WITH(TRIM(current_activty), '[')" in sql
    assert "JSON_EXTRACT_STRING_ARRAY(current_activty)" in sql
    assert "STARTS_WITH(TRIM(current_activty), '\"')" in sql
    assert "JSON_EXTRACT_STRING_ARRAY(CONCAT('[', current_activty, ']'))" in sql
    assert "ELSE [current_activty]" in sql


def test_multiselect_array_sql_empty_or_null_yields_empty_array():
    sql = multiselect_array_sql("open_questions")
    assert "WHEN open_questions IS NULL OR TRIM(open_questions) = '' THEN []" in sql


def test_awareness_kyc_multiselect_columns_use_multiselect_array_sql(as_staff, mock_run_query):
    """Regression guard: these five queries must not regress to a bare
    UNNEST(JSON_EXTRACT_STRING_ARRAY(column)), which silently dropped most
    rows for the two non-JSON-array formats these columns actually contain."""
    mock_run_query.set_rows([])
    as_staff.get("/api/recruitment/awareness-kyc")
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    for column in ["current_activty", "registration_reasons", "decision_consultation", "bc5_support_required", "open_questions"]:
        assert f"UNNEST(JSON_EXTRACT_STRING_ARRAY({column}))" not in all_sql
        assert f"STARTS_WITH(TRIM({column}), '[')" in all_sql


# --- normalized_parish_sql / MAIRINYA-MAYIRINYA merge -------------------------
# MAYUGE's MAIRINYA parish exists as two distinct literal values in the live
# data -- "MAIRINYA" and "MAYIRINYA" -- confirmed against both AWARENESS_SUMMARY
# and AWARENESS_KYC, 2026-08-04, splitting one real parish's actuals/target/
# RCT split across two rows in every by-parish rollup. The hardcoded BC5
# target sheet (AWARENESS_ELIGIBLE_TARGET_BC5) already spells it "MAIRINYA",
# so actuals recorded under "MAYIRINYA" were also failing to match their
# target row at all.

def test_normalized_parish_sql_folds_known_misspelling():
    sql = normalized_parish_sql("youth_parish")
    assert "WHEN UPPER(TRIM(youth_parish)) = 'MAYIRINYA' THEN 'MAIRINYA'" in sql
    assert "ELSE UPPER(TRIM(youth_parish))" in sql


def test_normalized_parish_sql_defaults_to_youth_parish_column():
    assert "youth_parish" in normalized_parish_sql()


def test_awareness_parish_uses_normalized_parish_sql(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    as_staff.get("/api/recruitment/awareness-parish")
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert "youth_parish AS parish" not in all_sql
    assert "WHEN UPPER(TRIM(youth_parish)) = 'MAYIRINYA' THEN 'MAIRINYA'" in all_sql


def test_awareness_eligible_target_uses_normalized_parish_sql(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    as_staff.get("/api/recruitment/awareness-eligible-target")
    sql = mock_run_query.calls[0]["sql"]
    assert "WHEN UPPER(TRIM(youth_parish)) = 'MAYIRINYA' THEN 'MAIRINYA'" in sql


# --- venue_mobilisation_target (name aliases) --------------------------------
# Same class of bug as MAIRINYA/MAYIRINYA above, at venue grain: live
# venue_name spellings confirmed 2026-08-05 that don't match
# VENUE_MOBILISATION_TARGET even after whitespace/case normalisation, so
# mobilisation_heatmap()'s by_venue silently read target=0 for these venues
# despite real reach/confirm activity.

def test_venue_mobilisation_target_folds_doubled_word_variant():
    assert venue_mobilisation_target("KINAWAMBUZI PRIMARY PRIMARY SCHOOL") == 50


def test_venue_mobilisation_target_folds_parenthetical_suffix_variant():
    assert venue_mobilisation_target("GOLDEN JUNIOR PRIMARY SCHOOL (JUNIOR)") == 64


def test_venue_mobilisation_target_folds_missing_space_variant():
    assert venue_mobilisation_target("ABU HURAIRAH ISLAMIC NUS& PRIMARY SCHOOL") == 59


def test_venue_mobilisation_target_still_matches_canonical_name_case_insensitively():
    assert venue_mobilisation_target("kinawambuzi   primary school") == 50


def test_venue_mobilisation_target_returns_none_for_unmapped_venue():
    assert venue_mobilisation_target("Some Venue Not On The List") is None


def test_canonical_venue_sql_folds_known_variant_onto_canonical_spelling():
    sql = canonical_venue_sql("venue_name")
    assert "WHEN UPPER(venue_name) = 'GOLDEN JUNIOR PRIMARY SCHOOL (JUNIOR)' THEN 'GOLDEN JUNIOR PRIMARY SCHOOL'" in sql
    assert "ELSE UPPER(venue_name)" in sql


# --- classify_question / "Open questions" qualitative coding ------------------
# Grouping the KYC page's free-text open_questions by exact wording buried the
# real signal: ~88% of live values are typo/casing variants of a bare "no"/
# "NA"/thanks, and every substantive question is a one-off phrasing a top-20
# exact-text cap would drop. classify_question() (app/core/question_themes.py)
# qualitatively codes each distinct phrasing into a theme instead.

@pytest.mark.parametrize("question,expected_theme", [
    ("no", "No question raised (or just thanks)"),
    ("NA", "No question raised (or just thanks)"),
    ("Na", "No question raised (or just thanks)"),
    ("none", "No question raised (or just thanks)"),
    ("No questions", "No question raised (or just thanks)"),
    ("appreciated the program", "No question raised (or just thanks)"),
    ("Thank you", "No question raised (or just thanks)"),
    ("No questions but appreciative for the program.", "No question raised (or just thanks)"),
    ("what Is educate", "What is Educate / program identity"),
    ("who is the founder of educate", "What is Educate / program identity"),
    ("when is the boot camp", "Bootcamp schedule, venue & logistics"),
    ("venue for the training", "Bootcamp schedule, venue & logistics"),
    ("Can educate offer start up capital", "Startup capital / financial support"),
    ("will you give us capital", "Startup capital / financial support"),
    ("how much is the transport", "Transport & facilitation"),
    ("who is a youth", "Eligibility & who can join"),
    ("I have two young kids am I eligible", "Eligibility & who can join"),
    ("how helpful is the certificate", "Certificate, jobs & post-training outcomes"),
    ("will we given jobs after graduation", "Certificate, jobs & post-training outcomes"),
    ("but won't you deceive us", "Attendance policy, selection & trust"),
    ("What of the youths that remained in the control group?", "Control-group / study design"),
    ("can you take three contacts", "Other"),
])
def test_classify_question_themes(question, expected_theme):
    assert classify_question(question) == expected_theme


def test_awareness_kyc_questions_returns_themes_not_raw_text(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if "open_questions" in sql:
            return [
                {"question": "no", "count": 700},
                {"question": "NA", "count": 400},
                {"question": "what Is educate", "count": 41},
                {"question": "how much is the transport", "count": 8},
                {"question": "can you take three contacts", "count": 1},
            ]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/recruitment/awareness-kyc")
    assert r.status_code == 200
    questions = r.json()["questions"]
    themes = {q["theme"] for q in questions}
    assert "No question raised (or just thanks)" in themes
    assert "question" not in questions[0]
    # "no" (700) and "NA" (400) both code to the same theme -- must sum, not
    # overwrite, and that combined theme must lead since it's the largest.
    top = max(questions, key=lambda q: q["count"])
    assert top["theme"] == "No question raised (or just thanks)"
    assert top["count"] == 1100
    assert top["example"] == "no"  # most common raw phrasing within the theme


def test_awareness_kyc_questions_sql_has_no_limit(as_staff, mock_run_query):
    """A LIMIT here would silently drop the long tail of one-off substantive
    questions before they ever reach classify_question() -- every distinct
    phrasing must be fetched for the theme counts to be complete."""
    mock_run_query.set_rows([])
    as_staff.get("/api/recruitment/awareness-kyc")
    questions_sql = next(c["sql"] for c in mock_run_query.calls if "open_questions" in c["sql"])
    assert "LIMIT" not in questions_sql.upper()


# --- Milestones (Product Design) ----------------------------------------------
# Backed by the live silver eba_bootcamp_business_plan_reports. below/meet/
# exceed thresholds are the recruitment/M&E team's own reference query (see
# MILESTONE_PERFORMANCE_CATEGORY_SQL, tables.py): Weeks 1-3 use a 1-3/4-6/7-9
# scale, Week 4 uses 1-8/9-15/16-20 -- confirmed against live data, 2026-08-05,
# that every Week 1-3 row scores 0-9 and every Week 4 row scores 0-20.

def test_milestones_weekly_percentages_use_total_youth(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if "week_number" in sql and "GROUP BY week_number" in sql:
            return [{
                "week_number": 1, "total_youth": 200,
                "below": 80, "meet": 70, "exceed": 40, "completed": 190,
                "parent_present": 60, "parent_absent": 40, "parent_no_report": 100,
            }]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/milestones")
    assert r.status_code == 200
    w = r.json()["weekly"][0]
    assert w["below_pct"] == 40.0
    assert w["meet_pct"] == 35.0
    assert w["exceed_pct"] == 20.0
    assert w["completion_pct"] == 95.0
    assert w["parent_present_pct"] == 30.0
    assert w["parent_no_report_pct"] == 50.0


def test_milestones_weekly_zero_total_youth_returns_null_pct(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if "week_number" in sql and "GROUP BY week_number" in sql:
            return [{"week_number": 1, "total_youth": 0, "below": 0, "meet": 0, "exceed": 0,
                      "completed": 0, "parent_present": 0, "parent_absent": 0, "parent_no_report": 0}]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/milestones")
    w = r.json()["weekly"][0]
    assert w["below_pct"] is None
    assert w["completion_pct"] is None


def test_milestones_by_venue_percentages_use_total_reports_not_total_youth(as_staff, mock_run_query):
    """Regression guard: a venue's total_youth is a one-time distinct
    headcount, but below/meet/exceed/completed are summed across every week
    reported -- dividing by total_youth instead of total_reports (row count)
    can exceed 100% (confirmed against live data: e.g. a real venue with
    total_youth=221 but completed=306 across its 4 weeks)."""
    def side_effect(sql, params, role):
        if "GROUP BY venue, district" in sql:
            return [{
                "venue": "Bugadde primary school", "district": "MAYUGE",
                "total_reports": 451, "total_youth": 221,
                "below": 255, "meet": 51, "exceed": 0, "completed": 306,
                "weeks_reported": 4,
            }]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/milestones")
    assert r.status_code == 200
    v = r.json()["by_venue"][0]
    assert v["completion_pct"] == round(100 * 306 / 451, 1)
    assert v["completion_pct"] < 100
    assert v["avg_youth_per_week"] == round(221 / 4, 1)


def test_milestones_uses_bootcamp_cycle_not_cohort_column(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    r = as_staff.get("/api/implementation/milestones", params={"cohort": "BOOTCAMP_4"})
    assert r.status_code == 200
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert "bootcamp_cycle" in all_sql
    assert "COALESCE(cohort," not in all_sql


def test_milestones_no_not_test_data_filter(as_staff, mock_run_query):
    """eba_bootcamp_business_plan_reports has no is_test_data column --
    splicing in NOT_TEST_DATA (used by every other endpoint in this router
    via _filter_extra) would break the query."""
    mock_run_query.set_rows([])
    as_staff.get("/api/implementation/milestones")
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert "is_test_data" not in all_sql


def test_milestones_accepts_district_gender_venue(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    r = as_staff.get(
        "/api/implementation/milestones",
        params={"district": "BUGIRI", "gender": "FEMALE", "venue": "Bugiri primary school"},
    )
    assert r.status_code == 200
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert "youth_district" in all_sql
    assert "youth_gender" in all_sql
    assert "venue_name" in all_sql


def test_milestones_does_not_default_to_active_cohorts(as_staff, mock_run_query):
    """No BOOTCAMP_5 rows exist in this table yet -- defaulting to
    ACTIVE_COHORTS (like most of this dashboard) would show nothing. With no
    cohort param, the query must carry no bootcamp_cycle restriction at all,
    not silently narrow to BC4/BC5. by_cohort_week is excluded from this
    join -- it legitimately SELECTs bootcamp_cycle as its own grouping
    dimension (see test_milestones_by_cohort_week_ignores_selected_cohort_filter
    for the WHERE-clause-specific check on that query)."""
    mock_run_query.set_rows([])
    as_staff.get("/api/implementation/milestones")
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls if "GROUP BY cohort, week_number" not in c["sql"])
    assert "bootcamp_cycle" not in all_sql


def test_milestones_by_district_week_percentages_use_total_youth(as_staff, mock_run_query):
    """Unlike by_venue (cumulative across weeks), by_district_week is already
    single-week grain -- total_youth is a safe same-week denominator here,
    no total_reports correction needed."""
    def side_effect(sql, params, role):
        if "GROUP BY district, week_number" in sql:
            return [{"district": "BUGIRI", "week_number": 1, "total_youth": 1675,
                      "below": 221, "meet": 823, "exceed": 631, "completed": 1675}]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/milestones")
    assert r.status_code == 200
    d = r.json()["by_district_week"][0]
    assert d["exceed_pct"] == round(100 * 631 / 1675, 1)
    assert d["completion_pct"] == 100.0


def test_milestones_by_venue_week_shape_and_percentages(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if "GROUP BY venue, district, week_number" in sql:
            return [{"venue": "Nkaiza Primary school", "district": "BUGIRI", "week_number": 1,
                      "total_youth": 86, "below": 0, "meet": 6, "exceed": 80, "completed": 86}]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/milestones")
    assert r.status_code == 200
    v = r.json()["by_venue_week"][0]
    assert v["venue"] == "Nkaiza Primary school"
    assert v["exceed_pct"] == round(100 * 80 / 86, 1)
    assert v["completion_pct"] == 100.0


def test_milestones_district_week_and_venue_week_zero_total_youth_returns_null_pct(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if "GROUP BY district, week_number" in sql:
            return [{"district": "BUGIRI", "week_number": 1, "total_youth": 0, "below": 0, "meet": 0, "exceed": 0, "completed": 0}]
        if "GROUP BY venue, district, week_number" in sql:
            return [{"venue": "V", "district": "BUGIRI", "week_number": 1, "total_youth": 0, "below": 0, "meet": 0, "exceed": 0, "completed": 0}]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/milestones")
    assert r.json()["by_district_week"][0]["exceed_pct"] is None
    assert r.json()["by_venue_week"][0]["completion_pct"] is None


def test_milestones_by_gender_week_shape_and_percentages(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if "GROUP BY gender, week_number" in sql:
            return [{"gender": "FEMALE", "week_number": 1, "total_youth": 100,
                      "below": 10, "meet": 40, "exceed": 50, "completed": 100}]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/milestones")
    assert r.status_code == 200
    g = r.json()["by_gender_week"][0]
    assert g["gender"] == "FEMALE"
    assert g["exceed_pct"] == 50.0
    assert g["completion_pct"] == 100.0


def test_milestones_by_gender_week_respects_cohort_filter(as_staff, mock_run_query):
    """Unlike by_cohort_week, by_gender_week feeds the weekly performance
    chart's drill and so must stay scoped to whatever cohort the page filter
    has selected."""
    mock_run_query.set_rows([])
    as_staff.get("/api/implementation/milestones", params={"cohort": "BOOTCAMP_4"})
    gender_week_sql = next(c["sql"] for c in mock_run_query.calls if "GROUP BY gender, week_number" in c["sql"])
    assert "bootcamp_cycle" in gender_week_sql


def test_milestones_by_cohort_week_shape_and_percentages(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if "GROUP BY cohort, week_number" in sql:
            return [{"cohort": "BOOTCAMP_4", "week_number": 1, "total_youth": 2737,
                      "below": 386, "meet": 1388, "exceed": 963, "completed": 2737}]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/milestones")
    assert r.status_code == 200
    c = r.json()["by_cohort_week"][0]
    assert c["cohort"] == "BOOTCAMP_4"
    assert c["exceed_pct"] == round(100 * 963 / 2737, 1)
    assert c["meet_pct"] == round(100 * 1388 / 2737, 1)


def test_milestones_accepts_date_range(as_staff, mock_run_query):
    """start_date/end_date filter on created_at (the report's own submission
    timestamp) -- confirmed live to be present on every row -- not the
    derived week_number, applied to every grain this endpoint returns."""
    mock_run_query.set_rows([])
    r = as_staff.get(
        "/api/implementation/milestones",
        params={"start_date": "2026-01-01", "end_date": "2026-01-31"},
    )
    assert r.status_code == 200
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert "DATE(created_at) >=" in all_sql
    assert "DATE(created_at) <=" in all_sql
    all_params = [p for c in mock_run_query.calls for p in c["params"]]
    assert any(getattr(p, "name", "").endswith("_start_date") and p.value == "2026-01-01" for p in all_params)
    assert any(getattr(p, "name", "").endswith("_end_date") and p.value == "2026-01-31" for p in all_params)


def test_milestones_date_range_is_optional(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    as_staff.get("/api/implementation/milestones")
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert "created_at" not in all_sql


def test_milestones_by_cohort_week_ignores_selected_cohort_filter(as_staff, mock_run_query):
    """by_cohort_week's whole purpose is comparing cohorts against each other
    -- it must never be narrowed to whichever single cohort the page filter
    has selected, unlike every other grain this endpoint returns. (The SELECT
    clause always projects `bootcamp_cycle AS cohort`, so this checks the
    WHERE-clause parameter, not just the substring "bootcamp_cycle".)"""
    mock_run_query.set_rows([])
    as_staff.get("/api/implementation/milestones", params={"cohort": "BOOTCAMP_4"})
    call = next(c for c in mock_run_query.calls if "GROUP BY cohort, week_number" in c["sql"])
    assert "@mscw_cohort" not in call["sql"]
    assert not any(getattr(p, "name", "") == "mscw_cohort" for p in call["params"])


# --- Mobilisation date range filter -----------------------------------------
# date_from/date_to filter every OBSERVED figure (call_date on
# DAILY_ACQUISITION_SUMMARY/ACQUISITION_CALL_LOG, report_date on AWARENESS_KYC
# for the auto-confirm pathway, date_added on CONTROL_CALLS_BC4, created_at on
# BC5_ACQUISITION_CALLS) -- never a static target/planning snapshot
# (DAILY_ACQUISITION_TARGETS_DEDUPED, PARISH_TARGETS_BC5), which has no date
# column to filter by. See _date_extra, recruitment.py.

def test_mobilisation_blends_online_and_offline_for_headline(as_staff, mock_run_query):
    # Both channels (collection_type = ONLINE_COLLECTION_TYPE / OFFLINE_
    # COLLECTION_TYPE) now have their own genuine reached/confirmed pair
    # (confirmed live, 2026-08-08, after an upstream data-model change --
    # Offline's total_youth_reached used to always be 0, which made summing
    # it into Confirmed alone produce Confirmed > Reached, mobilisation_rate
    # >100%, reproduced live under that earlier shape). "Mobilisation"
    # (four_week) is now just their plain sum on both reached and confirmed.
    def side_effect(sql, params, role):
        if "online_reached" in sql:
            return [{"online_reached": 800, "online_confirmed": 700, "offline_reached": 320, "offline_confirmed": 300}]
        if "online_confirmed_female" in sql:
            return [{"online_confirmed_female": 400, "offline_confirmed_female": 50}]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/recruitment/mobilisation", params={"cohort": "BOOTCAMP_5"})
    assert r.status_code == 200
    body = r.json()
    # Blended headline: reached = 800+320, confirmed = 700+300 -- always sane
    # since each channel individually has confirmed <= reached.
    assert body["reached"] == 1120
    assert body["confirmed"] == 1000
    assert body["mobilisation_rate"] == round(100 * 1000 / 1120, 1)
    assert body["confirmed_female"] == 450  # 400 online + 50 offline, blended
    # Pure per-channel breakdowns, for the Online vs Offline drill-down.
    assert body["online"]["reached"] == 800
    assert body["online"]["confirmed"] == 700
    assert body["online"]["mobilisation_rate"] == 87.5
    assert body["online"]["pct_female"] == round(100 * 400 / 700, 1)
    assert body["offline"]["reached"] == 320
    assert body["offline"]["confirmed"] == 300
    assert body["offline"]["mobilisation_rate"] == round(100 * 300 / 320, 1)
    assert body["offline"]["pct_female"] == round(100 * 50 / 300, 1)
    # Neither channel has its own Assigned/preload list (None, not 0).
    assert body["online"]["assigned"] is None
    assert body["offline"]["assigned"] is None
    # Share uses the PURE per-channel confirmed (700/300), not the blended 1000.
    assert body["online_offline_share"]["online_confirmed"] == 700
    assert body["online_offline_share"]["offline_confirmed"] == 300
    assert body["online_offline_share"]["online_pct"] == 70.0
    assert body["online_offline_share"]["offline_pct"] == 30.0
    # combined.total_so_far sums PURE online + auto-confirm pilot + offline
    # (700+0+300), not the blended four_week["confirmed"] (which would
    # double-count Offline).
    assert body["combined"]["call_centre_confirmed"] == 700
    assert body["combined"]["offline_confirmed"] == 300
    assert body["combined"]["total_so_far"] == 1000


def test_mobilisation_accepts_date_range(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    r = as_staff.get(
        "/api/recruitment/mobilisation",
        params={"date_from": "2026-01-01", "date_to": "2026-01-31"},
    )
    assert r.status_code == 200
    actual_call = next(c for c in mock_run_query.calls if "online_reached" in c["sql"])
    assert "call_date >=" in actual_call["sql"]
    assert "call_date <=" in actual_call["sql"]
    called_call = next(c for c in mock_run_query.calls if "COUNT(DISTINCT youth_id) AS n" in c["sql"])
    assert "call_date >=" in called_call["sql"]
    auto_call = next(c for c in mock_run_query.calls if "report_date >= @acfd_since" in c["sql"])
    assert "report_date >=" in auto_call["sql"] and "@acfd_from" in auto_call["sql"]
    preload_call = next(c for c in mock_run_query.calls if "SUM(preload_youth) AS assigned" in c["sql"])
    assert "call_date" not in preload_call["sql"]


def test_mobilisation_date_range_is_optional(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    as_staff.get("/api/recruitment/mobilisation")
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert "call_date" not in all_sql


def test_mobilisation_heatmap_accepts_date_range(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    r = as_staff.get(
        "/api/recruitment/mobilisation-heatmap",
        params={"date_from": "2026-01-01", "date_to": "2026-01-31"},
    )
    assert r.status_code == 200
    actual_call = next(c for c in mock_run_query.calls if "SUM(total_youth_reached) AS online_reached, SUM(total_acquired_youth) AS online_confirmed" in c["sql"])
    assert "call_date >=" in actual_call["sql"] and "call_date <=" in actual_call["sql"]
    targets_call = next(c for c in mock_run_query.calls if "SUM(preload_youth) AS assigned, SUM(mobilisation_target) AS target" in c["sql"] and "GROUP BY district\n" in c["sql"])
    assert "call_date" not in targets_call["sql"]


def test_mobilisation_heatmap_date_range_is_optional(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    as_staff.get("/api/recruitment/mobilisation-heatmap")
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert "call_date" not in all_sql


def test_mobilisation_heatmap_merges_offline_into_venue_and_parish(as_staff, mock_run_query):
    # Offline rows (collection_type = OFFLINE_COLLECTION_TYPE) never have
    # venue_parish populated, so they can't join by_venue_sql/parish_actual_sql
    # directly -- queried separately by venue name, then merged in via
    # venue_to_parish (built from targets_by_venue) so Mobilisation progress
    # at parish/venue grain includes both acquisition channels.
    # cohort=BOOTCAMP_4 sidesteps the BC5-only PARISH_TARGETS_BC5 branches.
    def side_effect(sql, params, role):
        if "GROUP BY district, parish, venue" in sql:
            return [{"district": "TESTDISTRICT", "parish": "TESTPARISH", "venue": "TEST SCHOOL", "assigned": 10, "target": 20}]
        if "collection_type = 'OFFLINE'" in sql:
            return [{"venue": "TEST SCHOOL", "offline_reached": 5, "offline_confirmed": 4, "offline_confirmed_female": 2}]
        if "GROUP BY parish, venue" in sql:
            return [{"parish": "TESTPARISH", "venue": "TEST SCHOOL", "online_reached": 10, "online_confirmed": 8, "online_confirmed_female": 3}]
        if "GROUP BY parish\n" in sql:
            return [{"parish": "TESTPARISH", "online_reached": 10, "online_confirmed": 8, "online_confirmed_female": 3}]
        if "GROUP BY district, parish" in sql:
            return [{"district": "TESTDISTRICT", "parish": "TESTPARISH", "assigned": 10, "target": 20}]
        if "GROUP BY district\n" in sql:
            return [{"district": "TESTDISTRICT", "assigned": 10, "target": 20}]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/recruitment/mobilisation-heatmap", params={"cohort": "BOOTCAMP_4"})
    assert r.status_code == 200
    body = r.json()
    venue = next(v for v in body["by_venue"] if v["venue"] == "TEST SCHOOL")
    assert venue["reached"] == 15  # 10 online + 5 offline
    assert venue["confirmed"] == 12  # 8 online + 4 offline
    assert venue["online_reached"] == 10 and venue["offline_reached"] == 5
    assert venue["online_confirmed"] == 8 and venue["offline_confirmed"] == 4
    parish = next(p for p in body["by_parish"] if p["parish"] == "TESTPARISH")
    assert parish["call_centre_reached"] == 15
    assert parish["call_centre_confirmed"] == 12
    assert parish["online_reached"] == 10 and parish["offline_reached"] == 5
    assert parish["online_confirmed"] == 8 and parish["offline_confirmed"] == 4
    district = next(d for d in body["by_district"] if d["district"] == "TESTDISTRICT")
    assert district["online_reached"] == 10 and district["offline_reached"] == 5
    assert district["online_confirmed"] == 8 and district["offline_confirmed"] == 4


def test_mobilisation_heatmap_offline_merge_does_not_mutate_cached_rows(as_staff, mock_run_query):
    # database.run_query's cache can hand back the EXACT row objects from a
    # previous call (see cache.py) -- the offline merge above must never
    # mutate those in place, or repeated requests (e.g. two page views
    # hitting a warm cache) would compound Offline's numbers on top of
    # themselves every time. Reproduced live, 2026-08-08: reached/confirmed
    # climbed on every repeated request until this was fixed. Same fixed
    # dict objects returned on every call here, simulating a cache hit.
    online_venue_row = {"parish": "TESTPARISH", "venue": "TEST SCHOOL", "online_reached": 10, "online_confirmed": 8, "online_confirmed_female": 3}
    online_parish_row = {"parish": "TESTPARISH", "online_reached": 10, "online_confirmed": 8, "online_confirmed_female": 3}
    offline_row = {"venue": "TEST SCHOOL", "offline_reached": 5, "offline_confirmed": 4, "offline_confirmed_female": 2}

    def side_effect(sql, params, role):
        if "GROUP BY district, parish, venue" in sql:
            return [{"district": "TESTDISTRICT", "parish": "TESTPARISH", "venue": "TEST SCHOOL", "assigned": 10, "target": 20}]
        if "collection_type = 'OFFLINE'" in sql:
            return [offline_row]
        if "GROUP BY parish, venue" in sql:
            return [online_venue_row]
        if "GROUP BY parish\n" in sql:
            return [online_parish_row]
        if "GROUP BY district, parish" in sql:
            return [{"district": "TESTDISTRICT", "parish": "TESTPARISH", "assigned": 10, "target": 20}]
        if "GROUP BY district\n" in sql:
            return [{"district": "TESTDISTRICT", "assigned": 10, "target": 20}]
        return []
    mock_run_query.set_side_effect(side_effect)

    for _ in range(2):
        r = as_staff.get("/api/recruitment/mobilisation-heatmap", params={"cohort": "BOOTCAMP_4"})
        assert r.status_code == 200
        body = r.json()
        venue = next(v for v in body["by_venue"] if v["venue"] == "TEST SCHOOL")
        assert venue["reached"] == 15  # always 10 online + 5 offline, never climbing
        assert venue["confirmed"] == 12
        parish = next(p for p in body["by_parish"] if p["parish"] == "TESTPARISH")
        assert parish["call_centre_reached"] == 15
        assert parish["call_centre_confirmed"] == 12
    # The "cached" row objects themselves must be untouched, not just the
    # response -- proves the fix rebuilds dicts instead of mutating in place.
    assert online_venue_row["online_reached"] == 10
    assert online_parish_row["online_reached"] == 10


def test_mobilisation_forecast_accepts_date_range(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    r = as_staff.get(
        "/api/recruitment/mobilisation-forecast",
        params={"date_from": "2026-01-01", "date_to": "2026-01-31"},
    )
    assert r.status_code == 200
    daily_call = next(c for c in mock_run_query.calls if "call_date AS event_date" in c["sql"])
    assert "call_date >=" in daily_call["sql"] and "call_date <=" in daily_call["sql"]
    target_call = next(c for c in mock_run_query.calls if "SUM(mobilisation_target) AS t" in c["sql"])
    assert "call_date" not in target_call["sql"]


def test_mobilisation_forecast_date_range_is_optional(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    as_staff.get("/api/recruitment/mobilisation-forecast")
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls if "call_date AS event_date" in c["sql"])
    assert "call_date >=" not in all_sql


def test_control_calls_accepts_date_range(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    r = as_staff.get(
        "/api/recruitment/control-calls",
        params={"date_from": "2026-01-01", "date_to": "2026-01-31"},
    )
    assert r.status_code == 200
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert all_sql.count("DATE(date_added) >=") == 3
    assert all_sql.count("DATE(date_added) <=") == 3


def test_control_calls_date_range_is_optional(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    as_staff.get("/api/recruitment/control-calls")
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert "date_added" not in all_sql


def test_call_centre_insights_accepts_date_range(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    r = as_staff.get(
        "/api/recruitment/call-centre-insights",
        params={"date_from": "2026-01-01", "date_to": "2026-01-31"},
    )
    assert r.status_code == 200
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert all_sql.count("DATE(created_at) >=") == 7
    assert all_sql.count("DATE(created_at) <=") == 7


def test_call_centre_insights_date_range_is_optional(as_staff, mock_run_query):
    # date_from is genuinely optional, but date_to is always applied (capped
    # at LAST_ACQUISITION_CALL_DATE) even with no params at all -- see
    # test_call_centre_insights_caps_date_to_at_last_acquisition_call_date.
    mock_run_query.set_rows([])
    as_staff.get("/api/recruitment/call-centre-insights")
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert "DATE(created_at) >=" not in all_sql
    assert all_sql.count("DATE(created_at) <=") == 7


def test_call_centre_insights_caps_date_to_at_last_acquisition_call_date(as_staff, mock_run_query):
    # The call-centre team switched to QA calling the day after
    # LAST_ACQUISITION_CALL_DATE -- a caller asking for a later date_to must
    # not pull QA-period rows into this page's acquisition-outcome metrics.
    mock_run_query.set_rows([])
    as_staff.get("/api/recruitment/call-centre-insights", params={"date_to": "2026-12-31"})
    all_params = [p for c in mock_run_query.calls for p in c["params"]]
    assert any(getattr(p, "name", "").endswith("_to") and p.value == LAST_ACQUISITION_CALL_DATE for p in all_params)
    assert not any(getattr(p, "name", "").endswith("_to") and p.value == "2026-12-31" for p in all_params)


# qa_calls() is backed by a wholly separate pipeline from BC5_ACQUISITION_
# CALLS (QUALITY_ASSURANCE_BC5, a pre-aggregated gold rollup with no date
# column) -- unlike every other Mobilisation sub-page, it takes no date range.

def test_qa_calls_no_date_range_params(as_staff, mock_run_query):
    # Passing date_from/date_to (as every other Mobilisation sub-page accepts)
    # must have no effect -- every filter here is a hardcoded literal
    # (bootcamp_cycle, measure), never a bound query parameter.
    mock_run_query.set_rows([])
    r = as_staff.get("/api/recruitment/qa-calls", params={"date_from": "2026-01-01", "date_to": "2026-01-31"})
    assert r.status_code == 200
    all_params = [p for c in mock_run_query.calls for p in c["params"]]
    assert not all_params
    assert r.json()["since"] == QA_CALLS_START_DATE


def test_qa_calls_filters_cumulative_measure_not_daily(as_staff, mock_run_query):
    # QUALITY_ASSURANCE_BC5 carries a 'daily' row per venue x call_date
    # summing to the SAME totals as 'cumulative' -- every aggregate query here
    # must filter to 'cumulative' or it silently doubles every number.
    mock_run_query.set_rows([])
    as_staff.get("/api/recruitment/qa-calls")
    aggregate_calls = [c["sql"] for c in mock_run_query.calls if QUALITY_ASSURANCE_BC5 in c["sql"] and "call_date AS date" not in c["sql"]]
    assert aggregate_calls, "expected at least one aggregate query against the gold rollup"
    for sql in aggregate_calls:
        assert f"measure = '{QA_MEASURE_CUMULATIVE}'" in sql
    daily_calls = [c["sql"] for c in mock_run_query.calls if "call_date AS date" in c["sql"]]
    assert daily_calls
    for sql in daily_calls:
        assert f"measure = '{QA_MEASURE_DAILY}'" in sql


def test_qa_calls_shape_and_rates(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        # Unique to totals_sql -- district_sql also selects called/attempts.
        if "SUM(total_call_status_no_answer)" in sql:
            return [{
                "attempts": 100, "called": 80, "reached": 60, "unique_reached": 50,
                "confirmed": 40, "no_youth": 8, "maybe_youth": 2, "name_matches": 45,
                "no_answer": 30, "phone_off": 5, "call_back": 3, "busy": 1,
                "rejected": 1, "wrong_number": 0, "hung_up": 0,
            }]
        if "support_needed AS note" in sql:
            return [{"note": "she is still studying"}, {"note": "none"}]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/recruitment/qa-calls")
    assert r.status_code == 200
    body = r.json()
    assert body["calls_analysed"] == 100
    assert body["youth_called"] == 80
    assert body["reached"] == 60
    # reach_rate is unique_reached / called (per-youth), not reached / attempts.
    assert body["reach_rate"] == 62.5
    assert body["unique_reached"] == 50
    # Confirmed/No/Maybe are shares of unique_reached (40+8+2 == 50 exactly).
    assert body["confirmed"] == 40
    assert body["identity_confirmed_rate"] == 80.0
    by_status = {o["status"]: o for o in body["confirmation_outcome"]}
    assert by_status["Confirmed"]["count"] == 40
    assert by_status["No"]["pct"] == 16.0
    # Name match is a share of reached (call-attempt grain), not unique_reached.
    assert body["name_match_rate"] == 75.0
    name_by_status = {o["status"]: o for o in body["name_breakdown"]}
    assert name_by_status["Matches"]["count"] == 45
    assert name_by_status["Not matched"]["count"] == 15
    assert [o["status"] for o in body["call_outcomes"]][0] == "Reached"
    assert body["support_needed"]["n"] == 2
    assert "she is still studying" in [q.lower() for q in body["support_needed"]["quotes"]]


def test_qa_calls_breakdowns_by_district_venue_gender_and_daily(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        # Unique to totals_sql -- district_sql also selects called/attempts.
        if "SUM(total_call_status_no_answer)" in sql:
            return [{"attempts": 100, "called": 80, "reached": 60, "unique_reached": 50, "confirmed": 40, "name_matches": 45}]
        # Check venue_sql before district_sql -- venue_sql also selects
        # "youth_district AS district" (as a second column), so it would
        # otherwise match the district branch first.
        if "venue_name AS venue" in sql:
            return [
                {"venue": "High Mismatch School", "district": "MAYUGE", "reached": 20, "name_matches": 5},
                {"venue": "Low Mismatch School", "district": "IGANGA", "reached": 20, "name_matches": 19},
            ]
        if "youth_district AS district" in sql:
            return [
                {"district": "MAYUGE", "attempts": 60, "called": 50, "reached": 40, "unique_reached": 35, "confirmed": 30, "name_matches": 32},
                {"district": "IGANGA", "attempts": 40, "called": 30, "reached": 20, "unique_reached": 15, "confirmed": 10, "name_matches": 13},
            ]
        if "total_call_status_reached_female" in sql:
            return [{
                "reached_f": 40, "reached_m": 20, "unique_reached_f": 32, "unique_reached_m": 18,
                "confirmed_f": 28, "confirmed_m": 12, "name_matches_f": 30, "name_matches_m": 15,
            }]
        if "call_date AS date" in sql:
            return [{"date": "2026-08-07", "called": 50, "reached": 30}]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/recruitment/qa-calls")
    assert r.status_code == 200
    body = r.json()

    by_district = {d["district"]: d for d in body["by_district"]}
    # reach_rate is unique_reached / called (per-youth), not reached / attempts.
    assert by_district["MAYUGE"]["reach_rate"] == round(100 * 35 / 50, 1)
    assert by_district["MAYUGE"]["identity_confirmed_rate"] == round(100 * 30 / 35, 1)

    # Sorted by name_mismatch_rate DESCENDING -- worst venue first.
    assert body["by_venue"][0]["venue"] == "High Mismatch School"
    assert body["by_venue"][0]["name_mismatches"] == 15
    assert body["by_venue"][1]["venue"] == "Low Mismatch School"

    by_gender = {g["gender"]: g for g in body["by_gender"]}
    assert by_gender["Female"]["identity_confirmed_rate"] == round(100 * 28 / 32, 1)
    assert by_gender["Male"]["name_match_rate"] == round(100 * 15 / 20, 1)

    assert body["daily"][0]["date"] == "2026-08-07"
    assert body["daily"][0]["called"] == 50
    assert body["daily"][0]["reached"] == 30


# --- Attendance ---------------------------------------------------------------
# ATTENDANCE_SUMMARY carries two `measure` values sharing the same total_youths_
# present column ('attendance' = real daily actuals; 'attendance_targets' = a
# separate, overlapping-date mart that also populates total_youths_present
# against a target) -- confirmed live 2026-08-07. The original query filtered
# on neither, silently double-counting any venue-day with rows in both.

def test_attendance_daily_filters_to_attendance_measure(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    as_staff.get("/api/implementation/attendance")
    daily_call = next(c for c in mock_run_query.calls if "GROUP BY event_date" in c["sql"])
    assert "measure = 'attendance'" in daily_call["sql"]
    assert "attendance_targets" not in daily_call["sql"]


def test_attendance_venue_avg_filters_to_attendance_measure(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    as_staff.get("/api/implementation/attendance")
    venue_call = next(c for c in mock_run_query.calls if "AVG(total_youths_present)" in c["sql"])
    assert "measure = 'attendance'" in venue_call["sql"]


def test_attendance_daily_includes_gender_and_absent_counts(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if "GROUP BY event_date" in sql:
            return [{
                "event_date": "2026-05-30", "present": 100, "absent": 10,
                "present_female": 60, "present_male": 40,
                "absent_female": 6, "absent_male": 4, "net_churn": 2,
            }]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/attendance")
    assert r.status_code == 200
    d = r.json()["daily"][0]
    assert d["present_female"] == 60
    assert d["present_male"] == 40
    assert d["absent"] == 10
    assert d["absent_female"] == 6
    assert d["absent_male"] == 4


def test_attendance_by_venue_gender_rate(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if "AVG(total_youths_present)" in sql:
            return [{"venue": "Bugiri primary school", "present": 80, "present_female": 50, "present_male": 30}]
        if "SUM(activated_youth) AS activated" in sql:
            return [{
                "district": "BUGIRI", "venue": "Bugiri primary school",
                "activated": 100, "activated_female": 60, "activated_male": 40,
            }]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/attendance")
    assert r.status_code == 200
    v = r.json()["by_venue"][0]
    assert v["attendance_rate"] == 80.0
    assert v["attendance_rate_female"] == round(100 * 50 / 60, 1)
    assert v["attendance_rate_male"] == 75.0


def test_attendance_by_venue_rate_capped_at_100(as_staff, mock_run_query):
    """Confirmed live: a handful of venues have ATTENDANCE_SUMMARY's present
    exceed SITE_FUNNEL_METRICS' activated_youth by 1-2 youth (a snapshot-
    timing gap between the two marts, not a query bug) -- the raw present
    count stays real, but the rendered rate must never exceed 100%."""
    def side_effect(sql, params, role):
        if "AVG(total_youths_present)" in sql:
            return [{"venue": "Nabukima church of God", "present": 41, "present_female": 23, "present_male": 18}]
        if "SUM(activated_youth) AS activated" in sql:
            return [{
                "district": "BUGIRI", "venue": "Nabukima church of God",
                "activated": 40, "activated_female": 22, "activated_male": 18,
            }]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/attendance")
    v = r.json()["by_venue"][0]
    assert v["present"] == 41.0  # raw present stays real, uncapped
    assert v["attendance_rate"] == 100.0
    assert v["attendance_rate_female"] == 100.0
    assert v["attendance_rate_male"] == 100.0


def test_attendance_by_venue_day_shape_and_rates(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if "SELECT venue_name AS venue, report_date AS event_date" in sql:
            return [{"venue": "Bugiri primary school", "event_date": "2026-05-30", "present": 90, "present_female": 55, "present_male": 35}]
        if "SUM(activated_youth) AS activated" in sql:
            return [{
                "district": "BUGIRI", "venue": "Bugiri primary school",
                "activated": 100, "activated_female": 60, "activated_male": 40,
            }]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/attendance")
    assert r.status_code == 200
    v = r.json()["by_venue_day"][0]
    assert v["district"] == "BUGIRI"
    assert v["event_date"] == "2026-05-30"
    assert v["attendance_rate"] == 90.0
    assert v["activated_female"] == 60
    assert v["attendance_rate_female"] == round(100 * 55 / 60, 1)
    assert v["activated_male"] == 40
    assert v["attendance_rate_male"] == round(100 * 35 / 40, 1)


def test_attendance_by_venue_day_skips_venues_with_no_activated_match(as_staff, mock_run_query):
    """A venue-day row with no matching SITE_FUNNEL_METRICS activated row
    (e.g. a genuinely different program's venue, or a casing mismatch that
    normalisation still can't resolve) has no real denominator to compute a
    rate against, so it's dropped rather than shown with activated=0."""
    def side_effect(sql, params, role):
        if "SELECT venue_name AS venue, report_date AS event_date" in sql:
            return [{"venue": "Unmapped Venue", "event_date": "2026-05-30", "present": 10, "present_female": 5, "present_male": 5}]
        if "SUM(activated_youth) AS activated" in sql:
            return []
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/attendance")
    assert r.json()["by_venue_day"] == []


def test_attendance_accepts_district_filter(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    r = as_staff.get("/api/implementation/attendance", params={"district": "BUGIRI"})
    assert r.status_code == 200
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert "youth_district" in all_sql  # ATTENDANCE_SUMMARY-based queries
    assert "UPPER(district) AS district" in all_sql  # SITE_FUNNEL_METRICS query


def test_attendance_gender_filter_picks_headline_without_collapsing_split(as_staff, mock_run_query):
    """gender=FEMALE should make the headline present/activated/attendance_rate
    reflect female-only numbers, but attendance_rate_male must stay real and
    non-zero -- gender is never a WHERE filter here (see _attendance_pick's
    docstring), so the male side is never collapsed to zero by the filter."""
    def side_effect(sql, params, role):
        if "AVG(total_youths_present)" in sql:
            return [{"venue": "Bugiri primary school", "present": 80, "present_female": 50, "present_male": 30}]
        if "SUM(activated_youth) AS activated" in sql:
            return [{
                "district": "BUGIRI", "venue": "Bugiri primary school",
                "activated": 100, "activated_female": 60, "activated_male": 40,
            }]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/attendance", params={"gender": "FEMALE"})
    assert r.status_code == 200
    v = r.json()["by_venue"][0]
    assert v["activated"] == 60
    assert v["present"] == 50.0
    assert v["attendance_rate"] == round(100 * 50 / 60, 1)
    # Male-side split numbers must remain real, not collapsed by the filter.
    assert v["attendance_rate_male"] == 75.0


def test_attendance_accepts_date_range(as_staff, mock_run_query):
    """date_from/date_to filter report_date on the ATTENDANCE_SUMMARY-based
    queries (daily/venue-avg/venue-day) -- never on the SITE_FUNNEL_METRICS
    activated query, which has no date column."""
    mock_run_query.set_rows([])
    r = as_staff.get("/api/implementation/attendance", params={"date_from": "2026-05-01", "date_to": "2026-05-31"})
    assert r.status_code == 200
    daily_call = next(c for c in mock_run_query.calls if "GROUP BY event_date" in c["sql"])
    assert "report_date >=" in daily_call["sql"]
    assert "report_date <=" in daily_call["sql"]
    venue_call = next(c for c in mock_run_query.calls if "AVG(total_youths_present)" in c["sql"])
    assert "report_date >=" in venue_call["sql"]
    activated_call = next(c for c in mock_run_query.calls if "SUM(activated_youth) AS activated" in c["sql"])
    assert "report_date" not in activated_call["sql"]


def test_attendance_date_range_is_optional(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    r = as_staff.get("/api/implementation/attendance")
    assert r.status_code == 200
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert "report_date >=" not in all_sql
    assert "report_date <=" not in all_sql


def test_attendance_lessons_by_lesson_computes_rates(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if "GROUP BY lesson_id, lesson_name, lesson_time" in sql:
            return [{
                "lesson_id": "L1", "lesson_name": "Planning to Earn", "lesson_time": "Morning",
                "total": 100, "present": 92, "total_reports": 10, "timely_reports": 7,
            }]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/attendance-lessons")
    assert r.status_code == 200
    lesson = r.json()["by_lesson"][0]
    assert lesson["attendance_rate"] == 92.0
    assert lesson["timely_rate"] == 70.0


def test_attendance_lessons_by_session_splits_morning_afternoon(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if "GROUP BY lesson_time" in sql:
            return [
                {"lesson_time": "Morning", "total": 100, "present": 95, "total_reports": 10, "timely_reports": 9},
                {"lesson_time": "Afternoon", "total": 80, "present": 60, "total_reports": 8, "timely_reports": 4},
            ]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/attendance-lessons")
    assert r.status_code == 200
    by_session = {s["lesson_time"]: s for s in r.json()["by_session"]}
    assert by_session["Morning"]["attendance_rate"] == 95.0
    assert by_session["Morning"]["timely_rate"] == 90.0
    assert by_session["Afternoon"]["attendance_rate"] == 75.0
    assert by_session["Afternoon"]["timely_rate"] == 50.0


def test_attendance_lessons_timely_report_sql_uses_kampala_cutoffs(as_staff, mock_run_query):
    """Morning reports are timely before 12:00 noon LOCAL time, Afternoon
    reports at/before 17:00 LOCAL -- submission_time is stored UTC, so the
    comparison must convert to Africa/Kampala first, not compare raw UTC
    clock time against the literal cutoffs."""
    mock_run_query.set_rows([])
    as_staff.get("/api/implementation/attendance-lessons")
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert "Africa/Kampala" in all_sql
    assert "TIME(12, 0, 0)" in all_sql
    assert "TIME(17, 0, 0)" in all_sql


def test_attendance_lessons_by_reporter_ranks_timeliness(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if "SELECT report_created_by AS reporter" in sql:
            return [
                {"reporter": "user_abc", "total_reports": 20, "timely_reports": 5},
                {"reporter": "user_xyz", "total_reports": 10, "timely_reports": 10},
            ]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/attendance-lessons")
    assert r.status_code == 200
    by_reporter = {row["reporter"]: row for row in r.json()["by_reporter"]}
    assert by_reporter["user_abc"]["timely_rate"] == 25.0
    assert by_reporter["user_xyz"]["timely_rate"] == 100.0


def test_attendance_lessons_by_lesson_venue_drill_shape(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if "GROUP BY lesson_id, lesson_name, lesson_time, district, venue" in sql:
            return [{
                "lesson_id": "L1", "lesson_name": "Planning to Earn", "lesson_time": "Morning",
                "district": "BUGIRI", "venue": "Bugiri primary school",
                "total": 40, "present": 36, "total_reports": 4, "timely_reports": 3,
            }]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/attendance-lessons")
    assert r.status_code == 200
    row = r.json()["by_lesson_venue"][0]
    assert row["district"] == "BUGIRI"
    assert row["venue"] == "Bugiri primary school"
    assert row["attendance_rate"] == 90.0
    assert row["timely_rate"] == 75.0


def test_attendance_lessons_accepts_district_gender_venue_filters(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    r = as_staff.get(
        "/api/implementation/attendance-lessons",
        params={"district": "BUGIRI", "gender": "FEMALE", "venue": "Bugiri primary school"},
    )
    assert r.status_code == 200
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert "youth_district" in all_sql
    assert "youth_gender" in all_sql
    assert "venue_name" in all_sql


def test_attendance_lessons_accepts_date_range(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    r = as_staff.get(
        "/api/implementation/attendance-lessons",
        params={"date_from": "2026-05-01", "date_to": "2026-05-31"},
    )
    assert r.status_code == 200
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert "report_date >=" in all_sql
    assert "report_date <=" in all_sql


def test_retention_accepts_district_filter(as_staff, mock_run_query):
    """district previously had no effect on this endpoint at all -- it
    accepted no district param, so the global district dropdown silently
    did nothing here."""
    mock_run_query.set_rows([])
    r = as_staff.get("/api/implementation/retention", params={"district": "BUGIRI"})
    assert r.status_code == 200
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
    assert "district" in all_sql


def test_retention_computes_gendered_retention_and_all_sessions_rates(as_staff, mock_run_query):
    """retention_rate is the existing >=80%-of-lessons metric; all_sessions_rate
    is the >=100%-of-lessons metric ("Youth attending sessions" gauges, moved
    here from /api/implementation/attendance since both read the same
    SITE_FUNNEL_METRICS mart). Both need real per-gender denominators
    (activated_female/male), not just the overall rate."""
    mock_run_query.set_rows([{
        "district": "BUGIRI", "venue": "Bugiri primary school",
        "acquired": 120, "activated": 100, "activated_female": 60, "activated_male": 40,
        "retained": 85, "retained_female": 54, "retained_male": 31,
        "all_sessions_count": 70, "all_sessions_count_female": 45, "all_sessions_count_male": 25,
    }])
    r = as_staff.get("/api/implementation/retention")
    assert r.status_code == 200
    v = r.json()["by_venue"][0]
    assert v["retention_rate"] == 85.0
    assert v["retention_rate_female"] == 90.0
    assert v["retention_rate_male"] == round(100 * 31 / 40, 1)
    assert v["all_sessions_rate"] == 70.0
    assert v["all_sessions_rate_female"] == 75.0
    assert v["all_sessions_rate_male"] == round(100 * 25 / 40, 1)
    assert r.json()["targets"]["all_sessions"] == 75


def test_retention_all_sessions_rate_null_when_activated_zero(as_staff, mock_run_query):
    mock_run_query.set_rows([{
        "district": "BUGIRI", "venue": "Empty venue",
        "acquired": 0, "activated": 0, "activated_female": 0, "activated_male": 0,
        "retained": 0, "retained_female": 0, "retained_male": 0,
        "all_sessions_count": 0, "all_sessions_count_female": 0, "all_sessions_count_male": 0,
    }])
    r = as_staff.get("/api/implementation/retention")
    v = r.json()["by_venue"][0]
    assert v["all_sessions_rate"] is None
    assert v["all_sessions_rate_female"] is None
    assert v["retention_rate"] is None


def test_retention_gender_filter_picks_headline_without_collapsing_split(as_staff, mock_run_query):
    """gender=FEMALE should make the headline acquired/activated/retained/
    all_sessions_count (and every rate derived from them) reflect female-only
    numbers, but the male-side raw counts and retention_rate_male/
    all_sessions_rate_male must stay real and non-zero -- gender is never a
    WHERE filter here (site_metrics is venue×gender-grain; WHERE-filtering
    would collapse the other gender's counts to zero)."""
    mock_run_query.set_rows([{
        "district": "BUGIRI", "venue": "Bugiri primary school",
        "acquired": 100, "acquired_female": 60, "acquired_male": 40,
        "activated": 90, "activated_female": 55, "activated_male": 35,
        "retained": 80, "retained_female": 50, "retained_male": 30,
        "all_sessions_count": 60, "all_sessions_count_female": 38, "all_sessions_count_male": 22,
    }])
    r = as_staff.get("/api/implementation/retention", params={"gender": "FEMALE"})
    assert r.status_code == 200
    v = r.json()["by_venue"][0]
    assert v["acquired"] == 60
    assert v["activated"] == 55
    assert v["retained"] == 50
    assert v["all_sessions_count"] == 38
    assert v["activation_rate"] == round(100 * 55 / 60, 1)
    assert v["retention_rate"] == round(100 * 50 / 55, 1)
    # Male-side raw counts and rates must remain real, not collapsed by the filter.
    assert v["activated_male"] == 35
    assert v["retained_male"] == 30
    assert v["retention_rate_male"] == round(100 * 30 / 35, 1)
    assert v["all_sessions_rate_male"] == round(100 * 22 / 35, 1)


def test_retention_rates_capped_at_100(as_staff, mock_run_query):
    """Confirmed live: at least one venue has activated_youth slightly exceed
    acquired_youth (a snapshot-timing gap within SITE_FUNNEL_METRICS itself,
    not a query bug) -- raw counts stay real, but no rendered rate may exceed
    100%."""
    mock_run_query.set_rows([{
        "district": "BUGIRI", "venue": "Bwigula Primary School",
        "acquired": 70, "acquired_female": 40, "acquired_male": 30,
        "activated": 71, "activated_female": 41, "activated_male": 30,
        "retained": 71, "retained_female": 41, "retained_male": 30,
        "all_sessions_count": 71, "all_sessions_count_female": 41, "all_sessions_count_male": 30,
    }])
    r = as_staff.get("/api/implementation/retention")
    v = r.json()["by_venue"][0]
    assert v["activated"] == 71  # raw count stays real, uncapped
    assert v["activation_rate"] == 100.0
    assert v["retention_rate"] == 100.0
    assert v["all_sessions_rate"] == 100.0


def _cycle_param_values(calls, prefix):
    for c in calls:
        for p in c["params"]:
            if getattr(p, "name", "") == f"{prefix}_cycle":
                return list(p.values)
    return None


def test_attendance_defaults_to_bootcamp_4_not_shared_active_cohorts(as_staff, mock_run_query):
    """ACTIVE_COHORTS is shared across every live-table query, but it's
    BOOTCAMP_5-only (Mobilisation/Recruitment closed out BC4 -- confirmed
    live 2026-08-08). ATTENDANCE_SUMMARY/SITE_FUNNEL_METRICS have zero
    BOOTCAMP_5 rows (confirmed live throughout this session), so this
    endpoint must default to ATTENDANCE_MART_COHORTS (BOOTCAMP_4), not fall
    through to the shared ACTIVE_COHORTS default -- that exact regression
    (a separate PR bumping ACTIVE_COHORTS) silently emptied this endpoint."""
    mock_run_query.set_rows([])
    as_staff.get("/api/implementation/attendance")
    for prefix in ("ad", "adv", "advd", "ada"):
        assert _cycle_param_values(mock_run_query.calls, prefix) == ["BOOTCAMP_4"], prefix


def test_attendance_lessons_defaults_to_bootcamp_4(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    as_staff.get("/api/implementation/attendance-lessons")
    assert _cycle_param_values(mock_run_query.calls, "al") == ["BOOTCAMP_4"]


def test_retention_defaults_to_bootcamp_4(as_staff, mock_run_query):
    mock_run_query.set_rows([])
    as_staff.get("/api/implementation/retention")
    assert _cycle_param_values(mock_run_query.calls, "rt") == ["BOOTCAMP_4"]


def test_attendance_by_venue_day_includes_absent_and_net_churn(as_staff, mock_run_query):
    """absent/net_churn are needed so the frontend can recompute a venue-
    filtered Daily attendance/net-churn series -- previously missing from
    by_venue_day entirely, so those two charts stayed unfiltered while every
    other venue-grain visual on the page responded to the local filter."""
    def side_effect(sql, params, role):
        if "SELECT venue_name AS venue, report_date AS event_date" in sql:
            return [{
                "venue": "Bugiri primary school", "event_date": "2026-05-30",
                "present": 90, "present_female": 55, "present_male": 35,
                "absent": 10, "absent_female": 6, "absent_male": 4, "net_churn": -2,
            }]
        if "SUM(activated_youth) AS activated" in sql:
            return [{
                "district": "BUGIRI", "venue": "Bugiri primary school",
                "activated": 100, "activated_female": 60, "activated_male": 40,
            }]
        return []
    mock_run_query.set_side_effect(side_effect)
    r = as_staff.get("/api/implementation/attendance")
    assert r.status_code == 200
    v = r.json()["by_venue_day"][0]
    assert v["absent"] == 10
    assert v["net_churn"] == -2
