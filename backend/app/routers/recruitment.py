"""
Recruitment endpoints — Awareness, Mobilisation, Acquisition, and TAM analysis.

Mobiliser leaderboards and youth personas carry personal names; those are masked
for the guest role via pii.mask_name before serialisation.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, Query

from app.auth import current_user, User
from app.core import database  # module import — required for the run_query test seam
from app.core.pii import mask_name, youth_id
from app.core.sql import build_where, cohort_clause
from app.core.tables import (
    RECRUITMENT_FUNNEL,
    MOBILISER_PERF,
    CHANNEL_PERF,
    TAM_PARISH,
    TAM_COVERAGE,
    YOUTHS,
    NOT_TEST_DATA,
)

router = APIRouter()


def _filter_extra(cohort, prefix):
    extra = [NOT_TEST_DATA]
    coh_clause, coh_params = cohort_clause(cohort, prefix=prefix)
    if coh_clause:
        extra.append((coh_clause, coh_params))
    return extra


def _stage_totals(stages, where, params, role):
    sql = f"""
    SELECT stage, SUM(youth_count) AS count
    FROM {RECRUITMENT_FUNNEL}
    WHERE {where} AND stage IN UNNEST(@stages)
    GROUP BY stage
    """
    from app.core.database import _array
    rows = database.run_query(sql, params + [_array("stages", "STRING", stages)], role=role)
    return {r["stage"]: (r["count"] or 0) for r in rows}


@router.get("/api/recruitment/awareness")
def awareness(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),
):
    """Registered -> Interested -> Eligible, with female share by district."""
    where, params = build_where(
        districts=district, gender=gender,
        extra=_filter_extra(cohort, "aw"), prefix="aw",
    )
    sql = f"""
    SELECT
      UPPER(district) AS district,
      SUM(IF(stage = 'Registered', youth_count, 0)) AS registered,
      SUM(IF(stage = 'Interested', youth_count, 0)) AS interested,
      SUM(IF(stage = 'Eligible',   youth_count, 0)) AS eligible
    FROM {RECRUITMENT_FUNNEL}
    WHERE {where}
    GROUP BY district
    ORDER BY district
    """
    return {"by_district": database.run_query(sql, params, role=user.role)}


@router.get("/api/recruitment/mobilisation")
def mobilisation(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),
):
    """Assigned -> Reached -> Confirmed with reach & mobilisation rates."""
    where, params = build_where(
        districts=district, gender=gender,
        extra=_filter_extra(cohort, "mo"), prefix="mo",
    )
    totals = _stage_totals(["Assigned", "Reached", "Confirmed"], where, params, user.role)
    assigned = totals.get("Assigned", 0)
    reached  = totals.get("Reached", 0)
    confirmed = totals.get("Confirmed", 0)
    return {
        "assigned": assigned,
        "reached": reached,
        "confirmed": confirmed,
        "reach_rate":        round(100 * reached / assigned, 1) if assigned else None,
        "mobilisation_rate": round(100 * confirmed / reached, 1) if reached else None,
    }


@router.get("/api/recruitment/acquisition")
def acquisition(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),
):
    """Verified -> Acquired by district."""
    where, params = build_where(
        districts=district, gender=gender,
        extra=_filter_extra(cohort, "ac"), prefix="ac",
    )
    sql = f"""
    SELECT
      UPPER(district) AS district,
      SUM(IF(stage = 'Verified', youth_count, 0)) AS verified,
      SUM(IF(stage = 'Acquired', youth_count, 0)) AS acquired
    FROM {RECRUITMENT_FUNNEL}
    WHERE {where}
    GROUP BY district
    ORDER BY district
    """
    return {"by_district": database.run_query(sql, params, role=user.role)}


@router.get("/api/recruitment/mobilisers")
def mobilisers(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),
):
    """Mobiliser leaderboard. Names masked to initials for the guest role."""
    where, params = build_where(
        districts=district,
        extra=_filter_extra(cohort, "mb"), prefix="mb",
    )
    sql = f"""
    SELECT mobiliser_name, UPPER(district) AS district,
           SUM(reached) AS reached, SUM(confirmed) AS confirmed
    FROM {MOBILISER_PERF}
    WHERE {where}
    GROUP BY mobiliser_name, district
    ORDER BY confirmed DESC
    """
    rows = database.run_query(sql, params, role=user.role)
    for r in rows:
        r["mobiliser_name"] = mask_name(user.role, r.get("mobiliser_name"))
    return {"mobilisers": rows}


@router.get("/api/recruitment/channels")
def channels(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),
):
    """Online vs offline channel funnel & efficiency."""
    where, params = build_where(
        districts=district,
        extra=_filter_extra(cohort, "ch"), prefix="ch",
    )
    sql = f"""
    SELECT channel, SUM(reached) AS reached, SUM(confirmed) AS confirmed, SUM(acquired) AS acquired
    FROM {CHANNEL_PERF}
    WHERE {where}
    GROUP BY channel
    ORDER BY acquired DESC
    """
    return {"channels": database.run_query(sql, params, role=user.role)}


@router.get("/api/recruitment/personas")
def personas(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),
    limit:    int = Query(200, ge=1, le=1000),
):
    """Youth profile / KYC rows. Names masked for guests; raw id never serialised."""
    where, params = build_where(
        districts=district, gender=gender,
        extra=_filter_extra(cohort, "pe"), prefix="pe",
    )
    from app.core.database import _scalar
    sql = f"""
    SELECT phone_number, name, gender, age, UPPER(district) AS district,
           parish, village, education, income, channel
    FROM {YOUTHS}
    WHERE {where}
    LIMIT @limit
    """
    rows = database.run_query(sql, params + [_scalar("limit", "INT64", limit)], role=user.role)
    out = []
    for r in rows:
        out.append({
            "youth_id": youth_id(r.pop("phone_number", None)),  # pseudonym replaces raw id
            "name": mask_name(user.role, r.get("name")),
            "gender": r.get("gender"),
            "age": r.get("age"),
            "district": r.get("district"),
            "parish": r.get("parish"),
            "village": r.get("village"),
            "education": r.get("education"),
            "income": r.get("income"),
            "channel": r.get("channel"),
        })
    return {"youth": out}


@router.get("/api/recruitment/forecast")
def forecast(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),
):
    """Mobilisation pace vs daily target (from the funnel mart's dated rows)."""
    where, params = build_where(
        districts=district,
        extra=_filter_extra(cohort, "fc"), prefix="fc",
    )
    sql = f"""
    SELECT event_date, SUM(youth_count) AS confirmed
    FROM {RECRUITMENT_FUNNEL}
    WHERE {where} AND stage = 'Confirmed' AND event_date IS NOT NULL
    GROUP BY event_date
    ORDER BY event_date
    """
    return {"daily": database.run_query(sql, params, role=user.role)}


@router.get("/api/recruitment/tam")
def tam(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
):
    """TAM / market share — parish-level predicted vs actual & validation rate."""
    where, params = build_where(districts=district, extra=[NOT_TEST_DATA], prefix="tm")
    sql = f"""
    SELECT UPPER(district) AS district, parish, predicted, actual,
           validation_rate, status, pct_female
    FROM {TAM_PARISH}
    WHERE {where}
    ORDER BY district, parish
    """
    return {"parishes": database.run_query(sql, params, role=user.role)}


@router.get("/api/recruitment/tam-coverage")
def tam_coverage(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
):
    """Parishes covered vs total per district, with cohort provenance."""
    where, params = build_where(districts=district, extra=[NOT_TEST_DATA], prefix="tc")
    sql = f"""
    SELECT UPPER(district) AS district, cycles, total_parishes, covered_parishes
    FROM {TAM_COVERAGE}
    WHERE {where}
    ORDER BY district
    """
    return {"coverage": database.run_query(sql, params, role=user.role)}
