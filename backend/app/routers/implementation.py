"""
Implementation endpoints — Arrival, Attendance, Retention, Retention Calls,
Trainer Quality, Milestones, Youth Experience (NPS).

Trainer names are masked for the guest role.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, Query

from app.auth import current_user, User
from app.core import database  # module import — required for the run_query test seam
from app.core.database import _scalar
from app.core.pii import mask_name
from app.core.sql import build_where, cohort_clause
from app.core.tables import (
    ATTENDANCE_DAILY,
    MILESTONES,
    YOUTH_NPS,
    NOT_TEST_DATA,
    SITE_FUNNEL_METRICS,
    SITE_FUNNEL_MEASURE_ACTUAL,
    ATTENDANCE_SUMMARY,
    TRAINER_OBSERVATIONS,
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


@router.get("/api/implementation/attendance")
def attendance(
    user: User = Depends(current_user),
    venue: List[str] = Query(default=[]),
    cohort: List[str] = Query(default=[]),  # accepted but unused — see ACTIVE_COHORTS
):
    """Daily attendance & churn.

    Backed by the live ATTENDANCE_SUMMARY mart. There's no per-lesson
    attendance-% table confirmed yet, so "lessons" stays empty until one is.
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
    return {
        "daily":   database.run_query(daily_sql, params_d, role=user.role),
        "lessons": [],
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
    """
    where, params = build_where(
        venues=venue, extra=[active_cohort_clause("rt")], prefix="rt",
        venue_col="venue_name",
    )
    sql = f"""
    SELECT UPPER(district) AS district, venue_name AS venue,
           SUM(acquired_youth) AS acquired,
           SUM(activated_youth) AS activated,
           SUM(youth_80pct_lessons) AS retained
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
    """Daily follow-up call funnel for absent youth: called -> reached -> promised -> returned.

    No RETENTION_CALLS mart exists yet — built directly from the two raw
    silver sources retention_calls_detail_sql() joins (see tables.py and
    Retention_calls_sql.sql at the repo root, the recruitment team's
    reference query). Once a dedicated table lands, only that one function
    needs to change — this aggregation query doesn't.
    """
    where, params = build_where(
        districts=district, gender=gender, venues=venue,
        prefix="rc", district_col="youth_district", gender_col="youth_gender", venue_col="venue_name",
    )
    sql = f"""
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
    return {"daily": database.run_query(sql, params, role=user.role)}


# Column names straight from the recruitment team's reference query
# (trainer_quality_summary_sql.sql) — including the "_scoret_" typo on
# gender-responsiveness, which is the real BigQuery column name, not ours to
# fix. percentage_* columns are 0-100; avg_score_*/total_score_* are the
# underlying 0-4 scale and raw sum respectively (unused here — the domain
# summary reads percentage, matching the reference design's bands).
_TRAINER_DOMAIN_COLUMNS = [
    ("pck", "percentage_score_pedagogical_content_knowledge", "Pedagogical content knowledge"),
    ("fds", "percentage_score_facilitation_and_delivery_skills", "Facilitation & delivery"),
    ("em", "percentage_score_entrepreneurship_mindset", "Entrepreneurial mindset"),
    ("gr", "percentage_scoret_gender_responsive", "Gender responsiveness"),
    ("cm", "percentage_score_coaching_and_mentoring", "Coaching & mentoring"),
    ("language", "percentage_language", "Language"),
    ("leadership", "percentage_leadership", "Leadership"),
]


_TRAINER_PHASE_WINDOW = {
    "BC5 TOT": (TRAINER_TOT_START_DATE, TRAINER_TOT_END_DATE),
    "BOOTCAMP_5": (TRAINER_BOOTCAMP_START_DATE, TRAINER_BOOTCAMP_END_DATE),
}


def _trainer_where(district, prefix, phase=None):
    """phase=None spans the full TOT+BOOTCAMP_5 window (both phases); a
    specific phase narrows to just that phase's own date range."""
    start, end = _TRAINER_PHASE_WINDOW.get(phase, (TRAINER_TOT_START_DATE, TRAINER_BOOTCAMP_END_DATE))
    return build_where(
        districts=district, prefix=prefix, district_col="district_name",
        extra=[(
            f"DATE(submission_date) BETWEEN @{prefix}_start AND @{prefix}_end",
            [_scalar(f"{prefix}_start", "DATE", start), _scalar(f"{prefix}_end", "DATE", end)],
        )],
    )


@router.get("/api/implementation/trainers")
def trainers(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    phase: Optional[str] = Query(None, description="'BC5 TOT' or 'BOOTCAMP_5' — omit for both"),
):
    """Trainer observation scores + the seven E! teaching-domain percentages,
    plus a BC5 TOT vs BOOTCAMP_5 phase breakdown. Names masked to initials
    for the guest role.

    Backed by the live TRAINER_OBSERVATIONS raw lesson-observation export
    (see tables.py — no bootcamp_cycle column, scoped by report_type + a
    date window instead: the full TOT+BOOTCAMP_5 span by default, or just
    one phase's own range when `phase` narrows it — TOT (trainer
    certification, before teaching youth) and BOOTCAMP_5 (in-classroom
    delivery) are conceptually distinct populations, not just a date split,
    which is why this is a page-level phase selector on Trainer Quality
    rather than the app-wide cohort filter (no other live table has a
    "BC5 TOT" bootcamp_cycle value). rating is a MEETS/EXCEEDS/BELOW band
    on the average overall_average_class_observation_score, per the
    recruitment team's reference query (trainer_quality_summary_sql.sql).
    """
    domain_select = ",\n      ".join(f"AVG(CAST({col} AS FLOAT64)) AS pct_{key}" for key, col, _label in _TRAINER_DOMAIN_COLUMNS)

    where, params = _trainer_where(district, "tq", phase)
    sql = f"""
    SELECT
      trainer_name,
      training_site AS venue,
      UPPER(district_name) AS district,
      AVG(CAST(overall_average_class_observation_score AS FLOAT64)) AS score,
      AVG(CAST(overall_percentage_class_observation_score AS FLOAT64)) AS pct_overall,
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
    GROUP BY trainer_name, venue, district
    ORDER BY score DESC
    """
    rows = database.run_query(sql, params, role=user.role)
    for r in rows:
        r["trainer_name"] = mask_name(user.role, r.get("trainer_name"))

    # Phase rollup: same window, same rating bands, but grouped by phase
    # instead of by trainer — TOT (trainer certification, before they teach
    # youth) and the BOOTCAMP_5 delivery window are conceptually different
    # populations, not just a date split.
    phase_where, phase_params = _trainer_where(district, "tqp")
    phase_sql = f"""
    SELECT
      CASE
        WHEN DATE(submission_date) BETWEEN @tqp_tot_start AND @tqp_tot_end THEN 'BC5 TOT'
        WHEN DATE(submission_date) BETWEEN @tqp_bc_start AND @tqp_bc_end THEN 'BOOTCAMP_5'
      END AS phase,
      COUNT(DISTINCT trainer_name) AS trainers_observed,
      AVG(CAST(overall_average_class_observation_score AS FLOAT64)) AS score,
      AVG(CAST(overall_percentage_class_observation_score AS FLOAT64)) AS pct_overall
    FROM {TRAINER_OBSERVATIONS}
    WHERE {phase_where}
      AND report_type = 'rct_lesson_observation'
      AND trainer_name IS NOT NULL
    GROUP BY phase
    """
    phase_params = phase_params + [
        _scalar("tqp_tot_start", "DATE", TRAINER_TOT_START_DATE),
        _scalar("tqp_tot_end", "DATE", TRAINER_TOT_END_DATE),
        _scalar("tqp_bc_start", "DATE", TRAINER_BOOTCAMP_START_DATE),
        _scalar("tqp_bc_end", "DATE", TRAINER_BOOTCAMP_END_DATE),
    ]
    by_phase = database.run_query(phase_sql, phase_params, role=user.role)

    return {
        "trainers": rows,
        "by_phase": by_phase,
        "domains": [{"key": key, "label": label} for key, _col, label in _TRAINER_DOMAIN_COLUMNS],
    }


@router.get("/api/implementation/milestones")
def milestones(
    user: User = Depends(current_user),
    venue: List[str] = Query(default=[]),
    cohort: List[str] = Query(default=[]),
):
    """Weekly pitch milestone distribution (below / meet / exceed) & completion."""
    where, params = build_where(venues=venue, extra=_filter_extra(cohort, "ms"), prefix="ms")
    sql = f"""
    SELECT week_number,
           SUM(below) AS below, SUM(meet) AS meet, SUM(exceed) AS exceed,
           AVG(completion_pct) AS completion_pct, AVG(parent_present_pct) AS parent_present_pct
    FROM {MILESTONES}
    WHERE {where}
    GROUP BY week_number
    ORDER BY week_number
    """
    return {"weekly": database.run_query(sql, params, role=user.role)}


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
