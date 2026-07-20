"""
Implementation endpoints — Arrival, Attendance, Retention, Retention Calls,
Trainer Quality, Milestones, Youth Experience (NPS).

Trainer names are masked for the guest role.
"""

from typing import List

from fastapi import APIRouter, Depends, Query

from app.auth import current_user, User
from app.core import database  # module import — required for the run_query test seam
from app.core.pii import mask_name
from app.core.sql import build_where, cohort_clause
from app.core.tables import (
    ATTENDANCE_DAILY,
    ATTENDANCE_LESSON,
    RETENTION_VENUE,
    RETENTION_CALLS,
    TRAINER_QUALITY,
    MILESTONES,
    YOUTH_NPS,
    NOT_TEST_DATA,
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
    cohort: List[str] = Query(default=[]),
):
    """Daily attendance & net churn, plus per-lesson attendance %."""
    where_d, params_d = build_where(venues=venue, extra=_filter_extra(cohort, "ad"), prefix="ad")
    daily_sql = f"""
    SELECT event_date, SUM(present) AS present, SUM(net_churn) AS net_churn
    FROM {ATTENDANCE_DAILY}
    WHERE {where_d} AND event_date IS NOT NULL
    GROUP BY event_date
    ORDER BY event_date
    """
    where_l, params_l = build_where(venues=venue, extra=_filter_extra(cohort, "al"), prefix="al")
    lesson_sql = f"""
    SELECT lesson, AVG(attendance_pct) AS attendance_pct
    FROM {ATTENDANCE_LESSON}
    WHERE {where_l}
    GROUP BY lesson
    ORDER BY lesson
    """
    return {
        "daily":   database.run_query(daily_sql, params_d, role=user.role),
        "lessons": database.run_query(lesson_sql, params_l, role=user.role),
    }


@router.get("/api/implementation/retention")
def retention(
    user: User = Depends(current_user),
    venue: List[str] = Query(default=[]),
    cohort: List[str] = Query(default=[]),
):
    """Acquired -> activated -> retained per venue, against activation/retention targets."""
    where, params = build_where(venues=venue, extra=_filter_extra(cohort, "rt"), prefix="rt")
    sql = f"""
    SELECT UPPER(district) AS district, venue,
           SUM(acquired) AS acquired, SUM(activated) AS activated, SUM(retained) AS retained,
           SUM(female_retained) AS female_retained
    FROM {RETENTION_VENUE}
    WHERE {where}
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
    """Trainer observation scores. Names masked to initials for the guest role."""
    where, params = build_where(districts=district, extra=[NOT_TEST_DATA], prefix="tq")
    sql = f"""
    SELECT trainer_name, venue, UPPER(district) AS district, rating, score
    FROM {TRAINER_QUALITY}
    WHERE {where}
    ORDER BY score DESC
    """
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
