"""
Overview / Executive Summary endpoints.

The recruitment funnel, gender split, eligibility barriers, drop-off analysis
and cohort comparison — the "one screen" view. Backed by gold_eba marts; guest
role sees the same aggregates (no personal names at this altitude).
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, Query

from app.auth import current_user, User
from app.core import database  # module import — required for the run_query test seam
from app.core.sql import build_where, cohort_clause
from app.core.tables import (
    RECRUITMENT_FUNNEL,
    GENDER_STAGE,
    ELIGIBILITY_BARRIERS,
    COHORT_SUMMARY,
    FUNNEL_STAGES,
    NOT_TEST_DATA,
)

router = APIRouter()

# Canonical ordering index so funnel stages come back in pipeline order regardless
# of how BigQuery groups them.
_STAGE_ORDER = {s: i for i, s in enumerate(FUNNEL_STAGES)}


def _filter_extra(cohort, prefix):
    """Universal filters every reported query carries: test-data exclusion + cohort."""
    extra = [NOT_TEST_DATA]
    coh_clause, coh_params = cohort_clause(cohort, prefix=prefix)
    if coh_clause:
        extra.append((coh_clause, coh_params))
    return extra


@router.get("/api/filters")
def get_filters(user: User = Depends(current_user)):
    """Distinct filter options for the global filter bar (district / gender / cohort)."""
    sql = f"""
    SELECT
      ARRAY_AGG(DISTINCT UPPER(district) IGNORE NULLS ORDER BY UPPER(district))               AS districts,
      ARRAY_AGG(DISTINCT UPPER(COALESCE(gender, 'UNKNOWN')) IGNORE NULLS
                ORDER BY UPPER(COALESCE(gender, 'UNKNOWN')))                                    AS genders,
      ARRAY_AGG(DISTINCT cohort IGNORE NULLS ORDER BY cohort)                                  AS cohorts
    FROM {RECRUITMENT_FUNNEL}
    WHERE {NOT_TEST_DATA}
    """
    rows = database.run_query(sql, role=user.role)
    return rows[0] if rows else {"districts": [], "genders": [], "cohorts": []}


@router.get("/api/overview/funnel")
def overview_funnel(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),
):
    """Stage-by-stage funnel counts with % of previous stage and youth lost."""
    where, params = build_where(
        districts=district, gender=gender,
        extra=_filter_extra(cohort, "fn"), prefix="fn",
    )
    sql = f"""
    SELECT stage, SUM(youth_count) AS count
    FROM {RECRUITMENT_FUNNEL}
    WHERE {where}
    GROUP BY stage
    """
    rows = database.run_query(sql, params, role=user.role)
    ordered = sorted(rows, key=lambda r: _STAGE_ORDER.get(r["stage"], 999))

    out, prev = [], None
    for r in ordered:
        count = r["count"] or 0
        pct_prev = round(100 * count / prev, 1) if prev else 100.0
        out.append({
            "stage": r["stage"],
            "count": count,
            "pct_of_previous": pct_prev,
            "lost": (prev - count) if prev is not None else 0,
        })
        prev = count
    return {"stages": out}


@router.get("/api/overview/kpis")
def overview_kpis(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),
):
    """Headline conversion KPIs derived from the funnel counts."""
    where, params = build_where(
        districts=district, gender=gender,
        extra=_filter_extra(cohort, "kp"), prefix="kp",
    )
    sql = f"""
    SELECT stage, SUM(youth_count) AS count
    FROM {RECRUITMENT_FUNNEL}
    WHERE {where}
    GROUP BY stage
    """
    rows = database.run_query(sql, params, role=user.role)
    by_stage = {r["stage"]: (r["count"] or 0) for r in rows}

    def rate(numerator, denominator):
        n, d = by_stage.get(numerator, 0), by_stage.get(denominator, 0)
        return round(100 * n / d, 1) if d else None

    return {
        "counts": by_stage,
        "rates": {
            "eligibility_rate":  rate("Eligible", "Interested"),
            "mobilisation_rate": rate("Confirmed", "Reached"),
            "acquisition_rate":  rate("Acquired", "Confirmed"),
            "activation_rate":   rate("Activated", "Acquired"),
            "retention_rate":    rate("Retained", "Activated"),
        },
    }


@router.get("/api/overview/gender")
def overview_gender(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),
):
    """Female / male share of each funnel stage, against the 60% female target."""
    where, params = build_where(
        districts=district,
        extra=_filter_extra(cohort, "gn"), prefix="gn",
    )
    sql = f"""
    SELECT
      stage,
      SUM(IF(UPPER(gender) = 'FEMALE', youth_count, 0)) AS female,
      SUM(IF(UPPER(gender) = 'MALE',   youth_count, 0)) AS male,
      SUM(youth_count) AS total
    FROM {GENDER_STAGE}
    WHERE {where}
    GROUP BY stage
    """
    rows = database.run_query(sql, params, role=user.role)
    ordered = sorted(rows, key=lambda r: _STAGE_ORDER.get(r["stage"], 999))
    for r in ordered:
        total = r["total"] or 0
        r["pct_female"] = round(100 * (r["female"] or 0) / total, 1) if total else None
        r["target_female"] = 60.0
    return {"stages": ordered}


@router.get("/api/overview/eligibility-barriers")
def eligibility_barriers(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),
):
    """Among reached youth who did not qualify, which criteria they failed."""
    where, params = build_where(
        districts=district,
        extra=_filter_extra(cohort, "eb"), prefix="eb",
    )
    sql = f"""
    SELECT barrier, SUM(youth_count) AS count
    FROM {ELIGIBILITY_BARRIERS}
    WHERE {where}
    GROUP BY barrier
    ORDER BY count DESC
    """
    return {"barriers": database.run_query(sql, params, role=user.role)}


@router.get("/api/overview/dropoff")
def overview_dropoff(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),
):
    """Derived: absolute youth lost between consecutive funnel stages, largest first."""
    where, params = build_where(
        districts=district, gender=gender,
        extra=_filter_extra(cohort, "do"), prefix="do",
    )
    sql = f"""
    SELECT stage, SUM(youth_count) AS count
    FROM {RECRUITMENT_FUNNEL}
    WHERE {where}
    GROUP BY stage
    """
    rows = database.run_query(sql, params, role=user.role)
    ordered = sorted(rows, key=lambda r: _STAGE_ORDER.get(r["stage"], 999))

    drops, prev = [], None
    for r in ordered:
        count = r["count"] or 0
        if prev is not None:
            drops.append({
                "from_stage": ordered[len(drops)]["stage"],
                "to_stage": r["stage"],
                "lost": prev - count,
            })
        prev = count
    drops.sort(key=lambda d: d["lost"], reverse=True)
    return {"dropoffs": drops}


@router.get("/api/overview/cohort-comparison")
def cohort_comparison(user: User = Depends(current_user)):
    """BC2..BC5 side-by-side: eligible / acquired / female share / overall conversion."""
    sql = f"""
    SELECT
      cohort,
      SUM(eligible)  AS eligible,
      SUM(acquired)  AS acquired,
      SAFE_DIVIDE(SUM(female_acquired), NULLIF(SUM(acquired), 0)) * 100 AS pct_female,
      SAFE_DIVIDE(SUM(acquired), NULLIF(SUM(registered), 0)) * 100      AS overall_conversion
    FROM {COHORT_SUMMARY}
    WHERE {NOT_TEST_DATA}
    GROUP BY cohort
    ORDER BY cohort
    """
    return {"cohorts": database.run_query(sql, role=user.role)}
