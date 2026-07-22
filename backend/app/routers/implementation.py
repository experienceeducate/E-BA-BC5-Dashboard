"""
Implementation endpoints — Arrival, Attendance, Retention, Retention Calls,
Trainer Quality, Milestones, Youth Experience (NPS).

Trainer names are masked for the guest role.
"""

from typing import List

from fastapi import APIRouter, Depends, Query

from app.auth import current_user, User
from app.core import database  # module import — required for the run_query test seam
from app.core.database import _scalar
from app.core.pii import mask_name
from app.core.sql import build_where, cohort_clause
from app.core.tables import (
    ATTENDANCE_DAILY,
    RETENTION_CALLS,
    MILESTONES,
    YOUTH_NPS,
    NOT_TEST_DATA,
    SITE_FUNNEL_METRICS,
    SITE_FUNNEL_MEASURE_ACTUAL,
    ATTENDANCE_SUMMARY,
    TRAINER_OBSERVATIONS,
    ACTIVE_COHORT_START_DATE,
    ACTIVE_COHORT_END_DATE,
    active_cohort_clause,
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
    cohort: List[str] = Query(default=[]),  # accepted but unused — see ACTIVE_COHORT
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
    cohort: List[str] = Query(default=[]),  # accepted but unused — see ACTIVE_COHORT
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
    venue: List[str] = Query(default=[]),
    cohort: List[str] = Query(default=[]),
):
    """Daily follow-up call funnel: called -> reached -> promised -> returned."""
    where, params = build_where(venues=venue, extra=_filter_extra(cohort, "rc"), prefix="rc")
    sql = f"""
    SELECT event_date,
           SUM(called) AS called, SUM(reached) AS reached,
           SUM(promised) AS promised, SUM(returned) AS returned
    FROM {RETENTION_CALLS}
    WHERE {where} AND event_date IS NOT NULL
    GROUP BY event_date
    ORDER BY event_date
    """
    return {"daily": database.run_query(sql, params, role=user.role)}


@router.get("/api/implementation/trainers")
def trainers(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
):
    """Trainer observation scores. Names masked to initials for the guest role.

    Backed by the live TRAINER_OBSERVATIONS raw lesson-observation export
    (see tables.py — no bootcamp_cycle column, scoped by report_type + a
    submission-date window instead). rating is a MEETS/EXCEEDS/BELOW band on
    the average overall_average_class_observation_score, per the recruitment
    team's reference query (trainer_quality_summary_sql.sql).
    """
    where, params = build_where(
        districts=district, prefix="tq", district_col="district_name",
    )
    sql = f"""
    SELECT
      trainer_name,
      training_site AS venue,
      UPPER(district_name) AS district,
      AVG(CAST(overall_average_class_observation_score AS FLOAT64)) AS score,
      CASE
        WHEN AVG(CAST(overall_average_class_observation_score AS FLOAT64)) >= 4 THEN 'EXCEEDS'
        WHEN AVG(CAST(overall_average_class_observation_score AS FLOAT64)) >= 3 THEN 'MEETS'
        ELSE 'BELOW'
      END AS rating
    FROM {TRAINER_OBSERVATIONS}
    WHERE {where}
      AND report_type = 'rct_lesson_observation'
      AND trainer_name IS NOT NULL
      AND DATE(submission_date) BETWEEN @tq_start AND @tq_end
    GROUP BY trainer_name, venue, district
    ORDER BY score DESC
    """
    params = params + [
        _scalar("tq_start", "DATE", ACTIVE_COHORT_START_DATE),
        _scalar("tq_end", "DATE", ACTIVE_COHORT_END_DATE),
    ]
    rows = database.run_query(sql, params, role=user.role)
    for r in rows:
        r["trainer_name"] = mask_name(user.role, r.get("trainer_name"))
    return {"trainers": rows}


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
