"""
Implementation endpoints — Arrival, Attendance, Retention, Retention Calls,
Trainer Quality, Milestones, Youth Experience (NPS).

Trainer names are masked for the guest role.
"""

from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import current_user, User
from app.core import database  # module import — required for the run_query test seam
from app.core.database import _scalar
from app.core.pii import mask_name, name_from_trainer_key
from app.core.pii import trainer_key as compute_trainer_key
from app.core.sql import build_where, cohort_clause
from app.core.tables import (
    ATTENDANCE_DAILY,
    MILESTONES,
    MILESTONE_PERFORMANCE_CATEGORY_SQL,
    YOUTH_NPS,
    NOT_TEST_DATA,
    SITE_FUNNEL_METRICS,
    SITE_FUNNEL_MEASURE_ACTUAL,
    ATTENDANCE_SUMMARY,
    TRAINER_OBSERVATIONS,
    TRAINER_BC4_START_DATE,
    TRAINER_BC4_END_DATE,
    TRAINER_TOT_START_DATE,
    TRAINER_TOT_END_DATE,
    TRAINER_BOOTCAMP_START_DATE,
    TRAINER_BOOTCAMP_END_DATE,
    active_cohort_clause,
    retention_calls_detail_sql,
)

router = APIRouter()


def _filter_extra(cohort, prefix):
    extra = [NOT_TEST_DATA]
    coh_clause, coh_params = cohort_clause(cohort, prefix=prefix)
    if coh_clause:
        extra.append((coh_clause, coh_params))
    return extra


@router.get("/api/implementation/arrival")
def arrival(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),
):
    """Confirmed -> verified -> acquired at arrival, plus Karibu attendance & day-2 churn per district."""
    where, params = build_where(
        districts=district,
        extra=_filter_extra(cohort, "ar"), prefix="ar",
    )
    sql = f"""
    SELECT UPPER(district) AS district,
           SUM(confirmed) AS confirmed, SUM(verified) AS verified, SUM(acquired) AS acquired,
           SUM(female_acquired) AS female_acquired,
           SUM(karibu_attended) AS karibu_attended, SUM(day2_churn) AS day2_churn
    FROM {ATTENDANCE_DAILY}
    WHERE {where}
    GROUP BY district
    ORDER BY district
    """
    return {"by_district": database.run_query(sql, params, role=user.role)}


def _norm_venue_key(venue_name):
    """Case/whitespace-insensitive join key — ATTENDANCE_SUMMARY and
    SITE_FUNNEL_METRICS aren't guaranteed to agree on venue_name casing."""
    return " ".join((venue_name or "").split()).casefold()


@router.get("/api/implementation/attendance")
def attendance(
    user: User = Depends(current_user),
    venue: List[str] = Query(default=[]),
    cohort: List[str] = Query(default=[]),  # accepted but unused — see ACTIVE_COHORTS
):
    """Daily attendance & churn, plus a real per-venue attendance rate.

    Backed by the live ATTENDANCE_SUMMARY mart for daily present/churn and
    per-venue avg present. There's no per-lesson attendance-% table
    confirmed yet, so "lessons" stays empty until one is.

    ATTENDANCE_SUMMARY has no confirmed district column of its own, so
    by_venue's attendance_rate is built by joining its real per-venue
    present counts against SITE_FUNNEL_METRICS's real per-venue
    activated_youth (the same table /api/implementation/retention already
    uses) — present ÷ activated, both real, rather than modelling
    attendance from retention quality the way the reference prototype
    illustrates it. district comes from that join too. Matched
    case/whitespace-insensitively since the two tables' venue_name casing
    isn't guaranteed to agree.
    """
    where_d, params_d = build_where(
        venues=venue, extra=[active_cohort_clause("ad")], prefix="ad",
        venue_col="venue_name",
    )
    daily_sql = f"""
    SELECT report_date AS event_date,
           SUM(total_youths_present) AS present,
           SUM(youths_churned) AS net_churn
    FROM {ATTENDANCE_SUMMARY}
    WHERE {where_d} AND report_date IS NOT NULL
    GROUP BY event_date
    ORDER BY event_date
    """
    daily = database.run_query(daily_sql, params_d, role=user.role)

    present_where, present_params = build_where(
        venues=venue, extra=[active_cohort_clause("adv")], prefix="adv",
        venue_col="venue_name",
    )
    present_sql = f"""
    SELECT venue_name AS venue, AVG(total_youths_present) AS present
    FROM {ATTENDANCE_SUMMARY}
    WHERE {present_where} AND report_date IS NOT NULL
    GROUP BY venue
    """
    present_by_venue = {
        _norm_venue_key(r["venue"]): r.get("present")
        for r in database.run_query(present_sql, present_params, role=user.role)
    }

    activated_where, activated_params = build_where(
        venues=venue, extra=[active_cohort_clause("ada")], prefix="ada",
        venue_col="venue_name",
    )
    activated_sql = f"""
    SELECT UPPER(district) AS district, venue_name AS venue,
           SUM(activated_youth) AS activated
    FROM {SITE_FUNNEL_METRICS}
    WHERE {activated_where} AND measure = '{SITE_FUNNEL_MEASURE_ACTUAL}'
    GROUP BY district, venue
    ORDER BY district, venue
    """
    activated_rows = database.run_query(activated_sql, activated_params, role=user.role)

    by_venue = []
    for r in activated_rows:
        activated = r.get("activated") or 0
        present = present_by_venue.get(_norm_venue_key(r["venue"]))
        rate = round(100 * present / activated, 1) if present is not None and activated else None
        by_venue.append({
            "district": r["district"],
            "venue": r["venue"],
            "activated": activated,
            "present": round(present, 1) if present is not None else None,
            "attendance_rate": rate,
        })

    return {
        "daily":    daily,
        "by_venue": by_venue,
        "lessons":  [],
    }


@router.get("/api/implementation/retention")
def retention(
    user: User = Depends(current_user),
    venue: List[str] = Query(default=[]),
    cohort: List[str] = Query(default=[]),  # accepted but unused — see ACTIVE_COHORTS
):
    """Acquired -> activated -> retained per venue, against activation/retention targets.

    Backed by the live SITE_FUNNEL_METRICS mart: retained = youth_80pct_lessons
    (80%-of-lessons completion, confirmed by the recruitment team as the
    "retained" definition); activation/retention rates are computed from the
    raw counts (denominator for retention_rate is activated_youth), not the
    table's own retention_rate* columns, to stay consistent across both rates.
    site_metrics rows are venue×gender-grain (see tables.py), so
    retained_female sums the same youth_80pct_lessons column filtered to
    gender = 'FEMALE' rather than needing a second query.
    """
    where, params = build_where(
        venues=venue, extra=[active_cohort_clause("rt")], prefix="rt",
        venue_col="venue_name",
    )
    sql = f"""
    SELECT UPPER(district) AS district, venue_name AS venue,
           SUM(acquired_youth) AS acquired,
           SUM(activated_youth) AS activated,
           SUM(youth_80pct_lessons) AS retained,
           SUM(IF(UPPER(gender) = 'FEMALE', youth_80pct_lessons, 0)) AS retained_female
    FROM {SITE_FUNNEL_METRICS}
    WHERE {where} AND measure = '{SITE_FUNNEL_MEASURE_ACTUAL}'
    GROUP BY district, venue
    ORDER BY district, venue
    """
    rows = database.run_query(sql, params, role=user.role)
    for r in rows:
        acq, act = r.get("acquired") or 0, r.get("activated") or 0
        r["activation_rate"] = round(100 * act / acq, 1) if acq else None
        r["retention_rate"]  = round(100 * (r.get("retained") or 0) / act, 1) if act else None
    return {"by_venue": rows, "targets": {"activation": 90, "retention": 85}}


@router.get("/api/implementation/retention-calls")
def retention_calls(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    venue:    List[str] = Query(default=[]),
):
    """Daily follow-up call funnel for absent youth (called -> reached ->
    promised -> returned), plus a real per-venue breakdown.

    No RETENTION_CALLS mart exists yet — built directly from the two raw
    silver sources retention_calls_detail_sql() joins (see tables.py and
    Retention_calls_sql.sql at the repo root, the recruitment team's
    reference query). Once a dedicated table lands, only that one function
    needs to change — this aggregation query doesn't.

    by_venue is real (not modelled/illustrative) — the detail query already
    carries venue_name and youth_district per absence-event row, so this is
    just grouping by venue instead of by date. absent = distinct absence
    events at that venue; reach_rate = calls_reached ÷ calls_made.
    """
    where, params = build_where(
        districts=district, gender=gender, venues=venue,
        prefix="rc", district_col="youth_district", gender_col="youth_gender", venue_col="venue_name",
    )
    daily_sql = f"""
    SELECT event_date,
           SUM(calls_made_today) AS called,
           SUM(calls_reached_today) AS reached,
           SUM(promised_return_today) AS promised,
           SUM(returned) AS returned
    FROM ({retention_calls_detail_sql()}) AS rc
    WHERE {where}
    GROUP BY event_date
    ORDER BY event_date
    """
    daily = database.run_query(daily_sql, params, role=user.role)

    # Venue-grain daily rows too, purely additive alongside the programme-
    # wide `daily` above — lets the frontend's venue search re-derive the
    # daily funnel chart for just the matched venue(s) without a second
    # round trip, by summing these rows per date client-side instead of
    # querying BigQuery again per keystroke.
    daily_venue_where, daily_venue_params = build_where(
        districts=district, gender=gender, venues=venue,
        prefix="rcdv", district_col="youth_district", gender_col="youth_gender", venue_col="venue_name",
    )
    daily_by_venue_sql = f"""
    SELECT event_date, venue_name AS venue,
           SUM(calls_made_today) AS called,
           SUM(calls_reached_today) AS reached,
           SUM(promised_return_today) AS promised,
           SUM(returned) AS returned
    FROM ({retention_calls_detail_sql()}) AS rc
    WHERE {daily_venue_where}
    GROUP BY event_date, venue
    ORDER BY event_date, venue
    """
    daily_by_venue = database.run_query(daily_by_venue_sql, daily_venue_params, role=user.role)

    venue_where, venue_params = build_where(
        districts=district, gender=gender, venues=venue,
        prefix="rcv", district_col="youth_district", gender_col="youth_gender", venue_col="venue_name",
    )
    venue_sql = f"""
    SELECT venue_name AS venue, UPPER(youth_district) AS district,
           COUNT(*) AS absent,
           SUM(calls_made_today) AS called,
           SUM(calls_reached_today) AS reached,
           SUM(promised_return_today) AS promised,
           SUM(returned) AS returned
    FROM ({retention_calls_detail_sql()}) AS rc
    WHERE {venue_where}
    GROUP BY venue, district
    ORDER BY absent DESC
    """
    by_venue = database.run_query(venue_sql, venue_params, role=user.role)
    for r in by_venue:
        called = r.get("called") or 0
        r["reach_rate"] = round(100 * (r.get("reached") or 0) / called, 1) if called else None

    return {"daily": daily, "daily_by_venue": daily_by_venue, "by_venue": by_venue}


# Column names straight from the recruitment team's reference query
# (trainer_quality_summary_sql.sql) — including the "_scoret_" typo on
# gender-responsiveness, which is the real BigQuery column name, not ours to
# fix. These are the avg_score_* family: the 0-4 observation scale that the
# reference query's performance_category CASE bands at >=4 EXCEEDS / >=3
# MEETS / else BELOW. The table also carries percentage_* (0-100) and
# total_score_* (raw sum) variants — neither is reported, so the overall
# score and every domain share one categorisation on one scale.
_TRAINER_DOMAIN_COLUMNS = [
    ("pck", "avg_score_pedagogical_content_knowledge", "Pedagogical content knowledge"),
    ("fds", "avg_score_facilitation_and_delivery_skills", "Facilitation & delivery"),
    ("em", "avg_score_entrepreneurship_mindset", "Entrepreneurial mindset"),
    ("gr", "avg_scoret_gender_responsive", "Gender responsiveness"),
    ("cm", "avg_score_coaching_and_mentoring", "Coaching & mentoring"),
    ("language", "avg_score_language", "Language"),
    ("leadership", "avg_score_leadership", "Leadership"),
]


# The cohorts this endpoint reports, oldest first — this list is the single
# source of the cohort filter's allowed values, the SQL CASE that labels each
# row, and the date filter itself, so the three can't drift apart. The table
# has no bootcamp_cycle column (see tables.py), so cohort IS the date window.
_TRAINER_COHORT_WINDOWS = [
    ("BOOTCAMP_4", TRAINER_BC4_START_DATE, TRAINER_BC4_END_DATE),
    ("BC5 TOT", TRAINER_TOT_START_DATE, TRAINER_TOT_END_DATE),
    ("BOOTCAMP_5", TRAINER_BOOTCAMP_START_DATE, TRAINER_BOOTCAMP_END_DATE),
]
TRAINER_COHORTS = [name for name, _start, _end in _TRAINER_COHORT_WINDOWS]


def _trainer_window_sql(prefix, index):
    return f"DATE(submission_date) BETWEEN @{prefix}_c{index}s AND @{prefix}_c{index}e"


def _trainer_cohort_case(prefix):
    """SQL CASE mapping a row's submission_date to its cohort label. Labels are
    module constants, never user input — nothing is interpolated from a request.
    Every window's params are referenced here, so they are always bound even
    when the filter itself narrows to one cohort."""
    whens = "\n        ".join(
        f"WHEN {_trainer_window_sql(prefix, i)} THEN '{name}'"
        for i, (name, _start, _end) in enumerate(_TRAINER_COHORT_WINDOWS)
    )
    return f"CASE\n        {whens}\n      END"


def _trainer_where(district, prefix, phase=None):
    """phase=None matches an OR of every cohort window — not one wide span, so
    the un-cohorted gap between BOOTCAMP_4 and BC5 TOT is excluded and every
    row maps to exactly one cohort. A specific cohort narrows to its own range.
    Callers must embed _trainer_cohort_case(prefix), which binds every window
    param this returns."""
    if phase is None:
        clause = "(" + " OR ".join(_trainer_window_sql(prefix, i) for i in range(len(_TRAINER_COHORT_WINDOWS))) + ")"
    else:
        clause = _trainer_window_sql(prefix, TRAINER_COHORTS.index(phase))
    params = []
    for i, (_name, start, end) in enumerate(_TRAINER_COHORT_WINDOWS):
        params.append(_scalar(f"{prefix}_c{i}s", "DATE", start))
        params.append(_scalar(f"{prefix}_c{i}e", "DATE", end))
    return build_where(
        districts=district, prefix=prefix, district_col="district_name",
        extra=[(clause, params)],
    )


@router.get("/api/implementation/trainers")
def trainers(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    phase: Optional[Literal["BOOTCAMP_4", "BC5 TOT", "BOOTCAMP_5"]] = Query(
        None, description="Cohort to narrow to — omit for every cohort"
    ),
):
    """Trainer observation scores + the seven E! teaching-domain averages, all
    on the same observation scale, plus a per-cohort rollup. Names masked to
    initials for the guest role.

    Backed by the live TRAINER_OBSERVATIONS raw lesson-observation export
    (see tables.py — no bootcamp_cycle column, so a cohort IS a submission-date
    window). Three cohorts are reported: BOOTCAMP_4 (the prior cohort) and BC5
    split into TOT (trainer certification, before teaching youth) and
    BOOTCAMP_5 (in-classroom delivery). Those are conceptually distinct
    populations, not just a date split, which is why this is a page-level
    cohort selector on Trainer Quality rather than the app-wide cohort filter
    (no other live table has a "BC5 TOT" bootcamp_cycle value).

    `phase` omitted matches an OR of all three windows, so the un-cohorted
    2026-05-30..2026-07-28 gap is excluded rather than swept in unlabelled.
    Rows carry their cohort and are grouped by it, so a trainer observed in
    two cohorts gets one row per cohort instead of a single blended score.

    rating is a MEETS/EXCEEDS/BELOW band on the average
    overall_average_class_observation_score, per the recruitment team's
    reference query (trainer_quality_summary_sql.sql) — the same bands the
    client applies to each domain average, so nothing on the page mixes a
    score with a 0-100 percentage.
    """
    domain_select = ",\n      ".join(f"AVG(CAST({col} AS FLOAT64)) AS avg_{key}" for key, col, _label in _TRAINER_DOMAIN_COLUMNS)

    where, params = _trainer_where(district, "tq", phase)
    sql = f"""
    SELECT
      trainer_name,
      trainer_gender,
      training_site AS venue,
      UPPER(district_name) AS district,
      {_trainer_cohort_case("tq")} AS cohort,
      COUNT(*) AS observation_count,
      AVG(CAST(overall_average_class_observation_score AS FLOAT64)) AS score,
      {domain_select},
      CASE
        WHEN AVG(CAST(overall_average_class_observation_score AS FLOAT64)) >= 4 THEN 'EXCEEDS'
        WHEN AVG(CAST(overall_average_class_observation_score AS FLOAT64)) >= 3 THEN 'MEETS'
        ELSE 'BELOW'
      END AS rating
    FROM {TRAINER_OBSERVATIONS}
    WHERE {where}
      AND report_type = 'rct_lesson_observation'
      AND trainer_name IS NOT NULL
    GROUP BY trainer_name, trainer_gender, venue, district, cohort
    ORDER BY score DESC
    """
    # database.run_query() caches its result and returns the SAME dict objects
    # on a cache hit (see core/cache.py) — copy each row before mutating it.
    # Skipping this once already caused a real bug: a guest-role call would
    # compute trainer_key from the raw name on the first (cache-miss) request,
    # then on the very next cache-hit request re-derive it from the row's
    # now-already-masked trainer_name (mutated in place by the previous call),
    # producing a key that could never match pii.name_from_trainer_key()'s
    # reverse lookup — a permanent 404 on the trainer-detail drill until the
    # 5-minute cache entry expired.
    rows = [dict(r) for r in database.run_query(sql, params, role=user.role)]
    for r in rows:
        # trainer_key is derived from the raw name before masking — the
        # frontend's only way to fetch this one trainer's observation detail,
        # since mask_name() below hides the real name from the guest role.
        r["trainer_key"] = compute_trainer_key(r.get("trainer_name"))
        r["trainer_name"] = mask_name(user.role, r.get("trainer_name"))

    # Cohort rollup: always spans every cohort regardless of the selector, so
    # the comparison card still has something to compare against when the
    # register itself is narrowed to one cohort.
    phase_where, phase_params = _trainer_where(district, "tqp")
    phase_sql = f"""
    SELECT
      {_trainer_cohort_case("tqp")} AS phase,
      COUNT(DISTINCT trainer_name) AS trainers_observed,
      AVG(CAST(overall_average_class_observation_score AS FLOAT64)) AS score
    FROM {TRAINER_OBSERVATIONS}
    WHERE {phase_where}
      AND report_type = 'rct_lesson_observation'
      AND trainer_name IS NOT NULL
    GROUP BY phase
    """
    by_phase = database.run_query(phase_sql, phase_params, role=user.role)
    # Chronological, not alphabetical — "BC5 TOT" would otherwise sort before
    # "BOOTCAMP_4". Unknown labels can't occur (the CASE is exhaustive over the
    # same windows the WHERE filters on) but sort last rather than raising.
    by_phase.sort(key=lambda r: TRAINER_COHORTS.index(r["phase"]) if r.get("phase") in TRAINER_COHORTS else len(TRAINER_COHORTS))

    return {
        "trainers": rows,
        "by_phase": by_phase,
        "domains": [{"key": key, "label": label} for key, _col, label in _TRAINER_DOMAIN_COLUMNS],
        "cohorts": TRAINER_COHORTS,
    }


@router.get("/api/implementation/trainer-detail")
def trainer_detail(
    trainer_key: str = Query(...),
    phase: Optional[Literal["BOOTCAMP_4", "BC5 TOT", "BOOTCAMP_5"]] = Query(
        None, description="Cohort to narrow to — omit for every cohort"
    ),
    user: User = Depends(current_user),
):
    """One trainer's individual observations (no GROUP BY — one row per
    classroom visit), for the per-trainer drill-down: trend, comparisons and
    rule-based insights are all computed client-side from this list plus the
    already-loaded /api/implementation/trainers register.

    `trainer_key` is the pseudonymous id from pii.trainer_key() — resolved
    here back to the raw trainer_name so the frontend (which only ever sees
    the masked name for the guest role) never has to round-trip a real name.
    """
    name = name_from_trainer_key(trainer_key)
    if name is None:
        raise HTTPException(status_code=404, detail="Trainer not found")

    domain_select = ",\n      ".join(f"CAST({col} AS FLOAT64) AS avg_{key}" for key, col, _label in _TRAINER_DOMAIN_COLUMNS)
    where, params = _trainer_where([], "tqd", phase)
    sql = f"""
    SELECT
      DATE(submission_date) AS observation_date,
      {_trainer_cohort_case("tqd")} AS cohort,
      training_week,
      training_day,
      observer_name,
      training_site AS venue,
      UPPER(district_name) AS district,
      CAST(overall_average_class_observation_score AS FLOAT64) AS score,
      {domain_select}
    FROM {TRAINER_OBSERVATIONS}
    WHERE {where}
      AND report_type = 'rct_lesson_observation'
      AND trainer_name = @trainer_name
    ORDER BY observation_date
    """
    params = params + [_scalar("trainer_name", "STRING", name)]
    # Copy before mutating — see the matching comment in trainers() above;
    # run_query()'s cached rows are shared objects across calls.
    rows = [dict(r) for r in database.run_query(sql, params, role=user.role)]
    for r in rows:
        r["observer_name"] = mask_name(user.role, r.get("observer_name"))

    return {
        "trainer_name": mask_name(user.role, name),
        "trainer_key": trainer_key,
        "observations": rows,
        "domains": [{"key": key, "label": label} for key, _col, label in _TRAINER_DOMAIN_COLUMNS],
    }


def _milestones_where(district, gender, venue, cohort, prefix, include_cohort=True, start_date=None, end_date=None):
    # No NOT_TEST_DATA here (unlike _filter_extra) -- this table has no
    # is_test_data column. Cohort filters bootcamp_cycle directly rather than
    # defaulting to ACTIVE_COHORTS -- no BOOTCAMP_5 rows exist in this table
    # yet, so that default would show nothing (see MILESTONES in tables.py).
    # include_cohort=False drops the bootcamp_cycle restriction entirely --
    # used by by_cohort_week, which compares cohorts against each other and
    # so must never be narrowed to whichever single cohort the page filter
    # has selected.
    #
    # start_date/end_date filter on created_at -- the report's own submission
    # timestamp (confirmed live: every row has one, spanning 2025-08-29 to
    # 2026-05-30) -- not the derived week_number, so a date range narrows to
    # reports actually submitted in that window regardless of which week they
    # were captured for.
    extra = []
    if include_cohort:
        coh_clause, coh_params = cohort_clause(cohort, prefix=prefix, column="bootcamp_cycle")
        if coh_clause:
            extra.append((coh_clause, coh_params))
    if start_date:
        extra.append((f"DATE(created_at) >= @{prefix}_start_date", [_scalar(f"{prefix}_start_date", "DATE", start_date)]))
    if end_date:
        extra.append((f"DATE(created_at) <= @{prefix}_end_date", [_scalar(f"{prefix}_end_date", "DATE", end_date)]))
    return build_where(
        districts=district, gender=gender, venues=venue,
        extra=extra, prefix=prefix,
        district_col="youth_district", gender_col="youth_gender", venue_col="venue_name",
    )


@router.get("/api/implementation/milestones")
def milestones(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    venue:    List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),
    start_date: Optional[str] = Query(None),
    end_date:   Optional[str] = Query(None),
):
    """Weekly business-pitch milestone distribution (below/meet/exceed),
    completion, and parent-engagement -- programme-wide (weekly), cumulative
    per venue (by_venue), and single-week grain by district (by_district_week),
    venue (by_venue_week), gender (by_gender_week), and cohort (by_cohort_week),
    for the district/venue x week matrix tables, the weekly performance chart's
    district/venue/gender drill, and the cross-cohort quality-trend comparison.

    by_cohort_week ignores the page's own cohort filter (see _milestones_where's
    include_cohort=False) -- the whole point of that table is comparing cohorts
    against each other, so narrowing it to one selected cohort would defeat it.
    district/gender/venue filters still apply.

    Backed by the live silver MILESTONES table (see tables.py for the
    recruitment/M&E team's own scoring rubric — MILESTONE_PERFORMANCE_CATEGORY_SQL
    — and why "completed" means business_plan_score >= 1, not the table's own
    `completed` column).

    below_pct/meet_pct/exceed_pct/completion_pct are all of total_youth (every
    distinct youth counted in that row), not just those with a classifiable
    score — a youth scoring 0 that week is real (they didn't grade), not
    missing, so it's left to show up as a shortfall in the percentages rather
    than silently excluded from the denominator. parent_present_pct is
    similarly of total_youth, with parent_no_report_pct broken out
    separately (parent_engagement is NULL for a large share of rows in every
    cohort) — same "don't fold an unreported share into a real category"
    approach as the Awareness Overview RCT card's Unassigned bucket.

    by_district_week/by_venue_week are each already single-week grain (unlike
    by_venue, which sums across every week reported into one row per venue),
    so total_youth is a safe same-week percentage denominator there too — no
    row-count-vs-headcount correction needed like by_venue's total_reports.
    """
    where, params = _milestones_where(district, gender, venue, cohort, "ms", start_date=start_date, end_date=end_date)
    sql = f"""
    WITH classified AS (
      SELECT
        youth_id,
        SAFE_CAST(REGEXP_EXTRACT(week, r'(\\d+)') AS INT64) AS week_number,
        business_plan_score,
        parent_engagement,
        {MILESTONE_PERFORMANCE_CATEGORY_SQL} AS performance_category
      FROM {MILESTONES}
      WHERE {where}
    )
    SELECT
      week_number,
      COUNT(DISTINCT youth_id) AS total_youth,
      COUNTIF(performance_category = 'below') AS below,
      COUNTIF(performance_category = 'meet') AS meet,
      COUNTIF(performance_category = 'exceed') AS exceed,
      COUNTIF(business_plan_score >= 1) AS completed,
      COUNTIF(parent_engagement = TRUE) AS parent_present,
      COUNTIF(parent_engagement = FALSE) AS parent_absent,
      COUNTIF(parent_engagement IS NULL) AS parent_no_report
    FROM classified
    GROUP BY week_number
    ORDER BY week_number
    """
    weekly = database.run_query(sql, params, role=user.role)
    for w in weekly:
        total = w.get("total_youth") or 0
        w["below_pct"] = round(100 * (w.get("below") or 0) / total, 1) if total else None
        w["meet_pct"] = round(100 * (w.get("meet") or 0) / total, 1) if total else None
        w["exceed_pct"] = round(100 * (w.get("exceed") or 0) / total, 1) if total else None
        w["completion_pct"] = round(100 * (w.get("completed") or 0) / total, 1) if total else None
        w["parent_present_pct"] = round(100 * (w.get("parent_present") or 0) / total, 1) if total else None
        w["parent_no_report_pct"] = round(100 * (w.get("parent_no_report") or 0) / total, 1) if total else None

    venue_where, venue_params = _milestones_where(district, gender, venue, cohort, "msv", start_date=start_date, end_date=end_date)
    venue_sql = f"""
    WITH classified AS (
      SELECT
        youth_id, venue_name AS venue, UPPER(youth_district) AS district, week,
        business_plan_score,
        {MILESTONE_PERFORMANCE_CATEGORY_SQL} AS performance_category
      FROM {MILESTONES}
      WHERE {venue_where}
    )
    SELECT
      venue, district,
      COUNT(*) AS total_reports,
      COUNT(DISTINCT youth_id) AS total_youth,
      COUNTIF(performance_category = 'below') AS below,
      COUNTIF(performance_category = 'meet') AS meet,
      COUNTIF(performance_category = 'exceed') AS exceed,
      COUNTIF(business_plan_score >= 1) AS completed,
      COUNT(DISTINCT week) AS weeks_reported
    FROM classified
    GROUP BY venue, district
    ORDER BY venue
    """
    by_venue = database.run_query(venue_sql, venue_params, role=user.role)
    for v in by_venue:
        # Percentages are of total_reports (row count, summed across every
        # week reported) -- total_youth is a one-time distinct headcount, so
        # dividing a cross-week SUM by it can exceed 100% (a youth graded in
        # all 4 weeks gets counted 4x in the numerator, once in that
        # denominator). avg_youth_per_week is the one place total_youth (the
        # headcount) is actually the right number to use.
        reports = v.get("total_reports") or 0
        youth = v.get("total_youth") or 0
        weeks = v.get("weeks_reported") or 0
        v["exceed_pct"] = round(100 * (v.get("exceed") or 0) / reports, 1) if reports else None
        v["completion_pct"] = round(100 * (v.get("completed") or 0) / reports, 1) if reports else None
        v["avg_youth_per_week"] = round(youth / weeks, 1) if weeks else None

    # District x week and venue x week grain -- each row already single-week
    # (unlike by_venue's cumulative-across-weeks rollup above), so total_youth
    # is a safe same-week percentage denominator here, no row-count-vs-
    # headcount mismatch to correct for. Feeds the district/venue x week
    # matrix tables and the week-over-week variance drill (both computed
    # client-side from this one flat row set, same "one fetch feeds every
    # rollup" approach as the rest of this page).
    district_week_where, district_week_params = _milestones_where(district, gender, venue, cohort, "msdw", start_date=start_date, end_date=end_date)
    district_week_sql = f"""
    WITH classified AS (
      SELECT
        youth_id, UPPER(youth_district) AS district,
        SAFE_CAST(REGEXP_EXTRACT(week, r'(\\d+)') AS INT64) AS week_number,
        business_plan_score,
        {MILESTONE_PERFORMANCE_CATEGORY_SQL} AS performance_category
      FROM {MILESTONES}
      WHERE {district_week_where}
    )
    SELECT
      district, week_number,
      COUNT(DISTINCT youth_id) AS total_youth,
      COUNTIF(performance_category = 'below') AS below,
      COUNTIF(performance_category = 'meet') AS meet,
      COUNTIF(performance_category = 'exceed') AS exceed,
      COUNTIF(business_plan_score >= 1) AS completed
    FROM classified
    GROUP BY district, week_number
    ORDER BY district, week_number
    """
    by_district_week = database.run_query(district_week_sql, district_week_params, role=user.role)
    for d in by_district_week:
        total = d.get("total_youth") or 0
        d["below_pct"] = round(100 * (d.get("below") or 0) / total, 1) if total else None
        d["meet_pct"] = round(100 * (d.get("meet") or 0) / total, 1) if total else None
        d["exceed_pct"] = round(100 * (d.get("exceed") or 0) / total, 1) if total else None
        d["completion_pct"] = round(100 * (d.get("completed") or 0) / total, 1) if total else None

    venue_week_where, venue_week_params = _milestones_where(district, gender, venue, cohort, "msvw", start_date=start_date, end_date=end_date)
    venue_week_sql = f"""
    WITH classified AS (
      SELECT
        youth_id, venue_name AS venue, UPPER(youth_district) AS district,
        SAFE_CAST(REGEXP_EXTRACT(week, r'(\\d+)') AS INT64) AS week_number,
        business_plan_score,
        {MILESTONE_PERFORMANCE_CATEGORY_SQL} AS performance_category
      FROM {MILESTONES}
      WHERE {venue_week_where}
    )
    SELECT
      venue, district, week_number,
      COUNT(DISTINCT youth_id) AS total_youth,
      COUNTIF(performance_category = 'below') AS below,
      COUNTIF(performance_category = 'meet') AS meet,
      COUNTIF(performance_category = 'exceed') AS exceed,
      COUNTIF(business_plan_score >= 1) AS completed
    FROM classified
    GROUP BY venue, district, week_number
    ORDER BY venue, week_number
    """
    by_venue_week = database.run_query(venue_week_sql, venue_week_params, role=user.role)
    for v in by_venue_week:
        total = v.get("total_youth") or 0
        v["below_pct"] = round(100 * (v.get("below") or 0) / total, 1) if total else None
        v["meet_pct"] = round(100 * (v.get("meet") or 0) / total, 1) if total else None
        v["exceed_pct"] = round(100 * (v.get("exceed") or 0) / total, 1) if total else None
        v["completion_pct"] = round(100 * (v.get("completed") or 0) / total, 1) if total else None

    # Gender x week -- respects the page's own filters (including cohort),
    # unlike by_cohort_week below. Feeds the weekly performance chart's
    # by-gender drill.
    gender_week_where, gender_week_params = _milestones_where(district, gender, venue, cohort, "msgw", start_date=start_date, end_date=end_date)
    gender_week_sql = f"""
    WITH classified AS (
      SELECT
        youth_id, UPPER(youth_gender) AS gender,
        SAFE_CAST(REGEXP_EXTRACT(week, r'(\\d+)') AS INT64) AS week_number,
        business_plan_score,
        {MILESTONE_PERFORMANCE_CATEGORY_SQL} AS performance_category
      FROM {MILESTONES}
      WHERE {gender_week_where}
    )
    SELECT
      gender, week_number,
      COUNT(DISTINCT youth_id) AS total_youth,
      COUNTIF(performance_category = 'below') AS below,
      COUNTIF(performance_category = 'meet') AS meet,
      COUNTIF(performance_category = 'exceed') AS exceed,
      COUNTIF(business_plan_score >= 1) AS completed
    FROM classified
    GROUP BY gender, week_number
    ORDER BY gender, week_number
    """
    by_gender_week = database.run_query(gender_week_sql, gender_week_params, role=user.role)
    for g in by_gender_week:
        total = g.get("total_youth") or 0
        g["below_pct"] = round(100 * (g.get("below") or 0) / total, 1) if total else None
        g["meet_pct"] = round(100 * (g.get("meet") or 0) / total, 1) if total else None
        g["exceed_pct"] = round(100 * (g.get("exceed") or 0) / total, 1) if total else None
        g["completion_pct"] = round(100 * (g.get("completed") or 0) / total, 1) if total else None

    # Cohort x week -- deliberately ignores the page's cohort filter (see
    # _milestones_where) so every cohort with data shows up side by side,
    # letting the "does quality improve or drop by week" read be compared
    # across cohorts rather than collapsed to whichever one is selected.
    cohort_week_where, cohort_week_params = _milestones_where(district, gender, venue, cohort, "mscw", include_cohort=False, start_date=start_date, end_date=end_date)
    cohort_week_sql = f"""
    WITH classified AS (
      SELECT
        youth_id, bootcamp_cycle AS cohort,
        SAFE_CAST(REGEXP_EXTRACT(week, r'(\\d+)') AS INT64) AS week_number,
        business_plan_score,
        {MILESTONE_PERFORMANCE_CATEGORY_SQL} AS performance_category
      FROM {MILESTONES}
      WHERE {cohort_week_where}
    )
    SELECT
      cohort, week_number,
      COUNT(DISTINCT youth_id) AS total_youth,
      COUNTIF(performance_category = 'below') AS below,
      COUNTIF(performance_category = 'meet') AS meet,
      COUNTIF(performance_category = 'exceed') AS exceed,
      COUNTIF(business_plan_score >= 1) AS completed
    FROM classified
    GROUP BY cohort, week_number
    ORDER BY cohort, week_number
    """
    by_cohort_week = database.run_query(cohort_week_sql, cohort_week_params, role=user.role)
    for c in by_cohort_week:
        total = c.get("total_youth") or 0
        c["below_pct"] = round(100 * (c.get("below") or 0) / total, 1) if total else None
        c["meet_pct"] = round(100 * (c.get("meet") or 0) / total, 1) if total else None
        c["exceed_pct"] = round(100 * (c.get("exceed") or 0) / total, 1) if total else None
        c["completion_pct"] = round(100 * (c.get("completed") or 0) / total, 1) if total else None

    return {
        "weekly": weekly,
        "by_venue": by_venue,
        "by_district_week": by_district_week,
        "by_venue_week": by_venue_week,
        "by_gender_week": by_gender_week,
        "by_cohort_week": by_cohort_week,
    }


@router.get("/api/implementation/youth-experience")
def youth_experience(
    user: User = Depends(current_user),
    venue: List[str] = Query(default=[]),
    cohort: List[str] = Query(default=[]),
):
    """Programme / Venue / Meals NPS by week, against the 50+ target."""
    where, params = build_where(venues=venue, extra=_filter_extra(cohort, "yx"), prefix="yx")
    sql = f"""
    SELECT week_number, dimension, AVG(nps) AS nps
    FROM {YOUTH_NPS}
    WHERE {where}
    GROUP BY week_number, dimension
    ORDER BY week_number, dimension
    """
    return {"weekly": database.run_query(sql, params, role=user.role), "target": 50}
