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
from app.core.sql import build_where, cohort_clause, normalized_parish_sql
from app.core.tables import (
    RECRUITMENT_FUNNEL,
    FUNNEL_STAGES,
    NOT_TEST_DATA,
    ACTIVE_COHORTS,
    AWARENESS_SUMMARY,
    AWARENESS_MEASURE_TARGET,
    DAILY_ACQUISITION_SUMMARY,
    DAILY_ACQUISITION_TARGETS_DEDUPED,
    DAILY_ACQ_MEASURE_ACTUAL,
    DAILY_ACQ_MEASURE_TARGET,
    SITE_FUNNEL_METRICS,
    SITE_FUNNEL_MEASURE_TARGET,
    SITE_FUNNEL_MEASURE_ACTUAL,
    AWARENESS_KYC,
    ACQUISITION_CALL_LOG,
    ATTENDANCE_SUMMARY,
    CONTROL_CALLS_BC4,
    RETENTION_ATTENDANCE_RAW,
    AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT,
    AUTO_CONFIRM_REGISTERED_SINCE_BY_COHORT,
    active_cohort_clause,
    resolve_active_cohorts,
    target_measure_where,
    TARGET_MEASURE_BY_COHORT,
    DEFAULT_TARGET_MEASURE,
)
from app.routers.recruitment import _auto_confirmed_count

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






def _stage_counts(district, gender, role, cohort=None):
    """The full Registered..Retained funnel spans three live tables (no single
    fact table covers it) — see app/core/tables.py. Query each and merge by
    stage. `gender`, when given, filters via build_where's usual gender_col
    mechanism against AWARENESS_KYC's real per-row gender column, and filters
    the other two tables' per-row gender column the same way; when omitted
    all three return their unfiltered totals. `cohort` restricts
    bootcamp_cycle to the requested selection (see resolve_active_cohorts)
    instead of the full ACTIVE_COHORTS set.

    Registered/Interested/Eligible are backed by AWARENESS_KYC (silver), not
    AWARENESS_SUMMARY (gold) — that mart lags live registrations by up to a
    day (confirmed 2026-08-05: showed far fewer registered than the live
    per-youth count), which fed straight into Executive Summary's headline
    numbers and made them diverge from the Recruitment/Mobilisation tabs
    (already migrated). See the AWARENESS_KYC comment in tables.py.

    Returns (stages, call_center_confirmed) — the second element is the
    call-center-only "confirmed" count (mo_row's total_acquired_youth,
    BEFORE auto_confirmed is added on). `stages["Confirmed"]` blends in the
    2.5-week auto-confirm pilot, which never goes through Reached at all —
    dividing the blended Confirmed by the unblended Reached can read above
    100% (verified live), so any Confirmed/Reached-style rate must use this
    call-center-only figure instead of stages["Confirmed"]."""
    aw_where, aw_params = build_where(
        districts=district, gender=gender,
        extra=[active_cohort_clause("scaw", requested=cohort)], prefix="scaw",
        district_col="youth_district", gender_col="youth_gender",
    )
    aw_sql = f"""
    SELECT COUNT(*) AS registered,
           COUNTIF(training_interest = TRUE) AS interested,
           COUNTIF(elligible = TRUE) AS eligible
    FROM {AWARENESS_KYC} WHERE {aw_where}
    """
    aw = (database.run_query(aw_sql, aw_params, role=role) or [{}])[0]

    # DAILY_ACQUISITION_TARGETS_DEDUPED (not the raw DAILY_ACQUISITION_SUMMARY
    # — see tables.py) for preload_youth: that table's 'targets'/'venue_targets'
    # rows are a live per-venue snapshot LOG, re-appended over time, so a plain
    # SUM over the raw table inflates "assigned" (confirmed live: ~5,480 raw
    # vs 2,073 correctly-deduped for BOOTCAMP_5). "assigned" only exists on
    # the district-grain 'targets'/'venue_targets' rows (no gender breakdown
    # available); reached/confirmed come from the real 'daily_aggregates' rows
    # on the raw table, which ARE gender-filterable and unaffected by the
    # snapshot-log duplication (only preload_youth/mobilisation_target are).
    #
    # target_measure_where (not a hardcoded measure = 'targets') — which
    # measure carries the real preload_youth/mobilisation_target differs by
    # cohort (see TARGET_MEASURE_BY_COHORT in tables.py): BOOTCAMP_5's real
    # figures live on 'venue_targets' (2,073), not 'targets' (1,995, a
    # different/wrong total for that cohort) — confirmed live 2026-08-05.
    # This also already scopes the requested cohort(s), so no separate
    # active_cohort_clause is added (per target_measure_where's docstring).
    moa_tm_where, moa_tm_params = target_measure_where("scmoa", resolve_active_cohorts(cohort))
    moa_where, moa_params = build_where(
        districts=district, extra=[(moa_tm_where, moa_tm_params)], prefix="scmoa",
        district_col="agent_district",
    )
    preload_assigned = (database.run_query(
        f"SELECT SUM(preload_youth) AS assigned FROM {DAILY_ACQUISITION_TARGETS_DEDUPED} WHERE {moa_where}",
        moa_params, role=role) or [{}])[0].get("assigned") or 0

    mor_where, mor_params = build_where(
        districts=district, gender=gender, extra=[active_cohort_clause("scmor", requested=cohort)], prefix="scmor",
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
    auto_confirmed = _auto_confirmed_count(district, gender, role, cohort)
    mo = {
        "assigned": preload_assigned + auto_confirmed,
        "reached": mo_row.get("reached") or 0,
        "confirmed": (mo_row.get("confirmed") or 0) + auto_confirmed,
    }

    sf_where, sf_params = build_where(
        districts=district, gender=gender, extra=[active_cohort_clause("scsf", requested=cohort)], prefix="scsf",
    )
    sf_sql = f"""
    SELECT SUM(IF(measure = '{SITE_FUNNEL_MEASURE_TARGET}', total_verified_youth, 0)) AS verified,
           SUM(IF(measure = '{SITE_FUNNEL_MEASURE_ACTUAL}', acquired_youth, 0)) AS acquired,
           SUM(IF(measure = '{SITE_FUNNEL_MEASURE_ACTUAL}', activated_youth, 0)) AS activated,
           SUM(IF(measure = '{SITE_FUNNEL_MEASURE_ACTUAL}', youth_80pct_lessons, 0)) AS retained
    FROM {SITE_FUNNEL_METRICS} WHERE {sf_where}
    """
    sf = (database.run_query(sf_sql, sf_params, role=role) or [{}])[0]

    stages = {
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
    call_center_confirmed = mo_row.get("confirmed") or 0
    return stages, call_center_confirmed


@router.get("/api/filters")
def get_filters(user: User = Depends(current_user)):
    """Universal filter options for the global filter bar (district / gender /
    cohort) — every option queried live from BigQuery, nothing hardcoded.

    district is sourced from DAILY_ACQUISITION_SUMMARY.agent_district alone,
    not unioned across every table that happens to carry a district-shaped
    column. That table is the one already driving every district filter on
    the Mobilisation tab and is treated as the canonical list of Busoga
    districts of operation; other tables' district-ish columns (youth_district
    on per-youth tables, "district" on SITE_FUNNEL_METRICS/CONTROL_CALLS_BC4)
    have carried out-of-region values (e.g. a youth's recorded home district
    landing outside Busoga), which a union would surface as if they were
    operational districts. gender/cohort still union across every table that
    carries them — those columns aren't prone to the same drift.
    """
    district_sources = [
        (DAILY_ACQUISITION_SUMMARY, "agent_district"),
    ]
    cohort_sources = [
        (AWARENESS_SUMMARY, "bootcamp_cycle"),
        (SITE_FUNNEL_METRICS, "bootcamp_cycle"),
        (AWARENESS_KYC, "bootcamp_cycle"),
        (DAILY_ACQUISITION_SUMMARY, "bootcamp_cycle"),
        (ACQUISITION_CALL_LOG, "bootcamp_cycle"),
        (ATTENDANCE_SUMMARY, "bootcamp_cycle"),
    ]
    gender_sources = [
        (AWARENESS_KYC, "youth_gender"),
        (DAILY_ACQUISITION_SUMMARY, "youth_gender"),
        (SITE_FUNNEL_METRICS, "gender"),
        (CONTROL_CALLS_BC4, "gender"),
        (RETENTION_ATTENDANCE_RAW, "youth_gender"),
    ]

    def _union_distinct(sources, upper=True):
        expr = "UPPER({col})" if upper else "{col}"
        parts = [
            f"SELECT DISTINCT {expr.format(col=col)} AS v FROM {table} WHERE {col} IS NOT NULL"
            for table, col in sources
        ]
        sql = " UNION DISTINCT ".join(parts) + " ORDER BY v"
        return [r["v"] for r in database.run_query(sql, role=user.role)]

    districts = [d for d in _union_distinct(district_sources) if d and d != "UNKNOWN"]
    # Cohort values are already a consistent "BOOTCAMP_4" style enum (see
    # tables.py) — no UPPER() here so a real value is never altered from what
    # active_cohort_clause's exact-match `IN UNNEST(@cycle)` expects.
    cohorts = _union_distinct(cohort_sources, upper=False) or ACTIVE_COHORTS
    genders = _union_distinct(gender_sources) or ["FEMALE", "MALE"]

    return {
        "districts": districts,
        "genders": genders,
        "cohorts": cohorts,
    }


@router.get("/api/overview/funnel")
def overview_funnel(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),
):
    """Stage-by-stage funnel counts with % of previous stage and youth lost."""
    by_stage, _ = _stage_counts(district, gender, user.role, cohort)
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


def _funnel_from_counts(stage_counts):
    """Same pct_of_previous/lost math as overview_funnel's own stage builder,
    for an explicit ordered {stage: count} dict rather than _stage_counts'
    full ten-stage output — used by overview_funnel_split's two independent
    early-funnel sequences and its merged late-funnel sequence."""
    out, prev = [], None
    for stage, count in stage_counts.items():
        count = count or 0
        pct_prev = round(100 * count / prev, 1) if prev else 100.0
        out.append({
            "stage": stage,
            "count": count,
            "pct_of_previous": pct_prev,
            "lost": (prev - count) if prev is not None else 0,
        })
        prev = count
    return out


@router.get("/api/overview/funnel-split")
def overview_funnel_split(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),
):
    """Splits the recruitment funnel into two genuinely different pathways
    with different SOURCE TABLES, then merges back into one shared funnel
    from Verified ("Arrival") onward — confirmed by the recruitment team,
    2026-08-06:

    - "BC3 Control List" is pure call-center/acquisition-model data — the
      same pathway mobilisation()'s four_week segment already reports
      (DAILY_ACQUISITION_SUMMARY: Assigned -> Reached -> Confirmed). This
      pool isn't sourced from the awareness table at all — no
      Registered/Interested/Eligible stages exist for it.
    - "New Recruits (have randomisation)" is the awareness table
      (AWARENESS_KYC): Registered -> Interested -> Eligible, then a
      Randomisation SPLIT (not a further linear stage) into Treatment vs
      Control, exposed as new_recruits_treatment/new_recruits_control.
      There's no separate "Confirmed" stage after that — confirmed with the
      recruitment team, 2026-08-06: every Treatment-arm youth is
      auto-confirmed by policy (mobilisation()'s two_half_week/
      _auto_confirmed_count), so Confirmed == new_recruits_treatment exactly;
      showing it as another linear stage would just repeat the same number.
      Control isn't attrition either — roughly half of eligible youth are
      deliberately held out by design as a comparison group.

    Both converge into ONE combined Verified/Acquired/Activated/Retained
    tail (SITE_FUNNEL_METRICS) — arrival onward doesn't distinguish pathway.
    """
    # BC3 Control List: the call-center pathway — same unblended queries
    # _stage_counts/mobilisation() use for their own four_week segment.
    # DAILY_ACQUISITION_TARGETS_DEDUPED + target_measure_where for Assigned
    # — see _stage_counts' docstring for why (snapshot-log dedup + the real
    # measure differing by cohort, e.g. BOOTCAMP_5's 'venue_targets').
    moa_tm_where, moa_tm_params = target_measure_where("fswl", resolve_active_cohorts(cohort))
    moa_where, moa_params = build_where(
        districts=district, extra=[(moa_tm_where, moa_tm_params)], prefix="fswl",
        district_col="agent_district",
    )
    waiting_assigned = (database.run_query(
        f"SELECT SUM(preload_youth) AS assigned FROM {DAILY_ACQUISITION_TARGETS_DEDUPED} WHERE {moa_where}",
        moa_params, role=user.role) or [{}])[0].get("assigned") or 0

    mor_where, mor_params = build_where(
        districts=district, gender=gender, extra=[active_cohort_clause("fswlr", requested=cohort)], prefix="fswlr",
        district_col="agent_district", gender_col="youth_gender",
    )
    mo_row = (database.run_query(
        f"SELECT SUM(total_youth_reached) AS reached, SUM(total_acquired_youth) AS confirmed "
        f"FROM {DAILY_ACQUISITION_SUMMARY} WHERE {mor_where} AND measure = '{DAILY_ACQ_MEASURE_ACTUAL}'",
        mor_params, role=user.role) or [{}])[0]

    waiting_list = _funnel_from_counts({
        "Assigned": waiting_assigned,
        "Reached": mo_row.get("reached"),
        "Confirmed": mo_row.get("confirmed"),
    })

    # New Recruits: the awareness table, split by RCT arm once eligible.
    aw_where, aw_params = build_where(
        districts=district, gender=gender,
        extra=[active_cohort_clause("fsnr", requested=cohort)], prefix="fsnr",
        district_col="youth_district", gender_col="youth_gender",
    )
    aw_sql = f"""
    SELECT COUNT(*) AS registered,
           COUNTIF(training_interest = TRUE) AS interested,
           COUNTIF(elligible = TRUE) AS eligible,
           COUNTIF(elligible = TRUE AND is_treatment = TRUE) AS treatment,
           COUNTIF(elligible = TRUE AND is_treatment = FALSE) AS control
    FROM {AWARENESS_KYC} WHERE {aw_where}
    """
    aw = (database.run_query(aw_sql, aw_params, role=user.role) or [{}])[0]
    treatment = aw.get("treatment") or 0
    control = aw.get("control") or 0

    # New Recruits' linear funnel ends at Eligible — Randomisation
    # (Treatment vs Control) is a split of that same population, not a
    # further drop-off stage, and Confirmed isn't shown separately either
    # since it's identical to the Treatment count (see docstring above).
    new_recruits = _funnel_from_counts({
        "Registered": aw.get("registered"),
        "Interested": aw.get("interested"),
        "Eligible": aw.get("eligible"),
    })
    new_recruits_treatment = treatment
    new_recruits_control = control

    sf_where, sf_params = build_where(
        districts=district, gender=gender, extra=[active_cohort_clause("fssf", requested=cohort)], prefix="fssf",
    )
    sf_sql = f"""
    SELECT SUM(IF(measure = '{SITE_FUNNEL_MEASURE_TARGET}', total_verified_youth, 0)) AS verified,
           SUM(IF(measure = '{SITE_FUNNEL_MEASURE_ACTUAL}', acquired_youth, 0)) AS acquired,
           SUM(IF(measure = '{SITE_FUNNEL_MEASURE_ACTUAL}', activated_youth, 0)) AS activated,
           SUM(IF(measure = '{SITE_FUNNEL_MEASURE_ACTUAL}', youth_80pct_lessons, 0)) AS retained
    FROM {SITE_FUNNEL_METRICS} WHERE {sf_where}
    """
    sf = (database.run_query(sf_sql, sf_params, role=user.role) or [{}])[0]
    merged = _funnel_from_counts({
        "Verified": sf.get("verified"),
        "Acquired": sf.get("acquired"),
        "Activated": sf.get("activated"),
        "Retained": sf.get("retained"),
    })

    return {
        "waiting_list": waiting_list,
        "new_recruits": new_recruits,
        "new_recruits_treatment": new_recruits_treatment,
        "new_recruits_control": new_recruits_control,
        "merged": merged,
    }


@router.get("/api/overview/kpis")
def overview_kpis(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),
):
    """Headline conversion KPIs derived from the funnel counts."""
    by_stage, call_center_confirmed = _stage_counts(district, gender, user.role, cohort)

    def rate(numerator, denominator):
        n, d = by_stage.get(numerator, 0), by_stage.get(denominator, 0)
        return round(100 * n / d, 1) if d else None

    # mobilisation_rate is call-center Confirmed ÷ call-center Reached, NOT
    # the blended by_stage["Confirmed"] ÷ Assigned — see _stage_counts'
    # docstring for why blending the auto-confirm pilot in here can read
    # above 100%.
    reached = by_stage.get("Reached") or 0
    mobilisation_rate = round(100 * call_center_confirmed / reached, 1) if reached else None

    return {
        "counts": by_stage,
        "rates": {
            "eligibility_rate":  rate("Eligible", "Interested"),
            "mobilisation_rate": mobilisation_rate,
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
    """Female / male share of each funnel stage, against the 60% female target.

    Spans the same three live tables as _stage_counts, but here every stage
    needs both genders side by side rather than a single filtered total, so
    each table is queried once with an explicit female/male breakdown.
    Registered/Interested/Eligible backed by AWARENESS_KYC (silver), not
    AWARENESS_SUMMARY (gold) — see the note at _stage_counts above.
    """
    aw_where, aw_params = build_where(
        districts=district, extra=[active_cohort_clause("gnaw", requested=cohort)], prefix="gnaw",
        district_col="youth_district",
    )
    aw_sql = f"""
    SELECT
      COUNTIF(UPPER(youth_gender) = 'FEMALE') AS registered_f,
      COUNTIF(UPPER(youth_gender) = 'MALE') AS registered_m,
      COUNTIF(training_interest = TRUE AND UPPER(youth_gender) = 'FEMALE') AS interested_f,
      COUNTIF(training_interest = TRUE AND UPPER(youth_gender) = 'MALE') AS interested_m,
      COUNTIF(elligible = TRUE AND UPPER(youth_gender) = 'FEMALE') AS eligible_f,
      COUNTIF(elligible = TRUE AND UPPER(youth_gender) = 'MALE') AS eligible_m
    FROM {AWARENESS_KYC} WHERE {aw_where}
    """
    aw = (database.run_query(aw_sql, aw_params, role=user.role) or [{}])[0]

    mo_where, mo_params = build_where(
        districts=district, extra=[active_cohort_clause("gnmo", requested=cohort)], prefix="gnmo",
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

    # Auto-confirmed pilot youth (see _auto_confirmed_count) do have gender on
    # record, unlike "assigned" — added onto Confirmed by gender below. Summed
    # per-gender across resolve_active_cohorts(cohort), same per-cycle dispatch
    # (subcounty vs registration-date) as _auto_confirmed_count.
    acf_by_gender = {}
    for cycle in resolve_active_cohorts(cohort):
        subcounties = AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT.get(cycle)
        since_date = AUTO_CONFIRM_REGISTERED_SINCE_BY_COHORT.get(cycle)
        if subcounties:
            acf_where, acf_params = build_where(
                districts=district,
                extra=[(f"bootcamp_cycle = @gnacf_cycle", [_scalar("gnacf_cycle", "STRING", cycle)])],
                prefix="gnacf", district_col="youth_district",
            )
            acf_sql = f"""
            SELECT UPPER(youth_gender) AS g, COUNT(*) AS n FROM {AWARENESS_KYC}
            WHERE {acf_where} AND elligible = TRUE AND is_treatment = TRUE
              AND UPPER(youth_subcounty) IN UNNEST(@gnacf_subcounties)
            GROUP BY g
            """
            acf_params = acf_params + [_array("gnacf_subcounties", "STRING", subcounties)]
            for r in database.run_query(acf_sql, acf_params, role=user.role):
                acf_by_gender[r["g"]] = acf_by_gender.get(r["g"], 0) + (r.get("n") or 0)
        elif since_date:
            acfd_where, acfd_params = build_where(
                districts=district,
                extra=[(f"bootcamp_cycle = @gnacfd_cycle", [_scalar("gnacfd_cycle", "STRING", cycle)])],
                prefix="gnacfd", district_col="youth_district",
            )
            acfd_sql = f"""
            SELECT COUNTIF(UPPER(youth_gender) = 'FEMALE') AS f,
                   COUNTIF(UPPER(youth_gender) = 'MALE') AS m
            FROM {AWARENESS_KYC}
            WHERE {acfd_where} AND elligible = TRUE AND is_treatment = TRUE
              AND report_date >= @gnacfd_since
            """
            acfd_params = acfd_params + [_scalar("gnacfd_since", "DATE", since_date)]
            row = (database.run_query(acfd_sql, acfd_params, role=user.role) or [{}])[0]
            acf_by_gender["FEMALE"] = acf_by_gender.get("FEMALE", 0) + (row.get("f") or 0)
            acf_by_gender["MALE"] = acf_by_gender.get("MALE", 0) + (row.get("m") or 0)

    sf_where, sf_params = build_where(
        districts=district, extra=[active_cohort_clause("gnsf", requested=cohort)], prefix="gnsf",
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
    cohort:   List[str] = Query(default=[]),
):
    """Each stage's count against a target: registration_target for
    Registered/Interested/Eligible, mobilisation_target for
    Assigned/Reached/Confirmed, acquisition_target for Verified/Acquired.
    Activated/Retained have no target-count column in the live tables, so
    their target is implied from docs/metrics.yaml's rate targets (90%/85%)
    applied to their own denominator — flagged via `target_is_implied`.
    """
    by_stage, _ = _stage_counts(district, gender, user.role, cohort)

    aw_where, aw_params = build_where(
        districts=district, extra=[active_cohort_clause("spaw", requested=cohort)], prefix="spaw",
        district_col="youth_district",
    )
    aw_target = (database.run_query(
        f"SELECT SUM(registration_target) AS t FROM {AWARENESS_SUMMARY} "
        f"WHERE {aw_where} AND data_measure = '{AWARENESS_MEASURE_TARGET}'",
        aw_params, role=user.role) or [{}])[0].get("t") or 0

    # mobilisation_target has no gender breakdown (only the 'targets'/
    # 'venue_targets' rows carry it, and those have no gender column at all
    # — see tables.py). DAILY_ACQUISITION_TARGETS_DEDUPED, not the raw table
    # — see the note in _stage_counts above on why a plain SUM over the raw
    # snapshot-log rows inflates this total. target_measure_where (not a
    # hardcoded measure = 'targets') — see the same note on why the real
    # measure differs by cohort.
    mo_tm_where, mo_tm_params = target_measure_where("spmo", resolve_active_cohorts(cohort))
    mo_where, mo_params = build_where(
        districts=district, extra=[(mo_tm_where, mo_tm_params)], prefix="spmo",
        district_col="agent_district",
    )
    mo_target = (database.run_query(
        f"SELECT SUM(mobilisation_target) AS t FROM {DAILY_ACQUISITION_TARGETS_DEDUPED} WHERE {mo_where}",
        mo_params, role=user.role) or [{}])[0].get("t") or 0

    sf_where, sf_params = build_where(
        districts=district, gender=gender, extra=[active_cohort_clause("spsf", requested=cohort)], prefix="spsf",
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
    cohort:   List[str] = Query(default=[]),
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
        districts=district, extra=[active_cohort_clause("eb", requested=cohort)], prefix="eb",
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
    ALL bootcamp cycles (BOOTCAMP_2..5) rather than pinning to ACTIVE_COHORTS
    — that's the point of a comparison view. registered/eligible come from
    AWARENESS_KYC (silver, not gold — see the note at _stage_counts; silver
    has full historical coverage for every cycle gold does, confirmed live
    2026-08-05), acquired/female share from SITE_FUNNEL_METRICS (no single
    live table spans both)."""
    aw_sql = f"""
    SELECT bootcamp_cycle, COUNT(*) AS registered, COUNTIF(elligible = TRUE) AS eligible
    FROM {AWARENESS_KYC}
    WHERE bootcamp_cycle IS NOT NULL
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
           COUNTIF(training_interest = TRUE) AS interested,
           COUNTIF(elligible = TRUE) AS eligible,
           COUNTIF(elligible = TRUE AND UPPER(youth_gender) = 'FEMALE') AS eligible_female,
           COUNT(DISTINCT {normalized_parish_sql()}) AS parishes
    FROM {AWARENESS_KYC}
    WHERE bootcamp_cycle IS NOT NULL
    GROUP BY bootcamp_cycle
    """
    # registration_target has no equivalent on AWARENESS_KYC (silver carries
    # no per-district/parish target column at all) — stays gold-sourced by
    # necessity, same exception as stage_progress's aw_target.
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
    # tables.py. DAILY_ACQUISITION_TARGETS_DEDUPED, not the raw table — see
    # the note at _stage_counts above on why a plain SUM over the raw
    # snapshot-log rows inflates preload_youth/mobilisation_target.
    moa_detail_sql = f"""
    SELECT bootcamp_cycle, SUM(preload_youth) AS assigned, SUM(mobilisation_target) AS target
    FROM {DAILY_ACQUISITION_TARGETS_DEDUPED}
    WHERE bootcamp_cycle IS NOT NULL AND measure = '{DAILY_ACQ_MEASURE_TARGET}'
    GROUP BY bootcamp_cycle
    """
    moa_by_cycle = {r["bootcamp_cycle"]: r for r in database.run_query(moa_detail_sql, role=user.role)}
    # Override any cohort whose real preload_youth/mobilisation_target live
    # on a different measure than the '{DAILY_ACQ_MEASURE_TARGET}' this query
    # is hardcoded to (see TARGET_MEASURE_BY_COHORT in tables.py) — currently
    # just BOOTCAMP_5, whose real figures are on 'venue_targets' (confirmed
    # live 2026-08-05: preload_youth 2,073 there vs 1,995 on 'targets', a
    # different/wrong total for that cohort).
    for cyc, measure in TARGET_MEASURE_BY_COHORT.items():
        if measure == DEFAULT_TARGET_MEASURE:
            continue
        row = (database.run_query(
            f"SELECT SUM(preload_youth) AS assigned, SUM(mobilisation_target) AS target "
            f"FROM {DAILY_ACQUISITION_TARGETS_DEDUPED} WHERE bootcamp_cycle = @tmc_cycle AND measure = @tmc_measure",
            [_scalar("tmc_cycle", "STRING", cyc), _scalar("tmc_measure", "STRING", measure)],
            role=user.role) or [{}])[0]
        if row.get("assigned") is not None or row.get("target") is not None:
            moa_by_cycle[cyc] = row

    mo_detail_sql = f"""
    SELECT bootcamp_cycle,
           SUM(total_youth_reached) AS reached,
           SUM(total_acquired_youth) AS confirmed,
           SUM(IF(UPPER(youth_gender) = 'FEMALE', total_acquired_youth, 0)) AS confirmed_female
    FROM {DAILY_ACQUISITION_SUMMARY}
    WHERE bootcamp_cycle IS NOT NULL AND measure = '{DAILY_ACQ_MEASURE_ACTUAL}'
    GROUP BY bootcamp_cycle
    """
    # Auto-confirmed pilot youth, added onto each cycle's confirmed count —
    # same per-cycle dispatch as _auto_confirmed_count (subcounty list for
    # BOOTCAMP_4 via AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT, registration-date
    # cutoff for BOOTCAMP_5 via AUTO_CONFIRM_REGISTERED_SINCE_BY_COHORT — see
    # tables.py). Previously only the subcounty mechanism was covered here,
    # silently leaving BOOTCAMP_5's entire 2.5-week pilot population out of
    # this comparison (unlike _stage_counts/mobilisation(), which already
    # used the shared, correct helper). The two dicts key disjoint cohorts,
    # so both loops write into the same auto_confirm_by_cycle without conflict.
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
    for cycle, since_date in AUTO_CONFIRM_REGISTERED_SINCE_BY_COHORT.items():
        acfd_sql = f"""
        SELECT COUNT(*) AS n, COUNTIF(UPPER(youth_gender) = 'FEMALE') AS n_female
        FROM {AWARENESS_KYC}
        WHERE bootcamp_cycle = @acfdc_cycle AND elligible = TRUE AND is_treatment = TRUE
          AND report_date >= @acfdc_since
        """
        acfd_params = [
            _scalar("acfdc_cycle", "STRING", cycle),
            _scalar("acfdc_since", "DATE", since_date),
        ]
        acfd_row = (database.run_query(acfd_sql, acfd_params, role=user.role) or [{}])[0]
        auto_confirm_by_cycle[cycle] = {"n": acfd_row.get("n") or 0, "n_female": acfd_row.get("n_female") or 0}

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
        call_center_confirmed = r.get("confirmed") or 0
        confirmed = call_center_confirmed + acf.get("n", 0)
        confirmed_female = (r.get("confirmed_female") or 0) + acf.get("n_female", 0)
        mobilisation_detail.append({
            "cohort": r["bootcamp_cycle"],
            "assigned": assigned,
            "reach_rate": round(100 * reached / four_week_assigned, 1) if four_week_assigned else None,
            # Call-center-only Confirmed ÷ Reached — NOT the blended `confirmed`
            # (which adds the 2.5-week auto-confirm pilot, never counted in
            # Reached) ÷ `assigned`, which can read above 100%. See
            # _stage_counts' docstring for the same distinction.
            "mobilisation_rate": round(100 * call_center_confirmed / reached, 1) if reached else None,
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
