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
from app.core.tables import AWARENESS_SUMMARY, AWARENESS_KYC, FUNNEL_STAGES, venue_mobilisation_target, canonical_venue_sql
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


def test_overview_kpis_rates(as_staff, mock_run_query):
    def side_effect(sql, params, role):
        if AWARENESS_KYC in sql:
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
    not silently narrow to BC4/BC5."""
    mock_run_query.set_rows([])
    as_staff.get("/api/implementation/milestones")
    all_sql = " ".join(c["sql"] for c in mock_run_query.calls)
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
