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
from app.core.database import _array, _scalar
from app.core.sql import build_where, cohort_clause
from app.core.tables import (
    RECRUITMENT_FUNNEL,
    FUNNEL_STAGES,
    NOT_TEST_DATA,
    ACTIVE_COHORT,
    AWARENESS_SUMMARY,
    AWARENESS_MEASURE_ACTUAL,
    AWARENESS_MEASURE_TARGET,
    DAILY_ACQUISITION_SUMMARY,
    DAILY_ACQ_MEASURE_ACTUAL,
    DAILY_ACQ_MEASURE_TARGET,
    SITE_FUNNEL_METRICS,
    SITE_FUNNEL_MEASURE_TARGET,
    SITE_FUNNEL_MEASURE_ACTUAL,
    AWARENESS_KYC,
    AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT,
    active_cohort_clause,
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


def _auto_confirmed_count(district, gender, role):
    """Eligible + treatment-assigned youth from this cohort's short-cycle pilot
    subcounties (see AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT in tables.py) — added
    on top of DAILY_ACQUISITION_SUMMARY's confirmed count, never looked up
    inside it (they bypass its call-center process entirely)."""
    subcounties = AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT.get(ACTIVE_COHORT)
    if not subcounties:
        return 0
    where, params = build_where(
        districts=district, gender=gender,
        extra=[active_cohort_clause("acf")], prefix="acf",
        district_col="youth_district", gender_col="youth_gender",
    )
    sql = f"""
    SELECT COUNT(*) AS n FROM {AWARENESS_KYC}
    WHERE {where} AND elligible = TRUE AND is_treatment = TRUE
      AND UPPER(youth_subcounty) IN UNNEST(@acf_subcounties)
    """
    params = params + [_array("acf_subcounties", "STRING", subcounties)]
    return (database.run_query(sql, params, role=role) or [{}])[0].get("n") or 0


def _stage_counts(district, gender, role):
    """The full Registered..Retained funnel spans three live tables (no single
    fact table covers it) — see app/core/tables.py. Query each and merge by
    stage. `gender`, when given, filters AWARENESS_SUMMARY by selecting its
    female/male columns and filters the other two tables' per-row gender
    column; when omitted all three return their unfiltered totals."""
    g = (gender or "").strip().lower()
    if g == "female":
        reg_col, int_col, elig_col = "total_registered_female", "total_interested_female", "total_eligible_female"
    elif g == "male":
        reg_col, int_col, elig_col = "total_registered_male", "total_interested_male", "total_eligible_male"
    else:
        reg_col, int_col, elig_col = "total_registered_youth", "total_interested_youth", "total_eligible_youth"

    aw_where, aw_params = build_where(
        districts=district, extra=[active_cohort_clause("scaw")], prefix="scaw",
        district_col="youth_district",
    )
    aw_sql = f"""
    SELECT SUM({reg_col}) AS registered, SUM({int_col}) AS interested, SUM({elig_col}) AS eligible
    FROM {AWARENESS_SUMMARY} WHERE {aw_where} AND data_measure = '{AWARENESS_MEASURE_ACTUAL}'
    """
    aw = (database.run_query(aw_sql, aw_params, role=role) or [{}])[0]

    # DAILY_ACQUISITION_SUMMARY mixes three `measure` row types (see tables.py):
    # "assigned" only exists on the district-grain 'targets' rows (no gender
    # split available); reached/confirmed come from the real 'daily_aggregates'
    # rows, which are gender-filterable.
    moa_where, moa_params = build_where(
        districts=district, extra=[active_cohort_clause("scmoa")], prefix="scmoa",
        district_col="agent_district",
    )
    preload_assigned = (database.run_query(
        f"SELECT SUM(preload_youth) AS assigned FROM {DAILY_ACQUISITION_SUMMARY} "
        f"WHERE {moa_where} AND measure = '{DAILY_ACQ_MEASURE_TARGET}'",
        moa_params, role=role) or [{}])[0].get("assigned") or 0

    mor_where, mor_params = build_where(
        districts=district, gender=gender, extra=[active_cohort_clause("scmor")], prefix="scmor",
        district_col="agent_district", gender_col="youth_gender",
    )
    # Read into fresh locals rather than mutating the row dict in place — it
    # may be the exact object cache.py's TTLCache is holding (returned by
    # reference), and an additive mutation would compound on every cache hit.
    mo_row = (database.run_query(
        f"SELECT SUM(total_youth_reached) AS reached, SUM(total_acquired_youth) AS confirmed "
        f"FROM {DAILY_ACQUISITION_SUMMARY} WHERE {mor_where} AND measure = '{DAILY_ACQ_MEASURE_ACTUAL}'",
        mor_params, role=role) or [{}])[0]
    # Auto-confirmed pilot-subcounty youth never entered the preload list
    # either — added onto both assigned and confirmed (see tables.py).
    auto_confirmed = _auto_confirmed_count(district, gender, role)
    mo = {
        "assigned": preload_assigned + auto_confirmed,
        "reached": mo_row.get("reached") or 0,
        "confirmed": (mo_row.get("confirmed") or 0) + auto_confirmed,
    }

    sf_where, sf_params = build_where(
        districts=district, gender=gender, extra=[active_cohort_clause("scsf")], prefix="scsf",
    )
    sf_sql = f"""
    SELECT SUM(IF(measure = '{SITE_FUNNEL_MEASURE_TARGET}', total_verified_youth, 0)) AS verified,
           SUM(IF(measure = '{SITE_FUNNEL_MEASURE_ACTUAL}', acquired_youth, 0)) AS acquired,
           SUM(IF(measure = '{SITE_FUNNEL_MEASURE_ACTUAL}', activated_youth, 0)) AS activated,
           SUM(IF(measure = '{SITE_FUNNEL_MEASURE_ACTUAL}', youth_80pct_lessons, 0)) AS retained
    FROM {SITE_FUNNEL_METRICS} WHERE {sf_where}
    """
    sf = (database.run_query(sf_sql, sf_params, role=role) or [{}])[0]

    return {
        "Registered": aw.get("registered") or 0,
        "Interested": aw.get("interested") or 0,
        "Eligible":   aw.get("eligible") or 0,
        "Assigned":   mo.get("assigned") or 0,
        "Reached":    mo.get("reached") or 0,
        "Confirmed":  mo.get("confirmed") or 0,
        "Verified":   sf.get("verified") or 0,
        "Acquired":   sf.get("acquired") or 0,
        "Activated":  sf.get("activated") or 0,
        "Retained":   sf.get("retained") or 0,
    }


@router.get("/api/filters")
def get_filters(user: User = Depends(current_user)):
    """Distinct filter options for the global filter bar (district / gender / cohort).

    Districts come from the youth-facing live tables (AWARENESS_SUMMARY,
    SITE_FUNNEL_METRICS) — DAILY_ACQUISITION_SUMMARY's agent_district is
    excluded here since it's the *calling agent's* location (includes
    non-Busoga districts like Jinja/Mbarara), not the youth's. Genders and
    cohorts aren't queried: gender is a fixed Female/Male dimension, and cohort
    is pinned to ACTIVE_COHORT (see tables.py) until BC5 lands.
    """
    cycle_param = _scalar("cycle", "STRING", ACTIVE_COHORT)
    sql = f"""
    SELECT DISTINCT UPPER(youth_district) AS district
    FROM {AWARENESS_SUMMARY}
    WHERE bootcamp_cycle = @cycle AND youth_district IS NOT NULL AND UPPER(youth_district) != 'UNKNOWN'
    UNION DISTINCT
    SELECT DISTINCT UPPER(district) AS district
    FROM {SITE_FUNNEL_METRICS}
    WHERE bootcamp_cycle = @cycle AND district IS NOT NULL
    ORDER BY district
    """
    rows = database.run_query(sql, [cycle_param], role=user.role)
    return {
        "districts": [r["district"] for r in rows],
        "genders": ["FEMALE", "MALE"],
        "cohorts": [ACTIVE_COHORT],
    }


@router.get("/api/overview/funnel")
def overview_funnel(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),  # accepted but unused — see ACTIVE_COHORT
):
    """Stage-by-stage funnel counts with % of previous stage and youth lost."""
    by_stage = _stage_counts(district, gender, user.role)
    ordered = sorted(
        ({"stage": s, "count": c} for s, c in by_stage.items()),
        key=lambda r: _STAGE_ORDER.get(r["stage"], 999),
    )

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
    cohort:   List[str] = Query(default=[]),  # accepted but unused — see ACTIVE_COHORT
):
    """Headline conversion KPIs derived from the funnel counts."""
    by_stage = _stage_counts(district, gender, user.role)

    def rate(numerator, denominator):
        n, d = by_stage.get(numerator, 0), by_stage.get(denominator, 0)
        return round(100 * n / d, 1) if d else None

    return {
        "counts": by_stage,
        "rates": {
            "eligibility_rate":  rate("Eligible", "Interested"),
            "mobilisation_rate": rate("Confirmed", "Assigned"),
            "acquisition_rate":  rate("Acquired", "Confirmed"),
            "activation_rate":   rate("Activated", "Acquired"),
            "retention_rate":    rate("Retained", "Activated"),
        },
    }


@router.get("/api/overview/gender")
def overview_gender(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),  # accepted but unused — see ACTIVE_COHORT
):
    """Female / male share of each funnel stage, against the 60% female target.

    Spans the same three live tables as _stage_counts, but here every stage
    needs both genders side by side rather than a single filtered total, so
    each table is queried once with an explicit female/male breakdown.
    """
    aw_where, aw_params = build_where(
        districts=district, extra=[active_cohort_clause("gnaw")], prefix="gnaw",
        district_col="youth_district",
    )
    aw_sql = f"""
    SELECT
      SUM(total_registered_female) AS registered_f, SUM(total_registered_male) AS registered_m,
      SUM(total_interested_female) AS interested_f, SUM(total_interested_male) AS interested_m,
      SUM(total_eligible_female)   AS eligible_f,   SUM(total_eligible_male)   AS eligible_m
    FROM {AWARENESS_SUMMARY} WHERE {aw_where} AND data_measure = '{AWARENESS_MEASURE_ACTUAL}'
    """
    aw = (database.run_query(aw_sql, aw_params, role=user.role) or [{}])[0]

    mo_where, mo_params = build_where(
        districts=district, extra=[active_cohort_clause("gnmo")], prefix="gnmo",
        district_col="agent_district",
    )
    # "assigned" (preload_youth) has no gender breakdown at all in this table
    # (see tables.py) — omitted here rather than showing an always-zero value;
    # reached/confirmed are scoped to the real per-day rows.
    mo_sql = f"""
    SELECT UPPER(youth_gender) AS g,
           SUM(total_youth_reached) AS reached, SUM(total_acquired_youth) AS confirmed
    FROM {DAILY_ACQUISITION_SUMMARY} WHERE {mo_where} AND measure = '{DAILY_ACQ_MEASURE_ACTUAL}'
    GROUP BY g
    """
    # Note: mo_by_gender's dicts may be the exact objects cache.py's TTLCache
    # holds (returned by reference) — read from them, never mutate in place,
    # or an additive change would compound on every cache hit.
    mo_by_gender = {r["g"]: r for r in database.run_query(mo_sql, mo_params, role=user.role)}

    # Auto-confirmed pilot-subcounty youth (see _auto_confirmed_count) do have
    # gender on record, unlike "assigned" — added onto Confirmed by gender below.
    acf_by_gender = {}
    auto_confirm_subcounties = AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT.get(ACTIVE_COHORT)
    if auto_confirm_subcounties:
        acf_where, acf_params = build_where(
            districts=district, extra=[active_cohort_clause("gnacf")], prefix="gnacf",
            district_col="youth_district",
        )
        acf_sql = f"""
        SELECT UPPER(youth_gender) AS g, COUNT(*) AS n FROM {AWARENESS_KYC}
        WHERE {acf_where} AND elligible = TRUE AND is_treatment = TRUE
          AND UPPER(youth_subcounty) IN UNNEST(@gnacf_subcounties)
        GROUP BY g
        """
        acf_params = acf_params + [_array("gnacf_subcounties", "STRING", auto_confirm_subcounties)]
        acf_by_gender = {r["g"]: r.get("n") or 0 for r in database.run_query(acf_sql, acf_params, role=user.role)}

    sf_where, sf_params = build_where(
        districts=district, extra=[active_cohort_clause("gnsf")], prefix="gnsf",
    )
    # No per-gender VERIFIED figure exists — total_verified_youth only lives on
    # the genderless 'site_targets' rows (see tables.py's SITE_FUNNEL_METRICS
    # note), so this query is scoped to measure = SITE_FUNNEL_MEASURE_ACTUAL
    # (the gender-split rows) and doesn't select verified at all.
    sf_sql = f"""
    SELECT UPPER(gender) AS g, SUM(acquired_youth) AS acquired,
           SUM(activated_youth) AS activated, SUM(youth_80pct_lessons) AS retained
    FROM {SITE_FUNNEL_METRICS} WHERE {sf_where} AND measure = '{SITE_FUNNEL_MEASURE_ACTUAL}'
    GROUP BY g
    """
    sf_by_gender = {r["g"]: r for r in database.run_query(sf_sql, sf_params, role=user.role)}

    def sf(field, g):
        return (sf_by_gender.get(g) or {}).get(field) or 0

    def mo(field, g):
        return (mo_by_gender.get(g) or {}).get(field) or 0

    stage_gender = {
        "Registered": (aw.get("registered_f") or 0, aw.get("registered_m") or 0),
        "Interested": (aw.get("interested_f") or 0, aw.get("interested_m") or 0),
        "Eligible":   (aw.get("eligible_f") or 0, aw.get("eligible_m") or 0),
        "Assigned":   (mo("assigned", "FEMALE"), mo("assigned", "MALE")),
        "Reached":    (mo("reached", "FEMALE"), mo("reached", "MALE")),
        "Confirmed":  (mo("confirmed", "FEMALE") + acf_by_gender.get("FEMALE", 0),
                       mo("confirmed", "MALE") + acf_by_gender.get("MALE", 0)),
        # Verified has no gender breakdown available (see sf_sql comment above)
        # — None (not 0) so callers don't mistake "not tracked" for "zero".
        "Verified":   (None, None),
        "Acquired":   (sf("acquired", "FEMALE"), sf("acquired", "MALE")),
        "Activated":  (sf("activated", "FEMALE"), sf("activated", "MALE")),
        "Retained":   (sf("retained", "FEMALE"), sf("retained", "MALE")),
    }
    out = []
    for stage in FUNNEL_STAGES:
        female, male = stage_gender[stage]
        has_data = female is not None or male is not None
        total = (female or 0) + (male or 0)
        out.append({
            "stage": stage,
            "female": female,
            "male": male,
            "pct_female": round(100 * female / total, 1) if has_data and total else None,
            "target_female": 60.0,
        })
    return {"stages": out}


@router.get("/api/overview/stage-progress")
def stage_progress(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
):
    """Each stage's count against a target: registration_target for
    Registered/Interested/Eligible, mobilisation_target for
    Assigned/Reached/Confirmed, acquisition_target for Verified/Acquired.
    Activated/Retained have no target-count column in the live tables, so
    their target is implied from docs/metrics.yaml's rate targets (90%/85%)
    applied to their own denominator — flagged via `target_is_implied`.
    """
    by_stage = _stage_counts(district, gender, user.role)

    aw_where, aw_params = build_where(
        districts=district, extra=[active_cohort_clause("spaw")], prefix="spaw",
        district_col="youth_district",
    )
    aw_target = (database.run_query(
        f"SELECT SUM(registration_target) AS t FROM {AWARENESS_SUMMARY} "
        f"WHERE {aw_where} AND data_measure = '{AWARENESS_MEASURE_TARGET}'",
        aw_params, role=user.role) or [{}])[0].get("t") or 0

    # mobilisation_target has no gender breakdown (only the 'targets' rows
    # carry it, and those have no gender column at all — see tables.py).
    mo_where, mo_params = build_where(
        districts=district, extra=[active_cohort_clause("spmo")], prefix="spmo",
        district_col="agent_district",
    )
    mo_target = (database.run_query(
        f"SELECT SUM(mobilisation_target) AS t FROM {DAILY_ACQUISITION_SUMMARY} "
        f"WHERE {mo_where} AND measure = '{DAILY_ACQ_MEASURE_TARGET}'",
        mo_params, role=user.role) or [{}])[0].get("t") or 0

    sf_where, sf_params = build_where(
        districts=district, gender=gender, extra=[active_cohort_clause("spsf")], prefix="spsf",
    )
    sf_target = (database.run_query(
        f"SELECT SUM(acquisition_target) AS t FROM {SITE_FUNNEL_METRICS} WHERE {sf_where}",
        sf_params, role=user.role) or [{}])[0].get("t") or 0

    targets = {
        "Registered": aw_target, "Interested": aw_target, "Eligible": aw_target,
        "Assigned": mo_target, "Reached": mo_target, "Confirmed": mo_target,
        "Verified": sf_target, "Acquired": sf_target,
        "Activated": round((by_stage.get("Acquired") or 0) * 0.90),
        "Retained":  round((by_stage.get("Activated") or 0) * 0.85),
    }
    implied = {"Activated", "Retained"}

    out = []
    for stage in FUNNEL_STAGES:
        count = by_stage.get(stage) or 0
        target = targets.get(stage) or 0
        out.append({
            "stage": stage,
            "count": count,
            "target": target,
            "pct_of_target": round(100 * count / target, 1) if target else None,
            "target_is_implied": stage in implied,
        })
    return {"stages": out}


@router.get("/api/overview/eligibility-barriers")
def eligibility_barriers(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),  # accepted but unused — see ACTIVE_COHORT
):
    """Among reached youth who did not qualify, which criteria they failed.

    Backed by the live AWARENESS_KYC per-youth record. Each of the five
    documented eligibility criteria (docs/metrics.yaml: age 18-30, education
    P5-S3, income <= UGX 30,000/2wk, training interest, no prior Educate!
    training) is counted independently among elligible=FALSE rows — a youth
    can fail more than one. training_interest and participated_educate_training
    are confirmed real BOOLEAN columns on this table (unlike the reference
    prototype, which only had an illustrative ~12% estimate for prior training).
    """
    where, params = build_where(
        districts=district, extra=[active_cohort_clause("eb")], prefix="eb",
        district_col="youth_district",
    )
    sql = f"""
    SELECT 'Age (18-30)' AS barrier, COUNTIF(youth_age < 18 OR youth_age > 30) AS count
    FROM {AWARENESS_KYC} WHERE {where} AND elligible = FALSE
    UNION ALL
    SELECT 'Education (P5-S3)' AS barrier,
           COUNTIF(youth_level_of_education NOT IN ('P5','P6','P7','S1','S2','S3') OR youth_level_of_education IS NULL) AS count
    FROM {AWARENESS_KYC} WHERE {where} AND elligible = FALSE
    UNION ALL
    SELECT 'Income (> UGX 30,000/2wk)' AS barrier, COUNTIF(income_past_2_weeks > 30000) AS count
    FROM {AWARENESS_KYC} WHERE {where} AND elligible = FALSE
    UNION ALL
    SELECT 'No training interest' AS barrier, COUNTIF(training_interest = FALSE) AS count
    FROM {AWARENESS_KYC} WHERE {where} AND elligible = FALSE
    UNION ALL
    SELECT 'Previously trained (E! alumni)' AS barrier, COUNTIF(participated_educate_training = TRUE) AS count
    FROM {AWARENESS_KYC} WHERE {where} AND elligible = FALSE
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
    """Cycle-by-cycle side-by-side: eligible / acquired / female share / overall
    conversion. Unlike every other overview endpoint this deliberately spans
    ALL bootcamp cycles (BOOTCAMP_2..4, MINI_BOOTCAMP_3) rather than pinning to
    ACTIVE_COHORT — that's the point of a comparison view. registered/eligible
    come from AWARENESS_SUMMARY, acquired/female share from SITE_FUNNEL_METRICS
    (no single live table spans both)."""
    aw_sql = f"""
    SELECT bootcamp_cycle, SUM(total_registered_youth) AS registered, SUM(total_eligible_youth) AS eligible
    FROM {AWARENESS_SUMMARY}
    WHERE bootcamp_cycle IS NOT NULL AND data_measure = '{AWARENESS_MEASURE_ACTUAL}'
    GROUP BY bootcamp_cycle
    """
    aw_by_cycle = {r["bootcamp_cycle"]: r for r in database.run_query(aw_sql, role=user.role)}

    sf_sql = f"""
    SELECT bootcamp_cycle, SUM(acquired_youth) AS acquired,
           SUM(IF(UPPER(gender) = 'FEMALE', acquired_youth, 0)) AS female_acquired
    FROM {SITE_FUNNEL_METRICS}
    WHERE bootcamp_cycle IS NOT NULL AND measure = '{SITE_FUNNEL_MEASURE_ACTUAL}'
    GROUP BY bootcamp_cycle
    """
    sf_by_cycle = {r["bootcamp_cycle"]: r for r in database.run_query(sf_sql, role=user.role)}

    cycles = sorted(set(aw_by_cycle) | set(sf_by_cycle))
    out = []
    for cycle in cycles:
        aw, sf = aw_by_cycle.get(cycle, {}), sf_by_cycle.get(cycle, {})
        registered, eligible = aw.get("registered") or 0, aw.get("eligible") or 0
        acquired, female_acquired = sf.get("acquired") or 0, sf.get("female_acquired") or 0
        out.append({
            "cohort": cycle,
            "eligible": eligible,
            "acquired": acquired,
            "pct_female": round(100 * female_acquired / acquired, 1) if acquired else None,
            "overall_conversion": round(100 * acquired / registered, 1) if registered else None,
        })

    # Richer per-domain cohort breakdown for the Cohort Comparison page (three
    # separate tables — Awareness / Mobilisation / Acquisition — each cycle
    # against its own target and female share).
    aw_detail_sql = f"""
    SELECT bootcamp_cycle,
           SUM(total_interested_youth) AS interested,
           SUM(total_eligible_youth) AS eligible,
           SUM(total_eligible_female) AS eligible_female,
           COUNT(DISTINCT youth_parish) AS parishes
    FROM {AWARENESS_SUMMARY}
    WHERE bootcamp_cycle IS NOT NULL AND data_measure = '{AWARENESS_MEASURE_ACTUAL}'
    GROUP BY bootcamp_cycle
    """
    aw_target_sql = f"""
    SELECT bootcamp_cycle, SUM(registration_target) AS target
    FROM {AWARENESS_SUMMARY}
    WHERE bootcamp_cycle IS NOT NULL AND data_measure = '{AWARENESS_MEASURE_TARGET}'
    GROUP BY bootcamp_cycle
    """
    aw_target_by_cycle = {r["bootcamp_cycle"]: r["target"] for r in database.run_query(aw_target_sql, role=user.role)}
    awareness_detail = []
    for r in database.run_query(aw_detail_sql, role=user.role):
        eligible, interested = r.get("eligible") or 0, r.get("interested") or 0
        eligible_female = r.get("eligible_female") or 0
        target = aw_target_by_cycle.get(r["bootcamp_cycle"]) or 0
        awareness_detail.append({
            "cohort": r["bootcamp_cycle"],
            "eligible": eligible,
            "eligibility_rate": round(100 * eligible / interested, 1) if interested else None,
            "pct_female": round(100 * eligible_female / eligible, 1) if eligible else None,
            "progress_pct": round(100 * eligible / target, 1) if target else None,
            "parishes": r.get("parishes") or 0,
        })
    awareness_detail.sort(key=lambda r: r["cohort"])

    # assigned/target only exist on the 'targets' rows (district-grain, no
    # gender column); reached/confirmed/confirmed_female come from the real
    # 'daily_aggregates' rows — see the DAILY_ACQUISITION_SUMMARY comment in
    # tables.py. Summing the table unfiltered double/triple-counts.
    moa_detail_sql = f"""
    SELECT bootcamp_cycle, SUM(preload_youth) AS assigned, SUM(mobilisation_target) AS target
    FROM {DAILY_ACQUISITION_SUMMARY}
    WHERE bootcamp_cycle IS NOT NULL AND measure = '{DAILY_ACQ_MEASURE_TARGET}'
    GROUP BY bootcamp_cycle
    """
    moa_by_cycle = {r["bootcamp_cycle"]: r for r in database.run_query(moa_detail_sql, role=user.role)}

    mo_detail_sql = f"""
    SELECT bootcamp_cycle,
           SUM(total_youth_reached) AS reached,
           SUM(total_acquired_youth) AS confirmed,
           SUM(IF(UPPER(youth_gender) = 'FEMALE', total_acquired_youth, 0)) AS confirmed_female
    FROM {DAILY_ACQUISITION_SUMMARY}
    WHERE bootcamp_cycle IS NOT NULL AND measure = '{DAILY_ACQ_MEASURE_ACTUAL}'
    GROUP BY bootcamp_cycle
    """
    # Auto-confirmed pilot-subcounty youth, added onto each cycle's confirmed
    # count (see _auto_confirmed_count / tables.py) — only cycles listed in
    # AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT get an adjustment.
    auto_confirm_by_cycle = {}
    for cycle, subcounties in AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT.items():
        acf_sql = f"""
        SELECT COUNT(*) AS n, SUM(IF(UPPER(youth_gender) = 'FEMALE', 1, 0)) AS n_female
        FROM {AWARENESS_KYC}
        WHERE bootcamp_cycle = @acfc_cycle AND elligible = TRUE AND is_treatment = TRUE
          AND UPPER(youth_subcounty) IN UNNEST(@acfc_subcounties)
        """
        acf_params = [
            _scalar("acfc_cycle", "STRING", cycle),
            _array("acfc_subcounties", "STRING", subcounties),
        ]
        acf_row = (database.run_query(acf_sql, acf_params, role=user.role) or [{}])[0]
        auto_confirm_by_cycle[cycle] = {"n": acf_row.get("n") or 0, "n_female": acf_row.get("n_female") or 0}

    # Read into fresh locals rather than mutating `r` in place — it may be the
    # exact object cache.py's TTLCache is holding, and an additive mutation
    # would compound on every cache hit.
    mobilisation_detail = []
    for r in database.run_query(mo_detail_sql, role=user.role):
        moa = moa_by_cycle.get(r["bootcamp_cycle"], {})
        acf = auto_confirm_by_cycle.get(r["bootcamp_cycle"], {})
        # Auto-confirmed youth never entered the preload list either — added
        # onto both assigned and confirmed (see tables.py). "Reached" only
        # exists for the 4-week cycle, so its rate must use the 4-week-only
        # assigned count (moa), never the combined total, as its denominator.
        four_week_assigned = moa.get("assigned") or 0
        assigned = four_week_assigned + acf.get("n", 0)
        target = moa.get("target") or 0
        reached = r.get("reached") or 0
        confirmed = (r.get("confirmed") or 0) + acf.get("n", 0)
        confirmed_female = (r.get("confirmed_female") or 0) + acf.get("n_female", 0)
        mobilisation_detail.append({
            "cohort": r["bootcamp_cycle"],
            "assigned": assigned,
            "reach_rate": round(100 * reached / four_week_assigned, 1) if four_week_assigned else None,
            "mobilisation_rate": round(100 * confirmed / assigned, 1) if assigned else None,
            "progress_pct": round(100 * confirmed / target, 1) if target else None,
            "pct_female": round(100 * confirmed_female / confirmed, 1) if confirmed else None,
        })
    mobilisation_detail.sort(key=lambda r: r["cohort"])

    ac_detail_sql = f"""
    SELECT bootcamp_cycle,
           SUM(IF(measure = '{SITE_FUNNEL_MEASURE_TARGET}', total_verified_youth, 0)) AS verified,
           SUM(IF(measure = '{SITE_FUNNEL_MEASURE_ACTUAL}', acquired_youth, 0)) AS acquired,
           SUM(IF(measure = '{SITE_FUNNEL_MEASURE_TARGET}', acquisition_target, 0)) AS target,
           SUM(IF(measure = '{SITE_FUNNEL_MEASURE_ACTUAL}' AND UPPER(gender) = 'FEMALE', acquired_youth, 0)) AS acquired_female
    FROM {SITE_FUNNEL_METRICS}
    WHERE bootcamp_cycle IS NOT NULL
    GROUP BY bootcamp_cycle
    """
    acquisition_detail = []
    for r in database.run_query(ac_detail_sql, role=user.role):
        verified, acquired = r.get("verified") or 0, r.get("acquired") or 0
        target, acquired_female = r.get("target") or 0, r.get("acquired_female") or 0
        registered = aw_by_cycle.get(r["bootcamp_cycle"], {}).get("registered") or 0
        acquisition_detail.append({
            "cohort": r["bootcamp_cycle"],
            "acquired": acquired,
            "acquisition_rate": round(100 * acquired / verified, 1) if verified else None,
            "overall_conversion": round(100 * acquired / registered, 1) if registered else None,
            "progress_pct": round(100 * acquired / target, 1) if target else None,
            "pct_female": round(100 * acquired_female / acquired, 1) if acquired else None,
        })
    acquisition_detail.sort(key=lambda r: r["cohort"])

    return {
        "cohorts": out,
        "awareness": awareness_detail,
        "mobilisation": mobilisation_detail,
        "acquisition": acquisition_detail,
    }
