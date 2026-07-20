"""
Field Operations endpoints — Meals, Venue compliance, Transport timeliness.
Venue-level aggregates only; no personal names.
"""

from typing import List

from fastapi import APIRouter, Depends, Query

from app.auth import current_user, User
from app.core import database  # module import — required for the run_query test seam
from app.core.sql import build_where, cohort_clause
from app.core.tables import MEALS, VENUE_COMPLIANCE, TRANSPORT, NOT_TEST_DATA

router = APIRouter()


def _filter_extra(cohort, prefix):
    extra = [NOT_TEST_DATA]
    coh_clause, coh_params = cohort_clause(cohort, prefix=prefix)
    if coh_clause:
        extra.append((coh_clause, coh_params))
    return extra


@router.get("/api/operations/meals")
def meals(
    user: User = Depends(current_user),
    venue: List[str] = Query(default=[]),
    cohort: List[str] = Query(default=[]),
):
    """Meal quality-rating distribution + per-venue menu compliance %."""
    where, params = build_where(venues=venue, extra=_filter_extra(cohort, "ml"), prefix="ml")
    rating_sql = f"""
    SELECT quality_rating, SUM(count) AS count
    FROM {MEALS}
    WHERE {where}
    GROUP BY quality_rating
    ORDER BY quality_rating
    """
    venue_sql = f"""
    SELECT venue, AVG(menu_compliance_pct) AS menu_compliance_pct
    FROM {MEALS}
    WHERE {where}
    GROUP BY venue
    ORDER BY venue
    """
    return {
        "quality_distribution": database.run_query(rating_sql, params, role=user.role),
        "by_venue":             database.run_query(venue_sql, params, role=user.role),
    }


@router.get("/api/operations/venue")
def venue_compliance(
    user: User = Depends(current_user),
    venue: List[str] = Query(default=[]),
    cohort: List[str] = Query(default=[]),
):
    """Per-venue compliance: reports filed, compliant, and rate."""
    where, params = build_where(venues=venue, extra=_filter_extra(cohort, "vn"), prefix="vn")
    sql = f"""
    SELECT venue, UPPER(district) AS district,
           SUM(reports) AS reports, SUM(compliant) AS compliant
    FROM {VENUE_COMPLIANCE}
    WHERE {where}
    GROUP BY venue, district
    ORDER BY district, venue
    """
    rows = database.run_query(sql, params, role=user.role)
    for r in rows:
        reports = r.get("reports") or 0
        r["compliance_rate"] = round(100 * (r.get("compliant") or 0) / reports, 1) if reports else None
    return {"by_venue": rows}


@router.get("/api/operations/transport")
def transport(
    user: User = Depends(current_user),
    venue: List[str] = Query(default=[]),
    cohort: List[str] = Query(default=[]),
):
    """Per-site transport timeliness score (0-100)."""
    where, params = build_where(venues=venue, extra=_filter_extra(cohort, "tr"), prefix="tr")
    sql = f"""
    SELECT venue, UPPER(district) AS district, AVG(timeliness_score) AS timeliness_score
    FROM {TRANSPORT}
    WHERE {where}
    GROUP BY venue, district
    ORDER BY timeliness_score DESC
    """
    return {"by_site": database.run_query(sql, params, role=user.role)}
