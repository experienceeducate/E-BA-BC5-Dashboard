"""
Recruitment endpoints — Awareness, Mobilisation, Acquisition, and TAM analysis.

Mobiliser leaderboards and youth personas carry personal names; those are masked
for the guest role via pii.mask_name before serialisation.
"""

import re
from typing import List, Optional

from fastapi import APIRouter, Depends, Query

from app.auth import current_user, User
from app.core import database  # module import — required for the run_query test seam
from app.core.database import _array, _scalar
from app.core.pii import mask_name, youth_id
from app.core.question_themes import classify_question
from app.core.sql import build_where, cohort_clause, date_clauses, multiselect_array_sql, normalized_parish_sql
from app.core.tables import (
    RECRUITMENT_FUNNEL,
    MOBILISER_PERF,
    CHANNEL_PERF,
    TAM_PARISH,
    TAM_COVERAGE,
    NOT_TEST_DATA,
    AWARENESS_SUMMARY,
    AWARENESS_MEASURE_ACTUAL,
    AWARENESS_MEASURE_TARGET,
    DAILY_ACQUISITION_SUMMARY,
    DAILY_ACQUISITION_TARGETS_DEDUPED,
    DAILY_ACQ_MEASURE_ACTUAL,
    DAILY_ACQ_MEASURE_TARGET,
    ONLINE_COLLECTION_TYPE,
    OFFLINE_COLLECTION_TYPE,
    SITE_FUNNEL_METRICS,
    SITE_FUNNEL_MEASURE_TARGET,
    SITE_FUNNEL_MEASURE_ACTUAL,
    AWARENESS_KYC,
    ACTIVE_COHORTS,
    AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT,
    AUTO_CONFIRM_REGISTERED_SINCE_BY_COHORT,
    CONTROL_CALLS_BC4,
    ACQUISITION_CALL_LOG,
    BC5_ACQUISITION_CALLS,
    active_cohort_clause,
    resolve_active_cohorts,
    venue_mobilisation_target,
    AWARENESS_ELIGIBLE_TARGET_BC5,
    target_measure_where,
    canonical_parish_sql,
    canonical_venue_sql,
    PARISH_TARGETS_BC5,
)

router = APIRouter()


def _auto_confirmed_count(district, gender, role, cohort=None, date_from=None, date_to=None):
    """Youth auto-confirmed by policy as part of a cohort's short-cycle
    ("2.5-week") pilot — bypassing daily_acquisition_summary's call-center
    reach/confirm process entirely, so added on top of that table's confirmed
    count, never looked up inside it. Summed across resolve_active_cohorts(cohort)
    (the requested cohort filter, or every cycle in ACTIVE_COHORTS when none is
    given); each cycle's pilot is scoped by whichever mechanism tables.py has
    on file for it — BOOTCAMP_4 by subcounty (AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT),
    BOOTCAMP_5 by registration date (AUTO_CONFIRM_REGISTERED_SINCE_BY_COHORT,
    temporary — see tables.py). Both mechanisms filter elligible=TRUE AND
    is_treatment=TRUE — confirmed with the recruitment team, 2026-08-04: the
    date-window mechanism used to sum ALL registrants regardless of arm
    (AWARENESS_SUMMARY has no treatment split), which over-counted against a
    treatment-only target (Buluta: was summing ~57 registered against a
    target of 12, >100% progress that was actually the wrong population in
    the numerator). Now both mechanisms query the same record-level
    AWARENESS_KYC with the same filter, just a different eligibility
    condition (subcounty list vs date cutoff)."""
    total = 0
    for cycle in resolve_active_cohorts(cohort):
        subcounties = AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT.get(cycle)
        since_date = AUTO_CONFIRM_REGISTERED_SINCE_BY_COHORT.get(cycle)
        if subcounties:
            where, params = build_where(
                districts=district, gender=gender,
                extra=[(f"bootcamp_cycle = @acf_cycle", [_scalar("acf_cycle", "STRING", cycle)])] + _date_extra("report_date", date_from, date_to, "acf"),
                prefix="acf", district_col="youth_district", gender_col="youth_gender",
            )
            sql = f"""
            SELECT COUNT(*) AS n FROM {AWARENESS_KYC}
            WHERE {where} AND elligible = TRUE AND is_treatment = TRUE
              AND UPPER(youth_subcounty) IN UNNEST(@acf_subcounties)
            """
            params = params + [_array("acf_subcounties", "STRING", subcounties)]
            total += (database.run_query(sql, params, role=role) or [{}])[0].get("n") or 0
        elif since_date:
            where, params = build_where(
                districts=district, gender=gender,
                extra=[(f"bootcamp_cycle = @acfd_cycle", [_scalar("acfd_cycle", "STRING", cycle)])] + _date_extra("report_date", date_from, date_to, "acfd"),
                prefix="acfd", district_col="youth_district", gender_col="youth_gender",
            )
            sql = f"""
            SELECT COUNT(*) AS n FROM {AWARENESS_KYC}
            WHERE {where} AND elligible = TRUE AND is_treatment = TRUE
              AND report_date >= @acfd_since
            """
            params = params + [_scalar("acfd_since", "DATE", since_date)]
            total += (database.run_query(sql, params, role=role) or [{}])[0].get("n") or 0
    return total


def _auto_pathway_registered_count(district, gender, role, cohort=None, date_from=None, date_to=None):
    """Total REGISTERED youth in the auto-confirm pathway's own scope (same
    subcounties/date-window as _auto_confirmed_count) — "reached" for the
    2.5-week cycle, since this pathway has no call-center reach step at all;
    registration itself is where a youth enters it. Confirmed by the
    recruitment team, 2026-08-04 — there's no "assigned" figure for this
    pathway either (it never had a preload list), so callers should show that
    as unavailable (None), not default it to this count or to auto_confirmed.

    Subcounty mechanism (BOOTCAMP_4): WITHOUT the `elligible = TRUE AND
    is_treatment = TRUE` filter — a genuinely bigger number than
    _auto_confirmed_count (every registrant, not just eligible+treatment
    ones), unchanged since this distinction is intentional there.

    Date-window mechanism (BOOTCAMP_5): DOES now apply the same eligible+
    treatment filter as _auto_confirmed_count (changed 2026-08-04 alongside
    it — see that function's docstring) — so reached=confirmed for this
    pathway again, as originally intended, rather than reached being
    inflated by control-arm and not-yet-assigned registrants."""
    total = 0
    for cycle in resolve_active_cohorts(cohort):
        subcounties = AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT.get(cycle)
        since_date = AUTO_CONFIRM_REGISTERED_SINCE_BY_COHORT.get(cycle)
        if subcounties:
            where, params = build_where(
                districts=district, gender=gender,
                extra=[(f"bootcamp_cycle = @apr_cycle", [_scalar("apr_cycle", "STRING", cycle)])] + _date_extra("report_date", date_from, date_to, "apr"),
                prefix="apr", district_col="youth_district", gender_col="youth_gender",
            )
            sql = f"""
            SELECT COUNT(*) AS n FROM {AWARENESS_KYC}
            WHERE {where} AND UPPER(youth_subcounty) IN UNNEST(@apr_subcounties)
            """
            params = params + [_array("apr_subcounties", "STRING", subcounties)]
            total += (database.run_query(sql, params, role=role) or [{}])[0].get("n") or 0
        elif since_date:
            where, params = build_where(
                districts=district, gender=gender,
                extra=[(f"bootcamp_cycle = @aprd_cycle", [_scalar("aprd_cycle", "STRING", cycle)])] + _date_extra("report_date", date_from, date_to, "aprd"),
                prefix="aprd", district_col="youth_district", gender_col="youth_gender",
            )
            sql = f"""
            SELECT COUNT(*) AS n FROM {AWARENESS_KYC}
            WHERE {where} AND elligible = TRUE AND is_treatment = TRUE
              AND report_date >= @aprd_since
            """
            params = params + [_scalar("aprd_since", "DATE", since_date)]
            total += (database.run_query(sql, params, role=role) or [{}])[0].get("n") or 0
    return total


def _auto_confirmed_by_parish(district, role, cohort=None, date_from=None, date_to=None):
    """_auto_confirmed_count's exact per-cohort scoping (eligible+treatment
    filter — the real "confirmed" definition for this pathway), grouped by
    (district, parish) instead of summed to one total. Feeds the combined
    per-parish figures in mobilisation_heatmap() — see its docstring for why
    a parish's call-center reached/confirmed alone can be zero while this
    pathway's numbers are real. Confirmed = reached for this pathway (no
    separate call-center-style reach step exists for it — see
    _auto_pathway_registered_count).

    Keyed on UPPER(parish) to match DAILY_ACQUISITION_SUMMARY's venue_parish
    and PARISH_TARGETS_BC5's parish, both already-uppercase in the live data,
    but never assume that without normalising here too."""
    out = {}
    for cycle in resolve_active_cohorts(cohort):
        subcounties = AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT.get(cycle)
        since_date = AUTO_CONFIRM_REGISTERED_SINCE_BY_COHORT.get(cycle)
        if subcounties:
            where, params = build_where(
                districts=district,
                extra=[(f"bootcamp_cycle = @acbp_cycle", [_scalar("acbp_cycle", "STRING", cycle)])] + _date_extra("report_date", date_from, date_to, "acbp"),
                prefix="acbp", district_col="youth_district",
            )
            sql = f"""
            SELECT UPPER(youth_district) AS district, {canonical_parish_sql("youth_parish")} AS parish,
                   COUNT(*) AS n, COUNTIF(UPPER(youth_gender) = 'FEMALE') AS nf
            FROM {AWARENESS_KYC}
            WHERE {where} AND elligible = TRUE AND is_treatment = TRUE
              AND UPPER(youth_subcounty) IN UNNEST(@acbp_subcounties)
            GROUP BY district, parish
            """
            params = params + [_array("acbp_subcounties", "STRING", subcounties)]
            rows = database.run_query(sql, params, role=role)
        elif since_date:
            # Filtered to elligible=TRUE AND is_treatment=TRUE, matching
            # _auto_confirmed_count's date-based branch (changed 2026-08-04)
            # — was previously summing ALL registrants (both arms) from
            # AWARENESS_SUMMARY against a treatment-only target, which is
            # what pushed parish progress % over 100% (e.g. Buluta: ~57
            # all-registrants vs a treatment target of 12).
            where, params = build_where(
                districts=district,
                extra=[(f"bootcamp_cycle = @acbpd_cycle", [_scalar("acbpd_cycle", "STRING", cycle)])] + _date_extra("report_date", date_from, date_to, "acbpd"),
                prefix="acbpd", district_col="youth_district",
            )
            sql = f"""
            SELECT UPPER(youth_district) AS district, {canonical_parish_sql("youth_parish")} AS parish,
                   COUNT(*) AS n, COUNTIF(UPPER(youth_gender) = 'FEMALE') AS nf
            FROM {AWARENESS_KYC}
            WHERE {where} AND elligible = TRUE AND is_treatment = TRUE
              AND report_date >= @acbpd_since
            GROUP BY district, parish
            """
            params = params + [_scalar("acbpd_since", "DATE", since_date)]
            rows = database.run_query(sql, params, role=role)
        else:
            rows = []
        for r in rows:
            key = (r["district"], r["parish"])
            e = out.setdefault(key, {"n": 0, "nf": 0})
            e["n"] += r.get("n") or 0
            e["nf"] += r.get("nf") or 0
    return out


def _mobilisation_target_by_parish_bc5(district, role):
    """The REAL call-center mobilisation target, per parish, for BOOTCAMP_5 —
    PARISH_TARGETS_BC5's control_mobilised_target, NOT DAILY_ACQUISITION_
    SUMMARY's own mobilisation_target column. Confirmed live with the
    recruitment team, 2026-08-04: that column is a data-pipeline artifact —
    it's an EXACT duplicate of total_new_recruits_awareness_eligible_target
    for every single BC5 parish (verified across all 26), not an independent
    mobilisation figure at all. control_mobilised_target is materially
    different (e.g. Buluta: 59 vs the duplicated 29) and is the number to use.
    No venue grain exists for this column — by_venue keeps the (duplicated,
    but only available) DAILY_ACQUISITION_SUMMARY figure until a real
    per-venue mobilisation target exists.

    NOT filtered to category = 'New Recruits' — confirmed live 2026-08-05,
    NAKIBENGO WARD (Mayuge) is the one PARISH_TARGETS_BC5 row with category
    NULL instead (a BC3 control-arm population, not "New Recruits"), but it
    still carries a real, non-zero control_mobilised_target (17) that the
    call center is actively working toward. That filter was silently
    dropping this parish's target to 0/blank; every OTHER row in the sheet
    is 'New Recruits' (confirmed: only these two category values exist), so
    removing the filter adds exactly this one legitimate parish and changes
    nothing else."""
    where, params = build_where(
        districts=district, prefix="pmt", district_col="district",
    )
    rows = database.run_query(
        f"""
        SELECT UPPER(district) AS district, UPPER(parish) AS parish,
               SUM(control_mobilised_target) AS target
        FROM {PARISH_TARGETS_BC5} WHERE {where}
        GROUP BY district, parish
        """,
        params, role=role)
    return {(r["district"], r["parish"]): round(r.get("target") or 0) for r in rows}


def _filter_extra(cohort, prefix):
    extra = [NOT_TEST_DATA]
    coh_clause, coh_params = cohort_clause(cohort, prefix=prefix)
    if coh_clause:
        extra.append((coh_clause, coh_params))
    return extra


# Wraps date_clauses' (clauses_list, params_list) into a build_where `extra`
# entry (a list with zero or one (clause, params) tuple) -- so every
# Mobilisation date-range filter below is one line: `extra=[...] + _date_extra(...)`.
# Only ever spliced onto queries against a table with a genuine per-record
# date column (call_date/report_date/date_added/call_timestamp) -- never onto
# a static target/planning snapshot (e.g. DAILY_ACQUISITION_TARGETS_DEDUPED,
# PARISH_TARGETS_BC5), which has no date concept to filter by.
def _date_extra(date_col_expr, date_from, date_to, prefix):
    clauses, params = date_clauses(date_col_expr, date_from, date_to, prefix)
    return [(" AND ".join(clauses), params)] if clauses else []


@router.get("/api/recruitment/awareness")
def awareness(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),
):
    """Registered -> Interested -> Eligible, with female share by district.

    Backed by the live AWARENESS_SUMMARY mart (pre-aggregated per mobiliser/
    day/district). There's no per-row gender column to filter on — a gender
    filter instead selects that gender's own summary columns.
    """
    g = (gender or "").strip().lower()
    if g == "female":
        reg_col, int_col, elig_col = "total_registered_female", "total_interested_female", "total_eligible_female"
    elif g == "male":
        reg_col, int_col, elig_col = "total_registered_male", "total_interested_male", "total_eligible_male"
    else:
        reg_col, int_col, elig_col = "total_registered_youth", "total_interested_youth", "total_eligible_youth"

    where, params = build_where(
        districts=district,
        extra=[active_cohort_clause("aw", requested=cohort)], prefix="aw",
        district_col="youth_district",
    )
    actual_sql = f"""
    SELECT
      UPPER(youth_district) AS district,
      SUM({reg_col}) AS registered,
      SUM({int_col}) AS interested,
      SUM({elig_col}) AS eligible,
      ROUND(SAFE_DIVIDE(SUM(total_eligible_female), NULLIF(SUM(total_eligible_youth), 0)) * 100, 1) AS pct_female
    FROM {AWARENESS_SUMMARY}
    WHERE {where} AND data_measure = '{AWARENESS_MEASURE_ACTUAL}'
    GROUP BY district
    """
    target_sql = f"""
    SELECT UPPER(youth_district) AS district, SUM(registration_target) AS target
    FROM {AWARENESS_SUMMARY}
    WHERE {where} AND data_measure = '{AWARENESS_MEASURE_TARGET}'
    GROUP BY district
    """
    target_by_district = {r["district"]: r["target"] for r in database.run_query(target_sql, params, role=user.role)}
    rows = database.run_query(actual_sql, params, role=user.role)
    for r in rows:
        r["target"] = target_by_district.get(r["district"])
    rows.sort(key=lambda r: r["district"])
    return {"by_district": rows}


@router.get("/api/recruitment/awareness-parish")
def awareness_parish(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),
):
    """Reached/interested/eligible/target/% female at parish grain, for the
    Awareness tab's "Category detail — by parish" table. Backed by the live
    per-youth AWARENESS_KYC record (silver_eba.eba_bootcamp_awareness), not
    the gold AWARENESS_SUMMARY mart — that mart lags live registrations by up
    to a day (confirmed 2026-08-05: showed 1,213 registered when the live
    per-youth count was already 1,896), which fed straight into every card on
    this page. Each row is one youth, so reached/interested/eligible and
    their gender splits are all plain COUNT(*)/COUNTIF(...) instead of
    summing pre-aggregated columns.

    Also carries the RCT Treatment/Control split behind the "Eligible youth —
    RCT assignment" card, from this same table's per-youth `is_treatment`
    BOOL column (TRUE/FALSE/NULL = Treatment/Control/Unassigned) — confirmed
    live 2026-08-05 to match the gold mart's own treatment/control totals
    exactly for both cohorts that carry it (BOOTCAMP_4: 596/100 vs gold's
    ~11% of eligible; BOOTCAMP_5: 870/679 vs gold's ~84%), and additionally
    to only ever be set on rows where elligible = TRUE (so scoping to
    `elligible = TRUE AND is_treatment = ...` below is belt-and-braces, not a
    behavior change). BOOTCAMP_2/3 carry no is_treatment data on this table
    at all (same 0%/fully-randomized-elsewhere gap the gold mart had for
    those cohorts). Exposed as eligible_treatment(_female/_male) and
    eligible_control(_female/_male); the frontend derives Unassigned as
    eligible minus treatment minus control, per row.

    `target` is the hardcoded AWARENESS_ELIGIBLE_TARGET_BC5 sheet only —
    unlike the gold mart, AWARENESS_KYC carries no per-district/parish target
    column, so there's no live fallback; `target_source` is "hardcoded" or
    None, never "live"."""
    where, params = build_where(
        districts=district,
        extra=[active_cohort_clause("awp", requested=cohort)], prefix="awp",
        district_col="youth_district",
    )
    actual_sql = f"""
    SELECT
      UPPER(youth_district) AS district,
      {normalized_parish_sql()} AS parish,
      COUNT(*) AS reached,
      COUNTIF(UPPER(youth_gender) = 'FEMALE') AS reached_female,
      COUNTIF(UPPER(youth_gender) = 'MALE') AS reached_male,
      COUNTIF(training_interest = TRUE) AS interested,
      COUNTIF(training_interest = TRUE AND UPPER(youth_gender) = 'FEMALE') AS interested_female,
      COUNTIF(training_interest = TRUE AND UPPER(youth_gender) = 'MALE') AS interested_male,
      COUNTIF(elligible = TRUE) AS eligible,
      COUNTIF(elligible = TRUE AND UPPER(youth_gender) = 'FEMALE') AS eligible_female,
      COUNTIF(elligible = TRUE AND UPPER(youth_gender) = 'MALE') AS eligible_male,
      ROUND(SAFE_DIVIDE(COUNTIF(elligible = TRUE AND UPPER(youth_gender) = 'FEMALE'), NULLIF(COUNTIF(elligible = TRUE), 0)) * 100, 1) AS pct_female,
      COUNTIF(elligible = TRUE AND is_treatment = TRUE) AS eligible_treatment,
      COUNTIF(elligible = TRUE AND is_treatment = TRUE AND UPPER(youth_gender) = 'FEMALE') AS eligible_treatment_female,
      COUNTIF(elligible = TRUE AND is_treatment = TRUE AND UPPER(youth_gender) = 'MALE') AS eligible_treatment_male,
      COUNTIF(elligible = TRUE AND is_treatment = FALSE) AS eligible_control,
      COUNTIF(elligible = TRUE AND is_treatment = FALSE AND UPPER(youth_gender) = 'FEMALE') AS eligible_control_female,
      COUNTIF(elligible = TRUE AND is_treatment = FALSE AND UPPER(youth_gender) = 'MALE') AS eligible_control_male
    FROM {AWARENESS_KYC}
    WHERE {where} AND youth_parish IS NOT NULL
    GROUP BY district, parish
    """
    rows = database.run_query(actual_sql, params, role=user.role)

    # Also adds a row (zeroed actuals) for any hardcoded parish with no
    # awareness activity recorded yet, so its target isn't silently dropped
    # from the district total before any actuals land.
    requested_districts = {d.upper() for d in district} if district else None
    hardcoded_by_parish = {}
    for row in AWARENESS_ELIGIBLE_TARGET_BC5:
        if requested_districts and row["district"] not in requested_districts:
            continue
        key = (row["district"], row["parish"])
        hardcoded_by_parish[key] = hardcoded_by_parish.get(key, 0) + row["target"]

    seen_keys = set()
    for r in rows:
        key = (r["district"], r["parish"])
        seen_keys.add(key)
        r["target"] = hardcoded_by_parish.get(key)
        r["target_source"] = "hardcoded" if key in hardcoded_by_parish else None
    for (d, p), t in hardcoded_by_parish.items():
        if (d, p) in seen_keys:
            continue
        rows.append({
            "district": d, "parish": p,
            "reached": 0, "reached_female": 0, "reached_male": 0,
            "interested": 0, "interested_female": 0, "interested_male": 0,
            "eligible": 0, "eligible_female": 0, "eligible_male": 0,
            "pct_female": None,
            "eligible_treatment": 0, "eligible_treatment_female": 0, "eligible_treatment_male": 0,
            "eligible_control": 0, "eligible_control_female": 0, "eligible_control_male": 0,
            "target": t, "target_source": "hardcoded",
        })
    rows.sort(key=lambda r: (r["district"], r["parish"]))
    return {"parishes": rows}


@router.get("/api/recruitment/awareness-mobilisers")
def awareness_mobilisers(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),
):
    """Per-mobiliser reach and eligible/eligible-female conversion, for the
    Awareness tab's Mobilisers sub-page. Names masked for the guest role.
    Carries mobilizer_id (not PII, 1:1 with the name — confirmed against live
    data) so the frontend has a stable key to drill on regardless of masking.

    Distinct from /api/recruitment/mobilisers (the Recruitment>Mobilisers tab,
    still a placeholder) — this one is scoped to the awareness stage, where
    AWARENESS_KYC's mobilizer_name is fully populated (100% for BC5, confirmed
    live 2026-08-05). Backed by AWARENESS_KYC, not AWARENESS_SUMMARY — see
    the comment at awareness_parish() above.
    """
    where, params = build_where(
        districts=district,
        extra=[active_cohort_clause("awm", requested=cohort)], prefix="awm",
        district_col="youth_district",
    )
    sql = f"""
    SELECT
      mobilizer_id,
      mobilizer_name AS mobiliser_name,
      UPPER(youth_district) AS district,
      COUNT(*) AS reached,
      COUNTIF(elligible = TRUE) AS eligible,
      COUNTIF(elligible = TRUE AND UPPER(youth_gender) = 'FEMALE') AS eligible_female,
      ROUND(SAFE_DIVIDE(COUNTIF(elligible = TRUE AND UPPER(youth_gender) = 'FEMALE'), NULLIF(COUNTIF(elligible = TRUE), 0)) * 100, 1) AS pct_eligible_female
    FROM {AWARENESS_KYC}
    WHERE {where} AND mobilizer_name IS NOT NULL
    GROUP BY mobilizer_id, mobiliser_name, district
    ORDER BY eligible DESC
    """
    rows = database.run_query(sql, params, role=user.role)
    for r in rows:
        r["mobiliser_name"] = mask_name(user.role, r.get("mobiliser_name"))
    return {"mobilisers": rows}


@router.get("/api/recruitment/awareness-mobiliser-detail")
def awareness_mobiliser_detail(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),
):
    """Per-mobiliser reach/eligible/eligible-female at PARISH grain (mobiliser
    x district x parish) — backs the Mobilisers tab's district-then-parish
    drill for a specific mobiliser (matched by mobilizer_id, not the masked
    name). Small enough (~20 mobilisers x a handful of parishes each) to fetch
    unfiltered and slice client-side, same as awareness-parish. Backed by
    AWARENESS_KYC, not AWARENESS_SUMMARY — see the comment at
    awareness_parish() above."""
    where, params = build_where(
        districts=district,
        extra=[active_cohort_clause("awmd", requested=cohort)], prefix="awmd",
        district_col="youth_district",
    )
    sql = f"""
    SELECT
      mobilizer_id,
      mobilizer_name AS mobiliser_name,
      UPPER(youth_district) AS district,
      {normalized_parish_sql()} AS parish,
      COUNT(*) AS reached,
      COUNTIF(elligible = TRUE) AS eligible,
      COUNTIF(elligible = TRUE AND UPPER(youth_gender) = 'FEMALE') AS eligible_female,
      ROUND(SAFE_DIVIDE(COUNTIF(elligible = TRUE AND UPPER(youth_gender) = 'FEMALE'), NULLIF(COUNTIF(elligible = TRUE), 0)) * 100, 1) AS pct_eligible_female
    FROM {AWARENESS_KYC}
    WHERE {where} AND mobilizer_name IS NOT NULL AND youth_parish IS NOT NULL
    GROUP BY mobilizer_id, mobiliser_name, district, parish
    ORDER BY eligible DESC
    """
    rows = database.run_query(sql, params, role=user.role)
    for r in rows:
        r["mobiliser_name"] = mask_name(user.role, r.get("mobiliser_name"))
    return {"detail": rows}


@router.get("/api/recruitment/awareness-kyc")
def awareness_kyc(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),
):
    """Persona/demographic breakdown of the eligible pool, for the Awareness
    tab's KYC / Youth Profile sub-page. Backed by the live AWARENESS_KYC
    per-youth record (silver_eba.eba_bootcamp_awareness).

    current_activty/registration_reasons/decision_consultation/
    bc5_support_required/open_questions are multiselect columns whose values
    were captured in three inconsistent string formats across bootcamp
    cycles/form versions -- a bare JSON_EXTRACT_STRING_ARRAY(column) silently
    drops any row it can't parse, which is why these cards were showing
    little to no data even though the underlying columns are far from empty.
    multiselect_array_sql() (app/core/sql.py) detects each row's actual shape
    before parsing -- see that function's docstring for the three formats.
    """
    base_where, base_params = build_where(
        districts=district, gender=gender,
        extra=[active_cohort_clause("kyc", requested=cohort)], prefix="kyc",
        district_col="youth_district", gender_col="youth_gender",
    )
    elig_where = f"{base_where} AND elligible = TRUE"

    demo_sql = f"""
    SELECT
      COUNT(*) AS eligible_count,
      SAFE_DIVIDE(COUNTIF(UPPER(youth_gender) = 'FEMALE'), NULLIF(COUNT(*), 0)) * 100 AS pct_female,
      AVG(youth_age) AS avg_age,
      COUNTIF(owns_business) AS owns_business_count,
      COUNTIF(duplicate_status = 'duplicate') AS duplicate_count,
      SAFE_DIVIDE(COUNTIF(youth_level_of_education IN ('P5', 'P6', 'P7')), NULLIF(COUNT(*), 0)) * 100 AS pct_p5_p7,
      SAFE_DIVIDE(COUNTIF(youth_age BETWEEN 18 AND 25), NULLIF(COUNT(*), 0)) * 100 AS pct_age_18_25,
      SAFE_DIVIDE(COUNTIF(youth_phone IS NOT NULL AND TRIM(youth_phone) != ''), NULLIF(COUNT(*), 0)) * 100 AS pct_owns_phone,
      COUNT(*) AS total_count
    FROM {AWARENESS_KYC}
    WHERE {elig_where}
    """
    demo = (database.run_query(demo_sql, base_params, role=user.role) or [{}])[0]

    activity_sql = f"""
    SELECT activity, COUNT(*) AS count
    FROM {AWARENESS_KYC}, UNNEST({multiselect_array_sql("current_activty")}) AS activity
    WHERE {elig_where}
    GROUP BY activity ORDER BY count DESC
    """
    activity = database.run_query(activity_sql, base_params, role=user.role)

    reasons_sql = f"""
    SELECT reason, COUNT(*) AS count
    FROM {AWARENESS_KYC}, UNNEST({multiselect_array_sql("registration_reasons")}) AS reason
    WHERE {elig_where}
    GROUP BY reason ORDER BY count DESC
    """
    reasons = database.run_query(reasons_sql, base_params, role=user.role)

    consultation_sql = f"""
    SELECT consultant, COUNT(*) AS count
    FROM {AWARENESS_KYC}, UNNEST({multiselect_array_sql("decision_consultation")}) AS consultant
    WHERE {elig_where}
    GROUP BY consultant ORDER BY count DESC
    """
    consultation = database.run_query(consultation_sql, base_params, role=user.role)

    support_sql = f"""
    SELECT support, COUNT(*) AS count
    FROM {AWARENESS_KYC}, UNNEST({multiselect_array_sql("bc5_support_required")}) AS support
    WHERE {elig_where}
    GROUP BY support ORDER BY count DESC
    """
    support_required = database.run_query(support_sql, base_params, role=user.role)

    # Unlike current_activty/decision_consultation/bc5_support_required (all
    # multi-select JSON arrays), bc5_parental_relationship reads as a
    # single-answer categorical field (a youth has one parental situation, not
    # several) — plain GROUP BY, no UNNEST. Flagging this as an assumption
    # since it hasn't been confirmed against the live column type.
    parental_sql = f"""
    SELECT bc5_parental_relationship AS relationship, COUNT(*) AS count
    FROM {AWARENESS_KYC}
    WHERE {elig_where} AND bc5_parental_relationship IS NOT NULL
    GROUP BY relationship ORDER BY count DESC
    """
    parental_relationship = database.run_query(parental_sql, base_params, role=user.role)

    # Free-text, unlike activity/reasons/consultation's small fixed category
    # sets. Grouping by exact wording (the previous approach, capped at the
    # top 20 raw strings) buried the real signal: ~88% of the live
    # distribution is typo/casing variants of "no"/"NA"/thanks, which
    # dominate any raw-frequency ranking, while every substantive question
    # is a one-off phrasing that a top-20-by-exact-text cap drops entirely.
    # classify_question() (app/core/question_themes.py) qualitatively codes
    # each distinct phrasing into a theme -- see that module's docstring for
    # methodology. No LIMIT here: every distinct phrasing must be fetched and
    # classified for the theme counts to be complete, not just the ones
    # that happen to be common verbatim.
    questions_sql = f"""
    SELECT question, COUNT(*) AS count
    FROM {AWARENESS_KYC}, UNNEST({multiselect_array_sql("open_questions")}) AS question
    WHERE {elig_where} AND question IS NOT NULL AND TRIM(question) != ''
    GROUP BY question ORDER BY count DESC
    """
    questions_raw = database.run_query(questions_sql, base_params, role=user.role)
    theme_agg = {}
    for row in questions_raw:
        theme = classify_question(row["question"])
        if theme not in theme_agg:
            # questions_raw is already ORDER BY count DESC, so the first raw
            # phrasing seen for a theme is that theme's most common one --
            # a real representative example, not an arbitrary pick.
            theme_agg[theme] = {"theme": theme, "count": 0, "example": row["question"]}
        theme_agg[theme]["count"] += row["count"]
    questions = sorted(theme_agg.values(), key=lambda r: -r["count"])

    biz_sql = f"""
    SELECT UPPER(youth_district) AS district, youth_gender AS gender,
           COUNTIF(owns_business) AS owners, COUNT(*) AS total
    FROM {AWARENESS_KYC}
    WHERE {elig_where} AND youth_gender IS NOT NULL
    GROUP BY district, gender ORDER BY district, gender
    """
    biz_rows = database.run_query(biz_sql, base_params, role=user.role)
    for r in biz_rows:
        r["pct_owns_business"] = round(100 * r["owners"] / r["total"], 1) if r["total"] else None

    # Channel chart splits eligible vs ineligible — needs its own query without
    # the elligible=TRUE restriction the rest of this endpoint uses.
    channel_sql = f"""
    SELECT recruitment_channel AS channel,
           COUNTIF(elligible = TRUE) AS eligible,
           COUNTIF(elligible = FALSE) AS ineligible
    FROM {AWARENESS_KYC}
    WHERE {base_where} AND recruitment_channel IS NOT NULL
    GROUP BY channel ORDER BY eligible DESC
    """
    channels = database.run_query(channel_sql, base_params, role=user.role)

    return {
        "demographics": {
            "eligible_count": demo.get("eligible_count") or 0,
            "pct_female": round(demo["pct_female"], 1) if demo.get("pct_female") is not None else None,
            "avg_age": round(demo["avg_age"], 1) if demo.get("avg_age") is not None else None,
            "owns_business_count": demo.get("owns_business_count") or 0,
            "pct_owns_business": round(100 * (demo.get("owns_business_count") or 0) / demo["total_count"], 1) if demo.get("total_count") else None,
            "duplicate_count": demo.get("duplicate_count") or 0,
            "duplicate_rate": round(100 * (demo.get("duplicate_count") or 0) / demo["total_count"], 1) if demo.get("total_count") else None,
            "pct_p5_p7": round(demo["pct_p5_p7"], 1) if demo.get("pct_p5_p7") is not None else None,
            "pct_age_18_25": round(demo["pct_age_18_25"], 1) if demo.get("pct_age_18_25") is not None else None,
            "pct_owns_phone": round(demo["pct_owns_phone"], 1) if demo.get("pct_owns_phone") is not None else None,
        },
        "activity": activity,
        "reasons": reasons,
        "consultation": consultation,
        "support_required": support_required,
        "parental_relationship": parental_relationship,
        "questions": questions,
        "business": {"by_gender_district": biz_rows},
        "channels": channels,
    }


@router.get("/api/recruitment/awareness-eligible-target")
def awareness_eligible_target(
    user: User = Depends(current_user),
    cohort: List[str] = Query(default=[]),
):
    """New Recruits - Awareness Eligible Target: real eligible-youth counts
    at district/parish grain (AWARENESS_KYC) against the hardcoded BC5
    district/parish/venue target sheet (AWARENESS_ELIGIBLE_TARGET_BC5).

    The venue level is target-only — there is no live per-venue actual to
    compare it against, since venue assignment only happens once a youth
    reaches Mobilisation, after the Awareness/eligibility stage this endpoint
    reports on. See the comment on AWARENESS_ELIGIBLE_TARGET_BC5.
    """
    where, params = build_where(
        extra=[active_cohort_clause("aet", requested=cohort)], prefix="aet",
        district_col="youth_district",
    )
    actual_sql = f"""
    SELECT UPPER(youth_district) AS district, {normalized_parish_sql()} AS parish, COUNT(*) AS actual
    FROM {AWARENESS_KYC}
    WHERE {where} AND elligible = TRUE AND youth_parish IS NOT NULL
    GROUP BY district, parish
    """
    actual_rows = database.run_query(actual_sql, params, role=user.role)
    actual_by_parish = {(r["district"], r["parish"]): r["actual"] for r in actual_rows}

    district_target = {}
    parish_target = {}
    for row in AWARENESS_ELIGIBLE_TARGET_BC5:
        d, p, t = row["district"], row["parish"], row["target"]
        district_target[d] = district_target.get(d, 0) + t
        parish_target[(d, p)] = parish_target.get((d, p), 0) + t

    all_districts = {d for d, _ in actual_by_parish} | set(district_target)
    by_district = []
    for d in sorted(all_districts):
        actual = sum(v for (dd, _), v in actual_by_parish.items() if dd == d)
        target = district_target.get(d) or None
        by_district.append({
            "district": d, "actual": actual, "target": target,
            "pct_of_target": round(100 * actual / target, 1) if target else None,
        })

    all_parishes = set(actual_by_parish) | set(parish_target)
    by_parish = []
    for d, p in sorted(all_parishes):
        actual = actual_by_parish.get((d, p), 0)
        target = parish_target.get((d, p)) or None
        by_parish.append({
            "district": d, "parish": p, "actual": actual, "target": target,
            "pct_of_target": round(100 * actual / target, 1) if target else None,
        })

    by_venue = [
        {"district": r["district"], "parish": r["parish"], "venue": r["venue"], "target": r["target"]}
        for r in AWARENESS_ELIGIBLE_TARGET_BC5
    ]

    return {"by_district": by_district, "by_parish": by_parish, "by_venue": by_venue}


@router.get("/api/recruitment/duplicate-summary")
def duplicate_summary(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),
):
    """Duplicate phone-number records across the FULL recruitment file — not
    just the eligible subset awareness-kyc's duplicate_rate covers. Backs the
    persistent "Duplicate records identified" banner on the Mobilisation and
    Acquisition tabs (matches the reference prototype's dupe-flag element),
    from the same live AWARENESS_KYC per-youth record the KYC page uses.
    """
    where, params = build_where(
        districts=district,
        extra=[active_cohort_clause("dup", requested=cohort)], prefix="dup",
        district_col="youth_district",
    )
    sql = f"""
    SELECT COUNT(*) AS total_count,
           COUNTIF(duplicate_status = 'duplicate') AS duplicate_count
    FROM {AWARENESS_KYC}
    WHERE {where}
    """
    row = (database.run_query(sql, params, role=user.role) or [{}])[0]
    total = row.get("total_count") or 0
    dup = row.get("duplicate_count") or 0
    return {
        "total_count": total,
        "duplicate_count": dup,
        "duplicate_rate": round(100 * dup / total, 1) if total else None,
    }


@router.get("/api/recruitment/awareness-forecast")
def awareness_forecast(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),
):
    """Daily registration trend vs target, with a simple pace-to-target
    projection, for the Awareness tab's Forecast sub-page. Backed by
    AWARENESS_KYC, not AWARENESS_SUMMARY — see the comment at
    awareness_parish() above. `target` is the hardcoded
    AWARENESS_ELIGIBLE_TARGET_BC5 sheet only (no live fallback — AWARENESS_KYC
    carries no per-district/parish target column) — it's an ELIGIBLE-youth
    quota, so pace/gap/days-to-target/%-of-target are all paced off
    `eligible`, not `registered`."""
    where, params = build_where(
        districts=district,
        extra=[active_cohort_clause("awf", requested=cohort)], prefix="awf",
        district_col="youth_district",
    )
    daily_sql = f"""
    SELECT report_date AS event_date,
           COUNT(*) AS registered,
           COUNTIF(training_interest = TRUE) AS interested,
           COUNTIF(elligible = TRUE) AS eligible
    FROM {AWARENESS_KYC}
    WHERE {where} AND report_date IS NOT NULL
    GROUP BY event_date ORDER BY event_date
    """
    daily = database.run_query(daily_sql, params, role=user.role)

    totals_sql = f"""
    SELECT COUNT(*) AS registered,
           COUNTIF(training_interest = TRUE) AS interested,
           COUNTIF(elligible = TRUE) AS eligible
    FROM {AWARENESS_KYC}
    WHERE {where}
    """
    totals = (database.run_query(totals_sql, params, role=user.role) or [{}])[0]
    registered = totals.get("registered") or 0
    interested = totals.get("interested") or 0
    eligible = totals.get("eligible") or 0

    # District breakdown for the "days to target, by district" panel — pace
    # per district uses the SAME n_days (dates with any data in this filtered
    # window) as the denominator above, so every district's rate is "average
    # per day over the same observed reporting window", not each district's
    # own (possibly sparser) active-day count.
    district_stats_sql = f"""
    SELECT UPPER(youth_district) AS district,
           COUNT(*) AS registered,
           COUNTIF(elligible = TRUE) AS eligible
    FROM {AWARENESS_KYC}
    WHERE {where}
    GROUP BY district
    """

    requested_districts = {d.upper() for d in district} if district else None
    hardcoded_district_target = {}
    for row in AWARENESS_ELIGIBLE_TARGET_BC5:
        if requested_districts and row["district"] not in requested_districts:
            continue
        hardcoded_district_target[row["district"]] = hardcoded_district_target.get(row["district"], 0) + row["target"]

    district_target = dict(hardcoded_district_target)
    target = sum(district_target.values())

    district_stats = {r["district"]: r for r in database.run_query(district_stats_sql, params, role=user.role)}

    n_days = len(daily)
    avg_daily_rate = (eligible / n_days) if n_days else None
    remaining = max(target - eligible, 0)
    days_to_target = (
        round(remaining / avg_daily_rate) if avg_daily_rate else None
    )
    eligibility_rate = round(100 * eligible / interested, 1) if interested else None

    by_district = []
    for d in set(district_stats) | set(district_target):
        stats = district_stats.get(d, {})
        d_registered = stats.get("registered") or 0
        d_eligible = stats.get("eligible") or 0
        d_target = district_target.get(d, 0)
        d_rate = (d_eligible / n_days) if n_days else None
        d_gap = max(d_target - d_eligible, 0)
        by_district.append({
            "district": d,
            "registered": d_registered,
            "eligible": d_eligible,
            "target": d_target,
            "target_source": "hardcoded" if d in hardcoded_district_target else None,
            "gap": d_gap,
            "pct_of_target": round(100 * d_eligible / d_target, 1) if d_target else None,
            "avg_daily_rate": round(d_rate, 1) if d_rate is not None else None,
            "days_to_target": round(d_gap / d_rate) if d_rate else None,
        })
    by_district.sort(key=lambda r: r["district"])

    return {
        "daily": daily,
        "registered_to_date": registered,
        "interested_to_date": interested,
        "eligible_to_date": eligible,
        "eligibility_rate": eligibility_rate,
        "target": target,
        "actual_to_date_for_target": eligible,
        "n_days": n_days,
        "avg_daily_rate": round(avg_daily_rate, 1) if avg_daily_rate is not None else None,
        "days_to_target": days_to_target,
        "by_district": by_district,
    }


@router.get("/api/recruitment/mobilisation")
def mobilisation(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
):
    """Assigned -> Reached -> Confirmed with reach & mobilisation rates.

    Backed by the live DAILY_ACQUISITION_SUMMARY mart, which mixes three row
    types under `measure` (see tables.py): assigned = preload_youth comes from
    the target-measure rows (district-grain only — no gender breakdown exists
    for this figure; which literal `measure` value depends on the cohort, see
    TARGET_MEASURE_BY_COHORT); reached/confirmed come from the
    'daily_aggregates' rows (the real per-day data, gender-filterable). This
    call-center "acquired" means confirmed-to-attend — distinct from the
    arrival-day "acquired" in SITE_FUNNEL_METRICS used by /acquisition below.
    `district` filters the calling agent's district (agent_district) — this
    table has no youth-side district.

    `called` (four_week only — the 2.5-week pathway never had a call step)
    is COUNT(DISTINCT youth_id) from the row-level ACQUISITION_CALL_LOG, not
    DAILY_ACQUISITION_SUMMARY's own total_youth_called — that column is a
    per-day/venue/gender aggregate and would double-count a youth called on
    more than one day. This is a coverage signal distinct from reach_rate:
    "called" answers whether the call center attempted everyone assigned,
    reach_rate answers what share of attempts actually connected.

    Mobilisation rate is Confirmed/Reached (confirmed by the recruitment team,
    2026-08-04 — corrected from an earlier Confirmed/Assigned formula).

    The pilot subcounties' "2.5-week cycle" youth are auto-confirmed by policy
    (AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT) rather than run through the same
    call-center process as the rest of the cohort's "4-week cycle". Per the
    recruitment team (2026-08-04), the two pathways must NOT be blended into
    one progress-on-target figure — confusing which pathway drove a number.
    So the top-level fields here (assigned/reached/confirmed/rates/target/
    progress_pct) are the call-center ("four_week") view ONLY, built entirely
    from DAILY_ACQUISITION_SUMMARY. The auto-confirmed pilot appears ONLY in
    `two_half_week` and the separate `combined` section, which explicitly
    layers both pathways together against a combined target — see `combined`
    below for that layer's own target derivation.

    date_from/date_to filter every OBSERVED figure here (call_date on
    DAILY_ACQUISITION_SUMMARY/ACQUISITION_CALL_LOG, report_date on
    AWARENESS_KYC for the auto-confirmed pathway) — but never `target`,
    `preload_assigned`, or `combined`'s target components, which come from
    static planning tables (DAILY_ACQUISITION_TARGETS_DEDUPED,
    PARISH_TARGETS_BC5) with no date to filter by.

    "Mobilisation" (`four_week`, assigned/reached/confirmed/rates at the top
    level) is TWO acquisition channels blended, per `collection_type` (see
    tables.py) — ONLINE_COLLECTION_TYPE, the call-center pathway this
    endpoint originally modeled alone, and OFFLINE_COLLECTION_TYPE, an
    in-person channel live since call_date 2026-08-07. Both have their own
    genuine total_youth_reached/total_acquired_youth pair as of the current
    upstream data model (re-verified live 2026-08-08 after an upstream
    change — Offline's total_youth_reached used to be always 0, which made
    summing it into Confirmed alone produce Confirmed > Reached,
    mobilisation_rate >100%, reproduced live under that earlier shape), so
    `reached`/`confirmed` here are a plain SUM across both channels — no
    special-casing needed anymore to keep mobilisation_rate <= 100%.

    `online`/`offline` are the PURE per-channel breakdowns (for an Online vs
    Offline drill-down/share display) — each now has its own real reach_rate.
    `online_offline_share` gives the two channels' share of combined
    confirmed. `combined.total_so_far` sums Mobilisation (both channels) +
    the auto-confirm pilot — the recruitment team's single "how are we doing
    overall" number.
    """
    cohorts = resolve_active_cohorts(cohort)
    tm_where, tm_params = target_measure_where("moa", cohorts)
    assigned_where, assigned_params = build_where(
        districts=district, extra=[(tm_where, tm_params)], prefix="moa",
        district_col="agent_district",
    )
    preload_assigned = (database.run_query(
        f"SELECT SUM(preload_youth) AS assigned FROM {DAILY_ACQUISITION_TARGETS_DEDUPED} WHERE {assigned_where}",
        assigned_params, role=user.role) or [{}])[0].get("assigned") or 0

    # Distinct youth actually dialed at least once — from the row-level call
    # log (ACQUISITION_CALL_LOG), not DAILY_ACQUISITION_SUMMARY's own
    # total_youth_called (a per-day/venue/gender aggregate that would
    # double-count a youth called on more than one day). A separate "coverage"
    # signal from reach_rate: this answers "did the call center attempt
    # everyone assigned", reach_rate answers "of those attempts, how many
    # connected" — confirmed live 2026-08-05, every row here is treatment-arm
    # (is_control = FALSE throughout for BC5), matching this endpoint's scope.
    called_where, called_params = build_where(
        districts=district, gender=gender,
        extra=[active_cohort_clause("moc", requested=cohort)] + _date_extra("call_date", date_from, date_to, "moc"),
        prefix="moc", district_col="agent_district", gender_col="youth_gender",
    )
    youth_called = (database.run_query(
        f"SELECT COUNT(DISTINCT youth_id) AS n FROM {ACQUISITION_CALL_LOG} WHERE {called_where}",
        called_params, role=user.role) or [{}])[0].get("n") or 0

    actual_where, actual_params = build_where(
        districts=district, gender=gender,
        extra=[active_cohort_clause("mor", requested=cohort)] + _date_extra("call_date", date_from, date_to, "mor"),
        prefix="mor", district_col="agent_district", gender_col="youth_gender",
    )
    # Split by collection_type (see tables.py) in one pass rather than two
    # round-trips — both channels now have their own genuine reached/confirmed
    # pair, so the headline Mobilisation figures are just their plain sum.
    actual = (database.run_query(
        f"""
        SELECT
          SUM(IF(collection_type = '{ONLINE_COLLECTION_TYPE}', total_youth_reached, 0)) AS online_reached,
          SUM(IF(collection_type = '{ONLINE_COLLECTION_TYPE}', total_acquired_youth, 0)) AS online_confirmed,
          SUM(IF(collection_type = '{OFFLINE_COLLECTION_TYPE}', total_youth_reached, 0)) AS offline_reached,
          SUM(IF(collection_type = '{OFFLINE_COLLECTION_TYPE}', total_acquired_youth, 0)) AS offline_confirmed
        FROM {DAILY_ACQUISITION_SUMMARY} WHERE {actual_where} AND measure = '{DAILY_ACQ_MEASURE_ACTUAL}'
        """,
        actual_params, role=user.role) or [{}])[0]
    online_reached      = actual.get("online_reached") or 0
    online_confirmed    = actual.get("online_confirmed") or 0
    offline_reached     = actual.get("offline_reached") or 0
    offline_confirmed   = actual.get("offline_confirmed") or 0
    # Mobilisation headline = both channels, plain sum — each individually
    # has confirmed <= reached, so the blended ratio is guaranteed sane too.
    four_week_reached   = online_reached + offline_reached
    four_week_confirmed = online_confirmed + offline_confirmed

    auto_confirmed = _auto_confirmed_count(district, gender, user.role, cohort, date_from, date_to)
    # This pathway never had a preload list, so there's no "assigned" figure
    # for it at all (None, not 0 — see _segment: falsy either way, but None
    # is honest about "doesn't exist" vs "exists and is zero"). "Reached" is
    # total registered youth in the pathway's own scope — confirmed by the
    # recruitment team, 2026-08-04: registration is this pathway's entry
    # point, there's no separate call-center reach step to report instead.
    auto_pathway_registered = _auto_pathway_registered_count(district, gender, user.role, cohort, date_from, date_to)

    def _segment(assigned, reached, confirmed):
        return {
            "assigned": assigned,
            "reached": reached,
            "confirmed": confirmed,
            "reach_rate":        round(100 * reached / assigned, 1) if assigned else None,
            "mobilisation_rate": round(100 * confirmed / reached, 1) if reached else None,
        }

    four_week     = _segment(preload_assigned, four_week_reached, four_week_confirmed)
    four_week["called"] = youth_called
    two_half_week = _segment(None, auto_pathway_registered, auto_confirmed)
    # Pure per-channel breakdowns (for the Online vs Offline drill-down/share
    # display) — both now have a real reach step, so both get a real
    # mobilisation_rate. Neither has its own Assigned/preload list (that
    # concept lives on the 'targets' measure rows, which don't carry
    # collection_type at all) — None, not 0, same "doesn't exist" convention
    # two_half_week's assigned uses; reach_rate is therefore always None for
    # both, same as four_week's own reach_rate meaning "vs the preload list".
    online  = _segment(None, online_reached, online_confirmed)
    offline = _segment(None, offline_reached, offline_confirmed)

    # Female share is computed on the full (district/cohort-filtered) set
    # regardless of the `gender` query param — filtering to gender=FEMALE and
    # then asking "what % is female" would trivially always read 100%.
    gsplit_where, gsplit_params = build_where(
        districts=district,
        extra=[active_cohort_clause("mog", requested=cohort)] + _date_extra("call_date", date_from, date_to, "mog"),
        prefix="mog", district_col="agent_district",
    )
    gsplit = (database.run_query(
        f"""
        SELECT
          SUM(IF(collection_type = '{ONLINE_COLLECTION_TYPE}', total_acquired_youth, 0)) AS online_confirmed_female,
          SUM(IF(collection_type = '{OFFLINE_COLLECTION_TYPE}', total_acquired_youth, 0)) AS offline_confirmed_female
        FROM {DAILY_ACQUISITION_SUMMARY}
        WHERE {gsplit_where} AND measure = '{DAILY_ACQ_MEASURE_ACTUAL}' AND UPPER(youth_gender) = 'FEMALE'
        """,
        gsplit_params, role=user.role) or [{}])[0]
    online_confirmed_female = gsplit.get("online_confirmed_female") or 0
    offline_confirmed_female = gsplit.get("offline_confirmed_female") or 0
    # Blended, matching four_week["confirmed"] above. Offline's youth_gender
    # is only PARTIALLY populated (confirmed live, 2026-08-08) — rows with no
    # gender recorded contribute to neither this nor total_confirmed's female
    # share numerator, same "not every row has this field" pattern the rest
    # of this codebase already handles (e.g. attendance_status).
    four_week_confirmed_female = online_confirmed_female + offline_confirmed_female
    two_half_week_confirmed_female = _auto_confirmed_count(district, "FEMALE", user.role, cohort, date_from, date_to)

    four_week["pct_female"] = round(100 * four_week_confirmed_female / four_week["confirmed"], 1) if four_week["confirmed"] else None
    two_half_week["pct_female"] = round(100 * two_half_week_confirmed_female / two_half_week["confirmed"], 1) if two_half_week["confirmed"] else None
    online["pct_female"] = round(100 * online_confirmed_female / online["confirmed"], 1) if online["confirmed"] else None
    offline["pct_female"] = round(100 * offline_confirmed_female / offline["confirmed"], 1) if offline["confirmed"] else None

    # Share uses the PURE per-mode confirmed counts, not four_week["confirmed"]
    # (which is the blended headline, online_confirmed + offline_confirmed —
    # using it here as one side of its own split would double-count Offline).
    total_confirmed_all_modes = online_confirmed + offline_confirmed
    online_offline_share = {
        "online_confirmed": online_confirmed,
        "offline_confirmed": offline_confirmed,
        "online_pct": round(100 * online_confirmed / total_confirmed_all_modes, 1) if total_confirmed_all_modes else None,
        "offline_pct": round(100 * offline_confirmed / total_confirmed_all_modes, 1) if total_confirmed_all_modes else None,
    }

    # BOOTCAMP_5's mobilisation target does NOT come from DAILY_ACQUISITION_
    # SUMMARY's own mobilisation_target column — confirmed with the
    # recruitment team, 2026-08-04, that column is a data-pipeline artifact:
    # it's an EXACT duplicate of PARISH_TARGETS_BC5's total_new_recruits_
    # awareness_eligible_target for every single BC5 parish (verified across
    # all 26), not an independent mobilisation figure. The real target is
    # PARISH_TARGETS_BC5.control_mobilised_target (e.g. Buluta: 59, not the
    # duplicated 29) — see _mobilisation_target_by_parish_bc5. Other cohorts
    # have no such table, so they keep using DAILY_ACQUISITION_SUMMARY's own
    # column (their only source).
    non_bc5_cohorts = [c for c in cohorts if c != "BOOTCAMP_5"]
    target = 0
    if non_bc5_cohorts:
        tm_target_where, tm_target_params = target_measure_where("mot", non_bc5_cohorts)
        target_where, target_params = build_where(
            districts=district, extra=[(tm_target_where, tm_target_params)], prefix="mot",
            district_col="agent_district",
        )
        target = (database.run_query(
            f"SELECT SUM(mobilisation_target) AS t FROM {DAILY_ACQUISITION_TARGETS_DEDUPED} WHERE {target_where}",
            target_params, role=user.role) or [{}])[0].get("t") or 0
    if "BOOTCAMP_5" in cohorts:
        target += sum(_mobilisation_target_by_parish_bc5(district, user.role).values())

    # Combined layer: the recruitment team's own "how are we doing overall"
    # view, deliberately separate from the clean call-center numbers above —
    # sums BOTH pathways (auto-confirmed + call-center confirmed) against a
    # combined target. BC5-only: PARISH_TARGETS_BC5 has no cohort column, and
    # the treatment/control split only means anything for BC5's RCT design.
    # Confirmed with the recruitment team 2026-08-04: the acquisition-stage
    # treatment/control target is new_recruits_eligible_treatment/_control —
    # direct per-parish columns, not eligible_target × pct_new_recruits_
    # treatment/control (that derived multiplication is subject to rounding
    # and was only ever an approximation of these; use the real columns).
    # NOT the table's new_recruits_treatment_acquisition/control_acquisition
    # columns either — those are a different funnel stage ("arrival").
    #
    # total_so_far is ENTIRELY treatment population — DAILY_ACQUISITION_SUMMARY
    # has no Control rows at all (control isn't mobilised/called), and
    # auto_confirmed is explicitly filtered to is_treatment=TRUE. So the
    # combined target it's checked against must also be treatment-only:
    # mobilisation_target (already treatment-only, same table) + the
    # TREATMENT SLICE of the eligible target (not the full eligible_target,
    # which is combined treatment+control and would understate progress by
    # comparing a treatment-only numerator to a mixed-arm denominator).
    combined = None
    if "BOOTCAMP_5" in cohorts:
        pt_where, pt_params = build_where(
            districts=district, prefix="pt", district_col="district",
            extra=[("category = 'New Recruits'", [])],
        )
        pt = (database.run_query(
            f"""
            SELECT
              SUM(total_new_recruits_awareness_eligible_target) AS eligible_target,
              SUM(new_recruits_eligible_treatment) AS treatment_target,
              SUM(new_recruits_eligible_control) AS control_target
            FROM {PARISH_TARGETS_BC5} WHERE {pt_where}
            """,
            pt_params, role=user.role) or [{}])[0]
        eligible_target = pt.get("eligible_target") or 0
        treatment_target = round(pt.get("treatment_target") or 0)
        control_target = round(pt.get("control_target") or 0)
        combined_target = target + treatment_target
        # All THREE pathways now (call-center + auto-confirm pilot + offline)
        # — offline is real mobilisation progress toward the same target, not
        # a separate program. online_confirmed (pure), NOT four_week_confirmed
        # (which is now the blended online+offline headline) — using the
        # blended figure here would double-count Offline.
        total_so_far = online_confirmed + auto_confirmed + offline_confirmed
        combined = {
            "auto_confirmed": auto_confirmed,
            "call_centre_confirmed": online_confirmed,
            "offline_confirmed": offline_confirmed,
            "total_so_far": total_so_far,
            "mobilisation_target": target,
            "eligible_target": eligible_target,
            "treatment_target": treatment_target,
            "control_target": control_target,
            "target": combined_target,
            "progress_pct": round(100 * total_so_far / combined_target, 1) if combined_target else None,
        }

    return {
        **four_week,
        "confirmed_female": four_week_confirmed_female,
        "confirmed_female_pct": four_week["pct_female"],
        "target": target,
        "progress_pct": round(100 * four_week_confirmed / target, 1) if target else None,
        "four_week": four_week,
        "two_half_week": two_half_week,
        "online": online,
        "offline": offline,
        "online_offline_share": online_offline_share,
        "combined": combined,
    }


@router.get("/api/recruitment/mobilisation-heatmap")
def mobilisation_heatmap(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
):
    """Parish -> Venue rollups of DAILY_ACQUISITION_SUMMARY (+ the auto-confirm
    awareness pathway, for by_parish) for the Mobilisation overview page's
    merged "Performance categorisation" toggle (Parish is the default visible
    table, Venue the alternate grain) and its Insights (top venue, high-risk
    venues). by_district still exists for the KPI/cycle cards elsewhere on
    the page, at district grain.

    "call_centre_reached"/"call_centre_confirmed" are Mobilisation as a whole
    now (both acquisition channels — see ONLINE_COLLECTION_TYPE/
    OFFLINE_COLLECTION_TYPE, tables.py — the field names are kept for
    backwards compatibility, not because they're Online-only anymore): Online
    rows join this rollup normally (they carry a real venue_parish), but
    Offline rows never have venue_parish populated (confirmed live,
    2026-08-08), so they're queried separately by venue name only
    (offline_by_venue_sql) and merged in via venue_to_parish — a reverse
    lookup built from targets_by_venue, the only source with a reliable
    parish for a venue name (same reasoning as district_by_parish below).

    Every level (by_district/by_parish/by_venue) ALSO carries the unblended
    online_reached/online_confirmed/online_confirmed_female and
    offline_reached/offline_confirmed/offline_confirmed_female alongside the
    blended reached/confirmed/confirmed_female — enough for the frontend to
    build a per-entity Online vs Offline drill at any grain (district, then
    parish, then venue), not just the program-wide split mobilisation()
    already exposes via its own online/offline segments.

    IMPORTANT — agent_district is not a reliable district for the actual
    (call-center) side. Confirmed live, 2026-08-04: it's where the CALLING
    AGENT is based, not the youth's/venue's district — e.g. a Bugiri-based
    agent's rows show agent_district='BUGIRI' even when venue_parish is
    Bukaye/Bukoona/Bulubandi, real Iganga parishes (verified against
    PARISH_TARGETS_BC5's own parish list and venue names). Grouping or
    filtering the actual side by agent_district therefore silently drops or
    misfiles real BC5 activity — this was the earlier bug that made every
    BC5 parish/venue show 0 reached/confirmed despite real call-center data
    existing. Fixed by grouping the actual side by parish/venue only and
    deriving "district" from district_by_parish — built from the TARGET
    side's own agent_district, which (unlike the actual side's) does
    correctly match each parish's real district, verified the same way.

    by_parish's reached/confirmed/confirmed_female are additionally COMBINED:
    call-center (from 'daily_aggregates', parish-derived-district as above)
    PLUS the auto-confirm awareness pathway (_auto_confirmed_by_parish) —
    per the recruitment team, 2026-08-04, this blend is still wanted even
    after the agent_district fix, since the two pathways are genuinely
    different funnel routes for the same target population.
    call_centre_reached/call_centre_confirmed/auto_confirmed are carried
    unblended too, so the frontend can show the split alongside the combined
    total. by_parish's target is similarly combined: mobilisation_target
    (acquisition side) + that parish's own treatment-target share of
    PARISH_TARGETS_BC5's eligible target (awareness side, BC5-only — that
    table has no cohort column).

    by_venue carries auto_confirmed/auto_confirmed_female/treatment_target
    too, but — unlike by_parish — these are NOT blended into confirmed/
    target/reached, which stay call-center-only. Awareness-stage records
    carry no venue at all, only district/parish, so the figure is really the
    venue's PARISH total, repeated on every venue in that parish; blending it
    into confirmed/target would double- (or triple-, ...) count that parish's
    real number if a caller summed by_venue's rows. It's exposed purely so
    the frontend can show it for structural parity with by_parish's
    Auto-confirmed block, clearly labeled as parish-level.

    by_venue's assigned/target come from a live per-venue query where the
    cohort's target measure carries venue_name (confirmed for BOOTCAMP_5's
    'venue_targets'); where it doesn't, target falls back to the hardcoded
    VENUE_MOBILISATION_TARGET (see tables.py, including its VENUE_NAME_ALIASES
    for live spelling variants) and assigned stays 0 (that list has no
    "assigned" concept). If that still comes out 0 and the venue is the only
    one in its parish, target falls back once more to that parish's own
    (BC5-corrected) target — see the loop below.

    Both levels are scoped to only districts/parishes with a real target row
    for this cohort (not the union with the actual/reached data) — confirmed
    with the recruitment team, 2026-08-04: BOOTCAMP_5 only runs in IGANGA/
    MAYUGE, and any parish with call-center activity but no target row at
    all (a genuinely different program's data, e.g. Kampala-area parish
    names seen live) is out of scope for this rollup. Same principle covers
    every cohort (e.g. BOOTCAMP_4 is BUGIRI/BUGWERI) without hardcoding a
    per-cohort district list. NOTE: the `district` query param filter above
    still filters on agent_district (build_where's district_col) — since
    that's unreliable for the actual side, filtering this endpoint to one
    specific district may not behave correctly yet; only the no-filter
    (all-districts) default view has been fixed and verified.

    date_from/date_to filter both actual sides (call_date on by_venue_sql/
    parish_actual_sql; report_date via _auto_confirmed_by_parish) — never
    targets_sql/parish_targets_sql/venue_targets_sql or
    _mobilisation_target_by_parish_bc5, which read static planning tables
    with no date column.
    """
    where, params = build_where(
        districts=district,
        extra=[active_cohort_clause("mh", requested=cohort)] + _date_extra("call_date", date_from, date_to, "mh"),
        prefix="mh", district_col="agent_district",
    )
    # Grouped by parish + venue, NOT agent_district — see the district_by_parish
    # note further down for why (agent_district is the calling agent's own
    # location, not reliable for the youth/venue's real district).
    # canonical_venue_sql(venue_name) on both this and venue_targets_sql below
    # — the actual side's venue_name casing/spelling doesn't always match the
    # target side's (e.g. "BUSIMO PRIMARY SCHOOL" vs "Busimo Primary School"
    # for the same real venue, confirmed live 2026-08-04; three further
    # spelling variants confirmed live 2026-08-05, see VENUE_NAME_ALIASES).
    # Without normalising both sides the same way, they join as two separate
    # rows instead of one, splitting a venue's real numbers apart (one row
    # with assigned/target, the other with reached/confirmed) rather than
    # combining them.
    # Named online_* (not reached/confirmed) — venue_parish IS NOT NULL
    # already scopes this to Online rows in practice (Offline never sets it,
    # see below), but the explicit collection_type filter makes that
    # intentional rather than incidental, and the online_* naming carries
    # through the merge below so callers (e.g. a per-venue Online vs Offline
    # drill) can see both channels' own figures, not just the blended total.
    by_venue_sql = f"""
    SELECT {canonical_parish_sql("venue_parish")} AS parish, {canonical_venue_sql("venue_name")} AS venue,
           SUM(total_youth_reached) AS online_reached, SUM(total_acquired_youth) AS online_confirmed,
           SUM(IF(UPPER(youth_gender) = 'FEMALE', total_acquired_youth, 0)) AS online_confirmed_female
    FROM {DAILY_ACQUISITION_SUMMARY}
    WHERE {where} AND measure = '{DAILY_ACQ_MEASURE_ACTUAL}' AND collection_type = '{ONLINE_COLLECTION_TYPE}'
      AND venue_name IS NOT NULL AND venue_parish IS NOT NULL
    GROUP BY parish, venue
    ORDER BY parish, venue
    """
    by_venue = database.run_query(by_venue_sql, params, role=user.role)

    # Offline rows (collection_type = OFFLINE_COLLECTION_TYPE, see tables.py)
    # carry a real venue_name but venue_parish is always NULL for them
    # (confirmed live, 2026-08-08) — so they can't join the parish grouping
    # above directly. Queried separately by venue only, then merged into
    # by_venue below (once each venue's real parish is known via
    # targets_by_venue) so "Mobilisation" progress at parish/venue grain
    # includes both acquisition channels, same as the headline in
    # mobilisation().
    offline_by_venue_sql = f"""
    SELECT {canonical_venue_sql("venue_name")} AS venue,
           SUM(total_youth_reached) AS offline_reached, SUM(total_acquired_youth) AS offline_confirmed,
           SUM(IF(UPPER(youth_gender) = 'FEMALE', total_acquired_youth, 0)) AS offline_confirmed_female
    FROM {DAILY_ACQUISITION_SUMMARY}
    WHERE {where} AND measure = '{DAILY_ACQ_MEASURE_ACTUAL}' AND collection_type = '{OFFLINE_COLLECTION_TYPE}' AND venue_name IS NOT NULL
    GROUP BY venue
    """
    offline_by_venue = {r["venue"]: r for r in database.run_query(offline_by_venue_sql, params, role=user.role)}

    cohorts = resolve_active_cohorts(cohort)
    tm_where, tm_params = target_measure_where("mht", cohorts)
    targets_where, targets_params = build_where(
        districts=district, extra=[(tm_where, tm_params)], prefix="mht",
        district_col="agent_district",
    )
    targets_sql = f"""
    SELECT UPPER(agent_district) AS district,
           SUM(preload_youth) AS assigned, SUM(mobilisation_target) AS target
    FROM {DAILY_ACQUISITION_TARGETS_DEDUPED}
    WHERE {targets_where}
    GROUP BY district
    """
    targets_by_district = {r["district"]: r for r in database.run_query(targets_sql, targets_params, role=user.role)}

    parish_targets_sql = f"""
    SELECT UPPER(agent_district) AS district, {canonical_parish_sql("venue_parish")} AS parish,
           SUM(preload_youth) AS assigned, SUM(mobilisation_target) AS target
    FROM {DAILY_ACQUISITION_TARGETS_DEDUPED}
    WHERE {targets_where} AND venue_parish IS NOT NULL
    GROUP BY district, parish
    """
    targets_by_parish = {
        (r["district"], r["parish"]): r
        for r in database.run_query(parish_targets_sql, targets_params, role=user.role)
    }
    # Override BC5 parishes' target with the real per-parish mobilisation
    # target (see _mobilisation_target_by_parish_bc5 for why the value just
    # queried above is wrong for BC5 — assigned stays as queried, only
    # target is replaced). by_district's totals are summed from by_parish
    # further down, so this one fix covers both grains.
    if "BOOTCAMP_5" in cohorts:
        for key, bc5_target in _mobilisation_target_by_parish_bc5(district, user.role).items():
            row = targets_by_parish.setdefault(key, {"district": key[0], "parish": key[1], "assigned": 0})
            row["target"] = bc5_target

    # Live per-venue target/assigned — only some cohorts' target measure
    # carries venue_name (see TARGET_MEASURE_BY_COHORT); where it doesn't,
    # by_venue falls back to the hardcoded VENUE_MOBILISATION_TARGET below
    # (target only — that list has no "assigned" concept).
    venue_targets_sql = f"""
    SELECT UPPER(agent_district) AS district, {canonical_parish_sql("venue_parish")} AS parish, {canonical_venue_sql("venue_name")} AS venue,
           SUM(preload_youth) AS assigned, SUM(mobilisation_target) AS target
    FROM {DAILY_ACQUISITION_TARGETS_DEDUPED}
    WHERE {targets_where} AND venue_name IS NOT NULL
    GROUP BY district, parish, venue
    """
    # Keyed on (parish, venue) — not (district, venue) — so it joins cleanly
    # against the actual side below, which has no reliable district of its
    # own (see district_by_parish further down).
    targets_by_venue = {
        (r["parish"], r["venue"]): r
        for r in database.run_query(venue_targets_sql, targets_params, role=user.role)
    }

    # Merge Offline into by_venue now that each venue's real parish is known
    # (via targets_by_venue's own (parish, venue) keys — the only source with
    # a reliable parish for a venue name, same reasoning as district_by_parish
    # below). A venue name is assumed to belong to one parish across the
    # cohort, matching this program's real structure (verified live,
    # 2026-08-08: no venue name recurs under two different parishes in
    # targets_by_venue) — last-write-wins if that ever stops holding.
    #
    # Always rebuilds a FRESH list of dicts (never mutating by_venue's rows in
    # place — those come straight from database.run_query(), which may hand
    # back the exact object cache.py's TTLCache is holding; an in-place "+="
    # would compound Offline's numbers on every cache hit, confirmed live
    # 2026-08-08) — unconditionally, not just when offline_by_venue is
    # non-empty, so online_reached/online_confirmed/online_confirmed_female
    # are always present alongside the blended reached/confirmed/
    # confirmed_female, for a per-venue Online vs Offline drill.
    venue_to_parish = {v: p for (p, v) in targets_by_venue}
    merged_by_venue = []
    seen_venues = set()
    for r in by_venue:
        o = offline_by_venue.get(r["venue"]) or {}
        online_reached, online_confirmed = r.get("online_reached") or 0, r.get("online_confirmed") or 0
        online_confirmed_female = r.get("online_confirmed_female") or 0
        offline_reached, offline_confirmed = o.get("offline_reached") or 0, o.get("offline_confirmed") or 0
        offline_confirmed_female = o.get("offline_confirmed_female") or 0
        merged_by_venue.append({
            **r,
            "online_reached": online_reached, "online_confirmed": online_confirmed, "online_confirmed_female": online_confirmed_female,
            "offline_reached": offline_reached, "offline_confirmed": offline_confirmed, "offline_confirmed_female": offline_confirmed_female,
            "reached": online_reached + offline_reached,
            "confirmed": online_confirmed + offline_confirmed,
            "confirmed_female": online_confirmed_female + offline_confirmed_female,
        })
        seen_venues.add(r["venue"])
    for venue, o in offline_by_venue.items():
        if venue in seen_venues:
            continue
        parish = venue_to_parish.get(venue)
        if parish is None:
            continue  # no known parish for this venue at all — out of scope, same as elsewhere in this function
        offline_reached, offline_confirmed = o.get("offline_reached") or 0, o.get("offline_confirmed") or 0
        offline_confirmed_female = o.get("offline_confirmed_female") or 0
        merged_by_venue.append({
            "parish": parish, "venue": venue,
            "online_reached": 0, "online_confirmed": 0, "online_confirmed_female": 0,
            "offline_reached": offline_reached, "offline_confirmed": offline_confirmed, "offline_confirmed_female": offline_confirmed_female,
            "reached": offline_reached, "confirmed": offline_confirmed, "confirmed_female": offline_confirmed_female,
        })
    by_venue = merged_by_venue

    # Actual (call-center) rows are grouped by PARISH here, deliberately NOT
    # by agent_district — confirmed with the recruitment team, 2026-08-04:
    # agent_district is where the calling AGENT is based, not the youth's
    # district. A Bugiri-based agent calling into Bukaye/Bukoona/Bulubandi
    # (real Iganga parishes) tags those rows agent_district='BUGIRI', so
    # filtering or grouping the actual side by agent_district silently
    # discards (or misfiles) real BC5 activity. venue_parish and venue_name
    # are reliable — verified live against PARISH_TARGETS_BC5's own parish
    # list and venue names. district for the actual side is therefore
    # DERIVED from parish via district_by_parish (built from the target
    # side's own agent_district, which — unlike the actual side's — does
    # correctly match each parish's real district, confirmed the same way).
    district_by_parish = {p: d for (d, p) in targets_by_parish}

    parish_actual_sql = f"""
    SELECT {canonical_parish_sql("venue_parish")} AS parish,
           SUM(total_youth_reached) AS online_reached, SUM(total_acquired_youth) AS online_confirmed,
           SUM(IF(UPPER(youth_gender) = 'FEMALE', total_acquired_youth, 0)) AS online_confirmed_female
    FROM {DAILY_ACQUISITION_SUMMARY}
    WHERE {where} AND measure = '{DAILY_ACQ_MEASURE_ACTUAL}' AND collection_type = '{ONLINE_COLLECTION_TYPE}' AND venue_parish IS NOT NULL
    GROUP BY parish
    """
    actual_by_parish_raw = {r["parish"]: r for r in database.run_query(parish_actual_sql, params, role=user.role)}
    # Re-keyed to (district, parish) via the derived district, so the rest of
    # this function's (district, parish) lookups work unchanged. A parish
    # with actual data but no match in district_by_parish (a genuinely
    # different program's parish, e.g. Kampala-area noise seen live) has no
    # known district and is dropped here — it was never going to survive the
    # target-scoping below anyway. offline_* seeded at 0 here — filled in by
    # the merge loop below wherever an Offline venue maps into this parish —
    # so every entry always carries both channels' fields for a per-parish
    # Online vs Offline drill, not just the blended reached/confirmed/
    # confirmed_female used elsewhere in this function.
    actual_by_parish = {
        (district_by_parish[p], p): {
            **r,
            "offline_reached": 0, "offline_confirmed": 0, "offline_confirmed_female": 0,
            "reached": r.get("online_reached") or 0,
            "confirmed": r.get("online_confirmed") or 0,
            "confirmed_female": r.get("online_confirmed_female") or 0,
        }
        for p, r in actual_by_parish_raw.items()
        if p in district_by_parish
    }

    # Roll Offline up to parish grain too (same merge as by_venue above, via
    # the same venue_to_parish lookup — parish_actual_sql can't pick these
    # rows up directly, venue_parish is always NULL for them). Same
    # fresh-dict rule as by_venue above — actual_by_parish's values are the
    # exact row objects database.run_query() returned (possibly the cached
    # ones), so an in-place "+=" here would compound too. Reads back through
    # `existing` (not the original query row) so two Offline venues sharing a
    # parish accumulate correctly across iterations.
    for venue, o in offline_by_venue.items():
        parish = venue_to_parish.get(venue)
        district = district_by_parish.get(parish)
        if parish is None or district is None:
            continue
        key = (district, parish)
        existing = actual_by_parish.get(key) or {
            "parish": parish,
            "online_reached": 0, "online_confirmed": 0, "online_confirmed_female": 0,
            "offline_reached": 0, "offline_confirmed": 0, "offline_confirmed_female": 0,
            "reached": 0, "confirmed": 0, "confirmed_female": 0,
        }
        offline_reached = (existing.get("offline_reached") or 0) + (o.get("offline_reached") or 0)
        offline_confirmed = (existing.get("offline_confirmed") or 0) + (o.get("offline_confirmed") or 0)
        offline_confirmed_female = (existing.get("offline_confirmed_female") or 0) + (o.get("offline_confirmed_female") or 0)
        actual_by_parish[key] = {
            **existing,
            "offline_reached": offline_reached,
            "offline_confirmed": offline_confirmed,
            "offline_confirmed_female": offline_confirmed_female,
            "reached": (existing.get("online_reached") or 0) + offline_reached,
            "confirmed": (existing.get("online_confirmed") or 0) + offline_confirmed,
            "confirmed_female": (existing.get("online_confirmed_female") or 0) + offline_confirmed_female,
        }

    # Per-parish auto-confirm (awareness) numbers and treatment-target share —
    # see mobilisation()'s `combined` section for the same blend at program
    # grain, and its docstring for why call-center-only confirmed/reached can
    # be zero for a parish while this pathway's numbers are real. BC5-only:
    # PARISH_TARGETS_BC5 has no cohort column.
    auto_by_parish = _auto_confirmed_by_parish(district, user.role, cohort, date_from, date_to)
    treatment_target_by_parish = {}
    if "BOOTCAMP_5" in cohorts:
        pt_where, pt_params = build_where(
            districts=district, prefix="pth", district_col="district",
            extra=[("category = 'New Recruits'", [])],
        )
        pt_rows = database.run_query(
            f"""
            SELECT UPPER(district) AS district, UPPER(parish) AS parish,
                   SUM(new_recruits_eligible_treatment) AS treatment_target
            FROM {PARISH_TARGETS_BC5} WHERE {pt_where}
            GROUP BY district, parish
            """,
            pt_params, role=user.role)
        treatment_target_by_parish = {(r["district"], r["parish"]): round(r.get("treatment_target") or 0) for r in pt_rows}

    # Only parishes with a real target row for this cohort — NOT the union
    # with actual_by_parish. Confirmed with the recruitment team, 2026-08-04:
    # BOOTCAMP_5 only runs in IGANGA/MAYUGE (matches the target rows
    # exactly); a parish with call-center activity but no target row at all
    # is out of scope for this rollup. Same principle covers every cohort
    # (e.g. BOOTCAMP_4 is BUGIRI/BUGWERI) without hardcoding a per-cohort
    # district list.
    #
    # Every count is disaggregated by source (call-center vs auto-confirm
    # awareness) AND by which of the two sources' OWN targets it should be
    # checked against — confirmed with the recruitment team, 2026-08-04, one
    # blended progress % hid which pathway was actually driving (or missing)
    # progress. mobilisation_target is the acquisition-side target
    # (preload/mobilisation_target rows); treatment_target is this parish's
    # share of PARISH_TARGETS_BC5's awareness-stage eligible target (BC5-only
    # — that table has no cohort column, so it's 0 for other cohorts).
    # `target`/`confirmed`/`reached`/`confirmed_female` stay as the combined
    # totals too, for anything that just wants one number. online_*/offline_*
    # are ALSO carried at this grain (unblended) — for a per-parish Online vs
    # Offline drill; they sum to call_centre_reached/call_centre_confirmed/
    # call_centre_confirmed_female by construction.
    all_parishes = sorted(set(targets_by_parish))
    by_parish = []
    for key in all_parishes:
        d, p = key
        t = targets_by_parish.get(key, {})
        a = actual_by_parish.get(key, {})
        auto = auto_by_parish.get(key, {})
        mobilisation_target = t.get("target") or 0
        treatment_target = treatment_target_by_parish.get(key, 0)
        online_reached, online_confirmed = a.get("online_reached") or 0, a.get("online_confirmed") or 0
        online_confirmed_female = a.get("online_confirmed_female") or 0
        offline_reached, offline_confirmed = a.get("offline_reached") or 0, a.get("offline_confirmed") or 0
        offline_confirmed_female = a.get("offline_confirmed_female") or 0
        call_centre_reached, call_centre_confirmed = online_reached + offline_reached, online_confirmed + offline_confirmed
        call_centre_confirmed_female = online_confirmed_female + offline_confirmed_female
        auto_confirmed, auto_confirmed_female = auto.get("n") or 0, auto.get("nf") or 0
        by_parish.append({
            "district": d,
            "parish": p,
            "assigned": t.get("assigned") or 0,
            "mobilisation_target": mobilisation_target,
            "treatment_target": treatment_target,
            "target": mobilisation_target + treatment_target,
            "online_reached": online_reached,
            "online_confirmed": online_confirmed,
            "online_confirmed_female": online_confirmed_female,
            "offline_reached": offline_reached,
            "offline_confirmed": offline_confirmed,
            "offline_confirmed_female": offline_confirmed_female,
            "call_centre_reached": call_centre_reached,
            "call_centre_confirmed": call_centre_confirmed,
            "call_centre_confirmed_female": call_centre_confirmed_female,
            "auto_confirmed": auto_confirmed,
            "auto_confirmed_female": auto_confirmed_female,
            "reached": call_centre_reached + auto_confirmed,
            "confirmed": call_centre_confirmed + auto_confirmed,
            "confirmed_female": call_centre_confirmed_female + auto_confirmed_female,
        })

    # District totals — summed straight from by_parish (not a separate
    # district-grain query) so the two levels can never disagree. Only
    # districts with a real target row for this cohort, same reasoning as
    # all_parishes above.
    _DISTRICT_SUM_DEFAULTS = {
        "assigned": 0, "mobilisation_target": 0, "treatment_target": 0,
        "online_reached": 0, "online_confirmed": 0, "online_confirmed_female": 0,
        "offline_reached": 0, "offline_confirmed": 0, "offline_confirmed_female": 0,
        "call_centre_reached": 0, "call_centre_confirmed": 0, "call_centre_confirmed_female": 0,
        "auto_confirmed": 0, "auto_confirmed_female": 0,
    }
    by_district_acc = {}
    for p in by_parish:
        e = by_district_acc.setdefault(p["district"], dict(_DISTRICT_SUM_DEFAULTS))
        for k in e:
            e[k] += p[k]
    by_district = []
    for d in sorted(set(targets_by_district)):
        e = by_district_acc.get(d, dict(_DISTRICT_SUM_DEFAULTS))
        by_district.append({
            "district": d,
            **e,
            "target": e["mobilisation_target"] + e["treatment_target"],
            "reached": e["call_centre_reached"] + e["auto_confirmed"],
            "confirmed": e["call_centre_confirmed"] + e["auto_confirmed"],
            "confirmed_female": e["call_centre_confirmed_female"] + e["auto_confirmed_female"],
        })

    # Same "in scope" reasoning as all_districts/all_parishes above, applied
    # via parish (venue rows have no reliable district of their own — see
    # district_by_parish above) — as a UNION, not a filter, of the two
    # sources: a venue is in scope if EITHER it has a live target row for
    # this cohort, OR its actual data's parish is one of this cohort's real
    # target parishes. Each venue then merges whichever source(s) it has,
    # defaulting the missing side to 0/hardcoded-target. BOOTCAMP_4 never
    # reaches this at all — its daily_aggregates rows have venue_name NULL
    # throughout (a separate, pre-existing gap, confirmed 2026-08-04), so
    # by_venue_sql's own IS NOT NULL filter already excludes them.
    actual_by_venue = {(r["parish"], r["venue"]): r for r in by_venue if r["parish"] in district_by_parish}
    all_venue_keys = sorted(set(targets_by_venue) | set(actual_by_venue))
    venues_per_parish = {}
    for p, _ in all_venue_keys:
        venues_per_parish[p] = venues_per_parish.get(p, 0) + 1
    by_venue_final = []
    for key in all_venue_keys:
        p, v = key
        t = targets_by_venue.get(key)  # None (not {}) when there's no live row at all
        a = actual_by_venue.get(key, {})
        if t is not None:
            assigned, target = t.get("assigned") or 0, t.get("target") or 0
        else:
            assigned, target = 0, venue_mobilisation_target(v) or 0
        d = district_by_parish.get(p) or (t or {}).get("district")
        # A venue's own live target can be 0 even when a real per-parish
        # target exists — confirmed live 2026-08-05: NAKIBENGO WARD/Busenda
        # Primary School's DAILY_ACQUISITION_TARGETS_DEDUPED row has
        # mobilisation_target literally 0, but targets_by_parish (already
        # BC5-corrected via _mobilisation_target_by_parish_bc5 above) has 17
        # for that parish. Only applied when the parish has exactly one
        # venue, so the parish figure maps 1:1 onto it instead of being an
        # approximation split across siblings.
        if not target and venues_per_parish.get(p) == 1:
            parish_target = (targets_by_parish.get((d, p)) or {}).get("target")
            if parish_target:
                target = parish_target
        auto = auto_by_parish.get((d, p), {})
        by_venue_final.append({
            "district": d,
            "parish": p,
            "venue": v,
            "assigned": assigned,
            "target": target,
            # Unblended per-channel figures, carried alongside the blended
            # reached/confirmed/confirmed_female below — for a per-venue
            # Online vs Offline drill (see by_venue's merge above).
            "online_reached": a.get("online_reached") or 0,
            "online_confirmed": a.get("online_confirmed") or 0,
            "online_confirmed_female": a.get("online_confirmed_female") or 0,
            "offline_reached": a.get("offline_reached") or 0,
            "offline_confirmed": a.get("offline_confirmed") or 0,
            "offline_confirmed_female": a.get("offline_confirmed_female") or 0,
            "reached": a.get("reached") or 0,
            "confirmed": a.get("confirmed") or 0,
            "confirmed_female": a.get("confirmed_female") or 0,
            # Parish-level, NOT venue-specific — awareness-stage records
            # carry no venue at all (see this function's docstring), so a
            # parish with more than one venue shows the SAME auto-confirmed
            # number on each of its venues. Shown for structural parity with
            # by_parish's Auto-confirmed block; deliberately NOT blended into
            # confirmed/target/reached above (which stay call-center-only),
            # since summing those across a parish's venues would otherwise
            # double- (or triple-, ...) count that parish's real number.
            "auto_confirmed": auto.get("n") or 0,
            "auto_confirmed_female": auto.get("nf") or 0,
            "treatment_target": treatment_target_by_parish.get((d, p), 0),
        })

    return {"by_venue": by_venue_final, "by_district": by_district, "by_parish": by_parish}


@router.get("/api/recruitment/mobilisation-forecast")
def mobilisation_forecast(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
):
    """Daily reached/confirmed trend vs the mobilisation target, with a simple
    pace-to-target projection — same shape as /api/recruitment/awareness-forecast.

    date_from/date_to narrow the daily series and confirmed_to_date (call_date
    on DAILY_ACQUISITION_SUMMARY, report_date on AWARENESS_KYC for the
    auto-confirmed pathway) — never `target`, a static planning figure with
    no date to filter by.

    reached/confirmed per day are blended Online + Offline, same as
    /api/recruitment/mobilisation's headline (see ONLINE_COLLECTION_TYPE/
    OFFLINE_COLLECTION_TYPE, tables.py, and that endpoint's docstring) — both
    channels have their own genuine reached/confirmed pair, so a plain SUM
    across every row (no collection_type filter needed) is the correct
    blended daily total.
    """
    where, params = build_where(
        districts=district,
        extra=[active_cohort_clause("mf", requested=cohort)] + _date_extra("call_date", date_from, date_to, "mf"),
        prefix="mf", district_col="agent_district",
    )
    daily_sql = f"""
    SELECT call_date AS event_date, SUM(total_youth_reached) AS reached,
           SUM(total_acquired_youth) AS confirmed
    FROM {DAILY_ACQUISITION_SUMMARY}
    WHERE {where} AND measure = '{DAILY_ACQ_MEASURE_ACTUAL}' AND call_date IS NOT NULL
    GROUP BY event_date ORDER BY event_date
    """
    daily = database.run_query(daily_sql, params, role=user.role)

    target_where, target_params = build_where(
        districts=district, extra=[active_cohort_clause("mft", requested=cohort)], prefix="mft",
        district_col="agent_district",
    )
    target = (database.run_query(
        f"SELECT SUM(mobilisation_target) AS t FROM {DAILY_ACQUISITION_TARGETS_DEDUPED} "
        f"WHERE {target_where} AND measure = '{DAILY_ACQ_MEASURE_TARGET}'",
        target_params, role=user.role) or [{}])[0].get("t") or 0

    confirmed_to_date = sum(d.get("confirmed") or 0 for d in daily) + _auto_confirmed_count(district, None, user.role, cohort, date_from, date_to)
    n_days = len(daily)
    avg_daily_rate = (confirmed_to_date / n_days) if n_days else None
    remaining = max(target - confirmed_to_date, 0)
    days_to_target = round(remaining / avg_daily_rate) if avg_daily_rate else None

    return {
        "daily": daily,
        "confirmed_to_date": confirmed_to_date,
        "target": target,
        "avg_daily_rate": round(avg_daily_rate, 1) if avg_daily_rate is not None else None,
        "days_to_target": days_to_target,
    }


@router.get("/api/recruitment/control-calls")
def control_calls(
    user: User = Depends(current_user),
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
):
    """The randomised control/comparison arm — eligible youth tracked (status
    and reachability only, no mobilisation pitch) but not actively mobilised,
    so the effect of mobilisation can be measured against a real counterfactual.

    Backed by the live CONTROL_CALLS_BC4 table (single-cycle — no bootcamp_cycle
    column, no district/gender filter param since the whole table already is
    the BC4 control arm). decision/interest fields are empty by design here —
    control calls only confirm status and reachability, no mobilisation pitch.

    date_from/date_to filter on date_added (a real per-record TIMESTAMP,
    confirmed live) — the only filter this endpoint accepts at all.
    """
    date_where_clauses, date_params = date_clauses("DATE(date_added)", date_from, date_to, "cc")
    date_where = (" AND " + " AND ".join(date_where_clauses)) if date_where_clauses else ""

    totals_sql = f"""
    SELECT COUNT(*) AS total,
           COUNTIF(is_control = TRUE) AS control,
           COUNTIF(is_control IS NOT TRUE) AS mobilization,
           COUNTIF(UPPER(status) = 'REACHED') AS reached,
           COUNTIF(UPPER(gender) = 'FEMALE') AS female,
           COUNTIF(UPPER(gender) = 'MALE') AS male,
           AVG(age) AS avg_age
    FROM {CONTROL_CALLS_BC4}
    WHERE TRUE{date_where}
    """
    totals = (database.run_query(totals_sql, date_params, role=user.role) or [{}])[0]

    district_sql = f"""
    SELECT UPPER(district) AS district, COUNT(*) AS n
    FROM {CONTROL_CALLS_BC4} WHERE district IS NOT NULL{date_where}
    GROUP BY district ORDER BY n DESC
    """
    by_district = database.run_query(district_sql, date_params, role=user.role)

    status_sql = f"""
    SELECT status, COUNT(*) AS n FROM {CONTROL_CALLS_BC4}
    WHERE status IS NOT NULL{date_where} GROUP BY status ORDER BY n DESC
    """
    by_status = database.run_query(status_sql, date_params, role=user.role)

    total = totals.get("total") or 0
    reached = totals.get("reached") or 0
    female = totals.get("female") or 0
    return {
        "total": total,
        "control": totals.get("control") or 0,
        "mobilization": totals.get("mobilization") or 0,
        "reached": reached,
        "reach_pct": round(100 * reached / total, 1) if total else None,
        "female": female,
        "male": totals.get("male") or 0,
        "pct_female": round(100 * female / total, 1) if total else None,
        "avg_age": round(totals["avg_age"], 1) if totals.get("avg_age") is not None else None,
        "by_district": by_district,
        "by_status": by_status,
    }


# ─── Call Centre Insights: free-text categorisation ─────────────────────────
# Keyword-based (not a live ML/LLM call) categorisation of BC5_ACQUISITION_CALLS'
# genuinely-free-text fields (non_attendance_reason, 92 values; questions, 802
# values), tuned by reading every single one live, 2026-08-04. A live model
# call was considered and rejected for now — this backend has no LLM
# dependency/secret today, and ~900 short strings a request is comfortably
# handled by a fixed keyword ruleset re-derived from the actual corpus;
# re-tune the lists below if a later cohort's free text drifts from BC5's
# patterns (typos, phrasing). This is NOT used for gatekeeper_relationship or
# attendance_support_notes — those are already-coded structured columns (see
# tables.py), not prose needing this kind of interpretation.
_DECLINE_REASON_KEYWORDS = [
    ("Already employed / running a business", ["job", "business", "teacher", "qualified", "work"]),
    ("In school / studying", ["school", "study", "studying", "exam", "university", "campus", "enrolled", "hairdressing", "hair dressing"]),
    ("Pregnancy / young child to care for", ["pregnan", "gave birth", "delivered", "baby", "child", "nowhere to leave"]),
    ("Illness or family emergency", ["illness", "sick", "emergency"]),
    ("Relocated / travelled away", ["relocat", "travel", "abroad", "moved", "far away", "gulu", "entebbe"]),
    ("Already attended a bootcamp", ["attended", "participated"]),
    ("Home / family responsibilities", ["home responsibilit", "marriage", "family"]),
    ("Lost interest", ["no longer interested", "nolonger interested", "lost interest"]),
    ("Duplicate registration", ["registered twice"]),
]


def _categorize_decline_reason(text: str) -> str:
    t = (text or "").strip().lower()
    if not t:
        return "Other / unclear"
    for label, keywords in _DECLINE_REASON_KEYWORDS:
        if any(kw in t for kw in keywords):
            return label
    return "Other / unclear"


# Checked in order, first match wins — order encodes priority (e.g. a text
# mentioning both a relative AND a call-status word is filed under gatekeeper,
# the more specific signal). No "support ask" bucket here on purpose — that
# signal has its own dedicated, much better-populated structured field
# (attendance_support_notes, see BC5_ACQUISITION_CALLS in tables.py) instead
# of being mined out of this general notes field.
_FEEDBACK_THEMES = [
    ("Confirmed attending", [
        r"\bwill attend\b", r"\bcoming\b", r"\bready to\b", r"\bready for\b",
        r"\bwilling to attend\b", r"\bwill come\b", r"\bwill first get to the youth\b",
    ]),
    ("Declined / not attending", [
        r"\bnot attend\b", r"\bwont attend\b", r"won'?t attend", r"\bdeclined\b",
        r"no ?longer interested", r"\bnot eligible\b", r"\blost interest\b",
    ]),
    ("Reached via gatekeeper / proxy", [
        r"\bhusband\b", r"\bwife\b", r"\bspouse\b", r"\bmother\b", r"\bfather\b",
        r"\bdad\b", r"\bmum\b", r"\bparent\b", r"\bsister\b", r"\bbrother\b",
        r"\bdaughter\b", r"\bson\b", r"\baunt\b", r"\buncle\b", r"\bguardian\b",
        r"community leader", r"\bthe leader\b",
    ]),
    ("Genuine question from youth", [
        r"\?", r"^what\b", r"^how\b", r"will you\b", r"^can i\b", r"^should i\b",
        r"where shall", r"are there", r"^so are you\b", r"remind me",
    ]),
    ("Life circumstance (school/job/pregnancy/relocation/illness)", [
        r"\bpregnan", r"gave birth", r"\bbaby\b", r"\brelocat", r"\btravel",
        r"\bschool\b", r"\bcampus\b", r"\bstudent\b", r"\bjob\b", r"\bsick\b",
        r"\billness\b", r"studied last", r"attended last", r"completed studying",
        r"\bfar\b", r"\bburial\b",
    ]),
    ("Identity / record mismatch", [
        r"does\s*n'?t\s*know", r"does\s+not\s+know", r"name(s)?\s*(not|does not)\s*match",
        r"not matching", r"registered twice", r"wrong name", r"name is",
    ]),
    ("Appreciation", [r"appreciat", r"thanks for"]),
    ("Could not reach (call status note)", [
        r"not\s*pick", r"no answer", r"\bbusy\b", r"rejected", r"wrong\b.*\bnumber\b|number\b.*wrong|awrong",
        r"not at home", r"not with", r"engaged", r"hung up", r"hanged up|hunged up",
        r"fol+ow\s*up", r"call\s*back", r"subscriber absent", r"not answering",
        r"call dropped", r"not in service", r"call again", r"second attempt",
        r"will call", r"will communicate", r"not picked", r"not available",
    ]),
]


def _classify_feedback(text: str) -> str:
    t = (text or "").strip().lower()
    if not t:
        return "Other / unclear"
    for label, patterns in _FEEDBACK_THEMES:
        for p in patterns:
            if re.search(p, t):
                return label
    return "Other / unclear"


def _clean_quote(text: str) -> str:
    t = " ".join((text or "").split())
    return (t[:1].upper() + t[1:]) if t else t


_DECISION_LABELS = {"None": "No gatekeeper (decided directly)"}

# Second-level theming, applied only to quotes already sorted into "Genuine
# question from youth" by _classify_feedback above — derived the same way,
# by reading all 16 BC5 values live (2026-08-04).
_QUESTION_SUBTHEMES = [
    ("Registration / identity", ["names"]),
    ("Curriculum / what's taught", ["teaching", "how to balance", "teach us"]),
    ("Post-bootcamp benefits (capital/business support)", ["benefit", "business", "get after", "good things", "after studying"]),
    # Below "Post-bootcamp benefits" on purpose — "Will you give us businesses/
    # capital?" should still land there via "business", not here via "capital".
    ("Support-related ask (transport/capital/childcare/bursary)", ["capital", "transport", "bursary", "baby", "bring"]),
    ("Logistics — when/where to show up", ["where", "when", "start", "wake up", "that day", "how long", "study from"]),
]
# Same idea, scoped to "Reached via gatekeeper / proxy" quotes — read all 13
# BC5 values live (2026-08-04) to derive these. "Spouse restricting access" is
# split out from the more benign "spouse relayed a message" case since it's a
# materially different, more concerning signal (active gatekeeping, not just
# a shared phone) — order matters: checked before the generic spouse keyword.
_GATEKEEPER_SUBTHEMES = [
    ("Distrust of Educate!", ["trust", "scam"]),
    ("Spouse restricting/controlling access", ["refused to give", "will not allow", "not allow her"]),
    ("Spouse is the point of contact / owns the phone", ["husband", "wife", "spouse"]),
    ("Community leader / shared-phone proxy", ["community leader", "the leader"]),
    ("Family member relaying info (parent/sibling/child)", [
        "mother", "father", "dad", "mum", "parent", "sister", "brother",
        "daughter", "son", "aunt", "uncle", "guardian",
    ]),
]


def _subtheme(text: str, rules) -> str:
    t = (text or "").strip().lower()
    for label, keywords in rules:
        if any(kw in t for kw in keywords):
            return label
    return "Other"


# ─── BC5_ACQUISITION_CALLS-only fields: gatekeeper_relationship / ────────────
# attendance_support_notes — REAL structured columns (see tables.py), not
# free text needing a keyword theme classifier. Normalisation here is data
# hygiene only (case/underscore cleanup, one known source typo fixed, stray
# phone-number entries folded into "Other") — never inference about meaning.
_GATEKEEPER_RELATIONSHIP_CANON = {
    "parent": "Parent", "spouse": "Spouse", "relative": "Relative",
    "other": "Other", "granny": "Relative",
}


def _normalize_gatekeeper_relationship(raw: str) -> str:
    t = (raw or "").strip()
    if t.replace(" ", "").isdigit():  # a phone number entered in this field by mistake
        return "Other"
    return _GATEKEEPER_RELATIONSHIP_CANON.get(t.lower(), "Other")


_SUPPORT_NOTE_ALIASES = {"family responsibilies": "Family responsibilities"}  # source typo


def _normalize_support_note(raw: str) -> str:
    t = " ".join((raw or "").split())
    key = t.lower().replace("_", " ")
    if key in _SUPPORT_NOTE_ALIASES:
        return _SUPPORT_NOTE_ALIASES[key]
    if len(key.split()) > 5:
        return _clean_quote(t)  # the handful of genuine free-text entries — keep verbatim
    return key[:1].upper() + key[1:]


def _grouped_counts(values, normalize):
    counts = {}
    n = 0
    for v in values:
        if not (v or "").strip():
            continue
        n += 1
        label = normalize(v)
        counts[label] = counts.get(label, 0) + 1
    return n, sorted(counts.items(), key=lambda kv: -kv[1])


@router.get("/api/recruitment/call-centre-insights")
def call_centre_insights(
    user: User = Depends(current_user),
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
):
    """Call Centre Insights for the Mobilisation tab — BOOTCAMP_5 only, since
    that's the cohort the reference design targets and the only one this page
    is asked to cover. Backed by the live BC5_ACQUISITION_CALLS (see tables.py
    for why this table, not the cross-cohort ACQUISITION_CALL_LOG mart, is the
    source here — same 3,010 calls, but with two fields the mart drops).

    BOOTCAMP_5's `barriers` column is entirely NULL in the source (that
    free-text taxonomy was only ever populated for BOOTCAMP_4 calls) so this
    mirrors the reference layout using the fields BC5 actually has instead:
    - `call_status` (100% populated) — real call-outcome breakdown.
    - `attendance_status` (Yes/No/Maybe, populated on ~27% of calls — not
      every call reaches a youth who states an opinion) — real "positive
      intent" KPI.
    - `decision_consultant` (Parents/Spouse/Relatives/Friend/Leader/None,
      ~24% populated) — who actually decides/answers for the youth, i.e. the
      "gatekeeper". `gatekeeper_rate` is the share of decision-captured calls
      where that's someone other than the youth. `gatekeepers.relationship`
      is a second, largely independent structured field — populated whenever
      a proxy contact was actually reached (640 rows, 21%), regardless of
      whether the youth's own decision was also captured — so it doesn't
      double-count `gatekeeper_rate`'s denominator, it's a complementary
      REAL count with its own, larger N. `gatekeepers.interactions` is a
      third, much smaller (13 quotes) SAMPLE-tier read of the same
      phenomenon, keyword-mined from `questions` — kept for the qualitative
      texture (real telemarketer wording), not as the primary metric.
    - `non_attendance_reason` — free-text decline/hesitation reasons,
      populated only when attendance_status is 'No' (80 rows) or 'Maybe' (12
      rows) — reported as two separate breakdowns (not blended) since the
      reasons a "no" gives and a "maybe" gives are different signals.
      Categorised with the keyword ruleset above, tuned against every one of
      those 92 values.
    - `attendance_support_notes` (REAL, 720/3,010 populated) — a coded field
      (Transport/No support needed/Follow up calls/Other/...), not free text
      needing a keyword theme classifier — this IS the real answer to "what
      support do youth need" for BC5. The `support_needed`/
      `other_support_details` columns on both this table and the cross-cohort
      mart are 100% NULL for BC5; this is the field that actually carries the
      signal, just under a different name.
    - `questions` (~27% populated, 802 BC5 rows) — free-text agent notes
      (same content as ACQUISITION_CALL_LOG's `questions_feedback`, just the
      table's own native column name). Categorised into `feedback_themes`
      (kept for the PDF export's full breakdown, not surfaced on the page
      itself); the two most actionable themes are pulled out and further
      split into their own sub-themes (a second keyword pass, scoped to just
      that theme's quotes): `genuine_questions` (youth asking something) and
      `gatekeepers.interactions` (described above). Each is
      `{n, themes, quotes}` — `themes` counts every match (not deduped, so
      frequency is honest), `quotes` is deduped for display.
    "Enablers" (in the reference design) has no structured BC5 source —
    omitted rather than inventing sample data. Not tagged by district/gender
    in the source, so no filters for those; cohort is fixed rather than a
    filter since this page is BC5-only by design.

    date_from/date_to filter on created_at (a real per-record TIMESTAMP,
    confirmed live — call_timestamp exists too but is stored as STRING, not
    a proper date/timestamp type, so created_at is the reliable column).
    """
    date_where_clauses, date_params = date_clauses("DATE(created_at)", date_from, date_to, "cci")
    date_where = (" AND " + " AND ".join(date_where_clauses)) if date_where_clauses else ""

    totals_sql = f"""
    SELECT
      COUNT(*) AS total_calls,
      COUNTIF(call_status = 'Reached') AS reached,
      COUNTIF(attendance_status = 'Yes') AS interested_yes,
      COUNTIF(attendance_status = 'No') AS interested_no,
      COUNTIF(attendance_status = 'Maybe') AS interested_maybe
    FROM {BC5_ACQUISITION_CALLS}
    WHERE bootcamp_cycle = 'BOOTCAMP_5'{date_where}
    """
    totals = (database.run_query(totals_sql, date_params, role=user.role) or [{}])[0]

    outcomes_sql = f"""
    SELECT call_status AS status, COUNT(*) AS count
    FROM {BC5_ACQUISITION_CALLS}
    WHERE bootcamp_cycle = 'BOOTCAMP_5' AND call_status IS NOT NULL{date_where}
    GROUP BY status ORDER BY count DESC
    """
    outcomes = database.run_query(outcomes_sql, date_params, role=user.role)
    outcomes_total = sum(r["count"] for r in outcomes)
    for r in outcomes:
        r["pct"] = round(100 * r["count"] / outcomes_total, 1) if outcomes_total else None

    decision_sql = f"""
    SELECT decision_consultant AS who, COUNT(*) AS count
    FROM {BC5_ACQUISITION_CALLS}
    WHERE bootcamp_cycle = 'BOOTCAMP_5' AND decision_consultant IS NOT NULL AND decision_consultant != ''{date_where}
    GROUP BY who ORDER BY count DESC
    """
    decision_rows = database.run_query(decision_sql, date_params, role=user.role)
    decision_total = sum(r["count"] for r in decision_rows)
    gatekeeper_n = sum(r["count"] for r in decision_rows if r["who"] != "None")
    gatekeeper_breakdown = [
        {"who": _DECISION_LABELS.get(r["who"], r["who"]), "count": r["count"],
         "pct": round(100 * r["count"] / decision_total, 1) if decision_total else None}
        for r in decision_rows
    ]

    gatekeeper_rel_sql = f"""
    SELECT gatekeeper_relationship AS who
    FROM {BC5_ACQUISITION_CALLS}
    WHERE bootcamp_cycle = 'BOOTCAMP_5' AND gatekeeper_relationship IS NOT NULL AND gatekeeper_relationship != ''{date_where}
    """
    gatekeeper_rel_rows = database.run_query(gatekeeper_rel_sql, date_params, role=user.role)
    gatekeeper_rel_n, gatekeeper_rel_counts = _grouped_counts(
        (r["who"] for r in gatekeeper_rel_rows), _normalize_gatekeeper_relationship,
    )
    gatekeeper_relationship = {
        "n": gatekeeper_rel_n,
        "breakdown": [
            {"who": k, "count": v, "pct": round(100 * v / gatekeeper_rel_n, 1) if gatekeeper_rel_n else None}
            for k, v in gatekeeper_rel_counts
        ],
    }

    why_sql = f"""
    SELECT attendance_status AS interest, non_attendance_reason AS reason
    FROM {BC5_ACQUISITION_CALLS}
    WHERE bootcamp_cycle = 'BOOTCAMP_5' AND attendance_status IN ('No', 'Maybe')
      AND non_attendance_reason IS NOT NULL AND non_attendance_reason != ''{date_where}
    """
    why_rows = database.run_query(why_sql, date_params, role=user.role)

    def _decline_breakdown(interest_value):
        cats = {}
        n = 0
        for r in why_rows:
            if r["interest"] != interest_value:
                continue
            n += 1
            label = _categorize_decline_reason(r["reason"])
            cats[label] = cats.get(label, 0) + 1
        categories = sorted(
            [{"category": k, "count": v, "pct": round(100 * v / n, 1) if n else None} for k, v in cats.items()],
            key=lambda x: -x["count"],
        )
        return {"n": n, "categories": categories}

    decline_reasons_no = _decline_breakdown("No")
    decline_reasons_maybe = _decline_breakdown("Maybe")

    support_notes_sql = f"""
    SELECT attendance_support_notes AS note
    FROM {BC5_ACQUISITION_CALLS}
    WHERE bootcamp_cycle = 'BOOTCAMP_5' AND attendance_support_notes IS NOT NULL AND TRIM(attendance_support_notes) != ''{date_where}
    """
    support_notes_rows = database.run_query(support_notes_sql, date_params, role=user.role)
    support_n, support_counts = _grouped_counts(
        (r["note"] for r in support_notes_rows), _normalize_support_note,
    )
    attendance_support_needed = {
        "n": support_n,
        "categories": [
            {"category": k, "count": v, "pct": round(100 * v / support_n, 1) if support_n else None}
            for k, v in support_counts
        ],
    }

    feedback_sql = f"""
    SELECT questions AS text
    FROM {BC5_ACQUISITION_CALLS}
    WHERE bootcamp_cycle = 'BOOTCAMP_5' AND questions IS NOT NULL AND TRIM(questions) != ''{date_where}
    """
    feedback_texts = [r["text"] for r in database.run_query(feedback_sql, date_params, role=user.role)]
    feedback_n = len(feedback_texts)

    theme_counts, theme_quotes = {}, {}
    for t in feedback_texts:
        label = _classify_feedback(t)
        theme_counts[label] = theme_counts.get(label, 0) + 1
        theme_quotes.setdefault(label, []).append(_clean_quote(t))

    feedback_themes = sorted(
        [{"theme": k, "count": v, "pct": round(100 * v / feedback_n, 1) if feedback_n else None} for k, v in theme_counts.items()],
        key=lambda x: -x["count"],
    )

    def _unique_quotes(label, limit=50):
        seen, out = set(), []
        for q in theme_quotes.get(label, []):
            key = q.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(q)
            if len(out) >= limit:
                break
        return out

    def _themed(label, rules):
        raw = theme_quotes.get(label, [])
        n = len(raw)
        counts = {}
        for q in raw:
            sub = _subtheme(q, rules)
            counts[sub] = counts.get(sub, 0) + 1
        themes = sorted(
            [{"theme": k, "count": v, "pct": round(100 * v / n, 1) if n else None} for k, v in counts.items()],
            key=lambda x: -x["count"],
        )
        return {"n": n, "themes": themes, "quotes": _unique_quotes(label)}

    total_calls = totals.get("total_calls") or 0
    reached = totals.get("reached") or 0
    interested_yes = totals.get("interested_yes") or 0
    interested_no = totals.get("interested_no") or 0
    interested_maybe = totals.get("interested_maybe") or 0
    interest_answered = interested_yes + interested_no + interested_maybe

    return {
        "calls_analysed": total_calls,
        "reached": reached,
        "reach_rate": round(100 * reached / total_calls, 1) if total_calls else None,
        "interest_answered": interest_answered,
        "positive_intent_rate": round(100 * interested_yes / interest_answered, 1) if interest_answered else None,
        "interest": [
            {"label": "Yes", "count": interested_yes},
            {"label": "Maybe", "count": interested_maybe},
            {"label": "No", "count": interested_no},
        ],
        "call_outcomes": outcomes,
        "gatekeepers": {
            "n_with_decision": decision_total,
            "gatekeeper_rate": round(100 * gatekeeper_n / decision_total, 1) if decision_total else None,
            "breakdown": gatekeeper_breakdown,
            "relationship": gatekeeper_relationship,
            "interactions": _themed("Reached via gatekeeper / proxy", _GATEKEEPER_SUBTHEMES),
        },
        "decline_reasons_no": decline_reasons_no,
        "decline_reasons_maybe": decline_reasons_maybe,
        "attendance_support_needed": attendance_support_needed,
        "feedback_n": feedback_n,
        "feedback_themes": feedback_themes,
        "genuine_questions": _themed("Genuine question from youth", _QUESTION_SUBTHEMES),
    }


@router.get("/api/recruitment/acquisition")
def acquisition(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),
):
    """Verified -> Acquired by district (arrival-day/Karibu-day verification).

    Backed by the live SITE_FUNNEL_METRICS mart (venue x gender x cycle grain).
    `verified` only exists on 'site_targets' rows (no gender dimension);
    `acquired` only exists on 'site_metrics' rows (gender-split) — see
    tables.py. Conditional SUMs make the measure split explicit rather than
    relying on the other row type's columns happening to be NULL.
    """
    where, params = build_where(
        districts=district, gender=gender,
        extra=[active_cohort_clause("ac", requested=cohort)], prefix="ac",
    )
    sql = f"""
    SELECT
      UPPER(district) AS district,
      SUM(IF(measure = '{SITE_FUNNEL_MEASURE_TARGET}', total_verified_youth, 0)) AS verified,
      SUM(IF(measure = '{SITE_FUNNEL_MEASURE_ACTUAL}', acquired_youth, 0)) AS acquired
    FROM {SITE_FUNNEL_METRICS}
    WHERE {where}
    GROUP BY district
    ORDER BY district
    """
    by_district = database.run_query(sql, params, role=user.role)

    # Cross-funnel KPIs for the Overview page's score-card band: "Overall
    # conversion" (acquired ÷ registered, spanning Awareness through
    # Acquisition) and "Retention rate". retention_rate uses retained ÷
    # ACTIVATED — the same definition /api/implementation/retention uses
    # (confirmed by the recruitment team), not retained ÷ acquired like the
    # reference prototype's illustrative KPI card, so this stays consistent
    # with the Implementation > Retention tab's number for the same cohort.
    totals_sql = f"""
    SELECT
      SUM(IF(measure = '{SITE_FUNNEL_MEASURE_TARGET}', total_verified_youth, 0)) AS verified,
      SUM(IF(measure = '{SITE_FUNNEL_MEASURE_ACTUAL}', acquired_youth, 0)) AS acquired,
      SUM(IF(measure = '{SITE_FUNNEL_MEASURE_ACTUAL}', activated_youth, 0)) AS activated,
      SUM(IF(measure = '{SITE_FUNNEL_MEASURE_ACTUAL}', youth_80pct_lessons, 0)) AS retained
    FROM {SITE_FUNNEL_METRICS}
    WHERE {where}
    """
    site_totals = (database.run_query(totals_sql, params, role=user.role) or [{}])[0]
    verified = site_totals.get("verified") or 0
    acquired = site_totals.get("acquired") or 0
    activated = site_totals.get("activated") or 0
    retained = site_totals.get("retained") or 0

    g = (gender or "").strip().lower()
    reg_col = (
        "total_registered_female" if g == "female"
        else "total_registered_male" if g == "male"
        else "total_registered_youth"
    )
    reg_where, reg_params = build_where(
        districts=district, extra=[active_cohort_clause("acr", requested=cohort)], prefix="acr",
        district_col="youth_district",
    )
    registered = (database.run_query(
        f"SELECT SUM({reg_col}) AS n FROM {AWARENESS_SUMMARY} "
        f"WHERE {reg_where} AND data_measure = '{AWARENESS_MEASURE_ACTUAL}'",
        reg_params, role=user.role) or [{}])[0].get("n") or 0

    return {
        "by_district": by_district,
        "totals": {
            "verified": verified,
            "acquired": acquired,
            "registered": registered,
            "activated": activated,
            "retained": retained,
            "acquisition_rate": round(100 * acquired / verified, 1) if verified else None,
            "overall_conversion_rate": round(100 * acquired / registered, 1) if registered else None,
            "retention_rate": round(100 * retained / activated, 1) if activated else None,
        },
    }


@router.get("/api/recruitment/acquisition-arrival")
def acquisition_arrival(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),
):
    """Verified -> acquired at venue grain, for the Acquisition tab's Arrival &
    Verification sub-page — same live SITE_FUNNEL_METRICS mart as /acquisition
    above, grouped by venue instead of district, with an acquisition-rate
    categorisation (mirrors the Mobilisation venue categorisation: Target
    Achieved >=95% / On Track 85-94% / Low Risk 75-84% / High Risk <75%,
    acquired ÷ verified).

    No per-gender VERIFIED figure exists (verified only lives on the
    genderless 'site_targets' rows — see tables.py), so the gender split shown
    here is female share of ACQUIRED (which is gender-split), not verified.
    """
    where, params = build_where(
        districts=district, extra=[active_cohort_clause("aa", requested=cohort)], prefix="aa",
    )
    sql = f"""
    SELECT UPPER(district) AS district, venue_name AS venue,
           SUM(IF(measure = '{SITE_FUNNEL_MEASURE_TARGET}', total_verified_youth, 0)) AS verified,
           SUM(IF(measure = '{SITE_FUNNEL_MEASURE_ACTUAL}', acquired_youth, 0)) AS acquired,
           SUM(IF(measure = '{SITE_FUNNEL_MEASURE_ACTUAL}' AND UPPER(gender) = 'FEMALE', acquired_youth, 0)) AS acquired_female
    FROM {SITE_FUNNEL_METRICS}
    WHERE {where} AND venue_name IS NOT NULL
    GROUP BY district, venue
    ORDER BY district, venue
    """
    rows = database.run_query(sql, params, role=user.role)
    for r in rows:
        verified, acquired = r.get("verified") or 0, r.get("acquired") or 0
        r["acquisition_rate"] = round(100 * acquired / verified, 1) if verified else None
        r["pct_female_acquired"] = round(100 * (r.get("acquired_female") or 0) / acquired, 1) if acquired else None
    return {"by_venue": rows}


@router.get("/api/recruitment/mobilisers")
def mobilisers(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),
):
    """Mobiliser leaderboard. Names masked to initials for the guest role.

    Still on the placeholder table — no live table has both a named mobiliser
    AND reach/confirm counts. DAILY_ACQUISITION_SUMMARY has reach/confirm but
    mobilizer_name is 100% NULL there; AWARENESS_SUMMARY has mobilizer_name
    but only registered/interested/eligible, no reach/confirmation.
    """
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
    """Youth profile / KYC rows. Names masked for guests; raw id never serialised.

    Backed by the live AWARENESS_KYC per-youth record.
    """
    where, params = build_where(
        districts=district, gender=gender,
        extra=[active_cohort_clause("pe", requested=cohort)], prefix="pe",
        district_col="youth_district", gender_col="youth_gender",
    )
    sql = f"""
    SELECT youth_phone, youth_name, youth_gender AS gender, youth_age AS age,
           UPPER(youth_district) AS district, {normalized_parish_sql()} AS parish,
           youth_village AS village, youth_level_of_education AS education,
           income_past_2_weeks AS income, recruitment_channel AS channel
    FROM {AWARENESS_KYC}
    WHERE {where}
    LIMIT @limit
    """
    rows = database.run_query(sql, params + [_scalar("limit", "INT64", limit)], role=user.role)
    out = []
    for r in rows:
        out.append({
            "youth_id": youth_id(r.pop("youth_phone", None)),  # pseudonym replaces raw id
            "name": mask_name(user.role, r.get("youth_name")),
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
