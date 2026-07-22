"""
Recruitment endpoints — Awareness, Mobilisation, Acquisition, and TAM analysis.

Mobiliser leaderboards and youth personas carry personal names; those are masked
for the guest role via pii.mask_name before serialisation.
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, Query

from app.auth import current_user, User
from app.core import database  # module import — required for the run_query test seam
from app.core.database import _array, _scalar
from app.core.pii import mask_name, youth_id
from app.core.sql import build_where, cohort_clause
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
    DAILY_ACQ_MEASURE_ACTUAL,
    DAILY_ACQ_MEASURE_TARGET,
    SITE_FUNNEL_METRICS,
    SITE_FUNNEL_MEASURE_TARGET,
    SITE_FUNNEL_MEASURE_ACTUAL,
    AWARENESS_KYC,
    ACTIVE_COHORT,
    AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT,
    CONTROL_CALLS_BC4,
    ACQUISITION_CALL_LOG,
    active_cohort_clause,
)

router = APIRouter()


def _auto_confirmed_count(district, gender, role):
    """Eligible + treatment-assigned youth from this cohort's short-cycle pilot
    subcounties (see AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT in tables.py) — they
    bypass daily_acquisition_summary's call-center process entirely and are
    auto-confirmed, so this is added on top of that table's confirmed count,
    never looked up inside it."""
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


def _filter_extra(cohort, prefix):
    extra = [NOT_TEST_DATA]
    coh_clause, coh_params = cohort_clause(cohort, prefix=prefix)
    if coh_clause:
        extra.append((coh_clause, coh_params))
    return extra


@router.get("/api/recruitment/awareness")
def awareness(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),  # accepted but unused — see ACTIVE_COHORT
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
        extra=[active_cohort_clause("aw")], prefix="aw",
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
):
    """Reached/interested/eligible/target/% female at parish grain, for the
    Awareness tab's "Category detail — by parish" table."""
    where, params = build_where(
        districts=district,
        extra=[active_cohort_clause("awp")], prefix="awp",
        district_col="youth_district",
    )
    actual_sql = f"""
    SELECT
      UPPER(youth_district) AS district,
      youth_parish AS parish,
      SUM(total_registered_youth) AS reached,
      SUM(total_interested_youth) AS interested,
      SUM(total_eligible_youth) AS eligible,
      ROUND(SAFE_DIVIDE(SUM(total_eligible_female), NULLIF(SUM(total_eligible_youth), 0)) * 100, 1) AS pct_female
    FROM {AWARENESS_SUMMARY}
    WHERE {where} AND youth_parish IS NOT NULL AND data_measure = '{AWARENESS_MEASURE_ACTUAL}'
    GROUP BY district, parish
    """
    target_sql = f"""
    SELECT UPPER(youth_district) AS district, youth_parish AS parish, SUM(registration_target) AS target
    FROM {AWARENESS_SUMMARY}
    WHERE {where} AND youth_parish IS NOT NULL AND data_measure = '{AWARENESS_MEASURE_TARGET}'
    GROUP BY district, parish
    """
    target_by_key = {
        (r["district"], r["parish"]): r["target"]
        for r in database.run_query(target_sql, params, role=user.role)
    }
    rows = database.run_query(actual_sql, params, role=user.role)
    for r in rows:
        r["target"] = target_by_key.get((r["district"], r["parish"]))
    rows.sort(key=lambda r: (r["district"], r["parish"]))
    return {"parishes": rows}


@router.get("/api/recruitment/awareness-mobilisers")
def awareness_mobilisers(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
):
    """Per-mobiliser reach and eligible/eligible-female conversion, for the
    Awareness tab's Mobilisers sub-page. Names masked for the guest role.

    Distinct from /api/recruitment/mobilisers (the Recruitment>Mobilisers tab,
    still a placeholder) — this one is scoped to the awareness stage, where
    AWARENESS_SUMMARY's mobilizer_name is fully populated.
    """
    where, params = build_where(
        districts=district,
        extra=[active_cohort_clause("awm")], prefix="awm",
        district_col="youth_district",
    )
    sql = f"""
    SELECT
      mobilizer_name AS mobiliser_name,
      UPPER(youth_district) AS district,
      SUM(total_registered_youth) AS reached,
      SUM(total_eligible_youth) AS eligible,
      SUM(total_eligible_female) AS eligible_female,
      ROUND(SAFE_DIVIDE(SUM(total_eligible_female), NULLIF(SUM(total_eligible_youth), 0)) * 100, 1) AS pct_eligible_female
    FROM {AWARENESS_SUMMARY}
    WHERE {where} AND mobilizer_name IS NOT NULL AND data_measure = '{AWARENESS_MEASURE_ACTUAL}'
    GROUP BY mobiliser_name, district
    ORDER BY eligible DESC
    """
    rows = database.run_query(sql, params, role=user.role)
    for r in rows:
        r["mobiliser_name"] = mask_name(user.role, r.get("mobiliser_name"))
    return {"mobilisers": rows}


@router.get("/api/recruitment/awareness-kyc")
def awareness_kyc(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
):
    """Persona/demographic breakdown of the eligible pool, for the Awareness
    tab's KYC / Youth Profile sub-page. Backed by the live AWARENESS_KYC
    per-youth record (silver_eba.eba_bootcamp_awareness).
    """
    base_where, base_params = build_where(
        districts=district, gender=gender,
        extra=[active_cohort_clause("kyc")], prefix="kyc",
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
      COUNT(*) AS total_count
    FROM {AWARENESS_KYC}
    WHERE {elig_where}
    """
    demo = (database.run_query(demo_sql, base_params, role=user.role) or [{}])[0]

    activity_sql = f"""
    SELECT activity, COUNT(*) AS count
    FROM {AWARENESS_KYC}, UNNEST(JSON_EXTRACT_STRING_ARRAY(current_activty)) AS activity
    WHERE {elig_where}
    GROUP BY activity ORDER BY count DESC
    """
    activity = database.run_query(activity_sql, base_params, role=user.role)

    reasons_sql = f"""
    SELECT reason, COUNT(*) AS count
    FROM {AWARENESS_KYC}, UNNEST(JSON_EXTRACT_STRING_ARRAY(registration_reasons)) AS reason
    WHERE {elig_where}
    GROUP BY reason ORDER BY count DESC
    """
    reasons = database.run_query(reasons_sql, base_params, role=user.role)

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

    biz_reasons_sql = f"""
    SELECT owns_business, reason, COUNT(*) AS count
    FROM {AWARENESS_KYC}, UNNEST(JSON_EXTRACT_STRING_ARRAY(registration_reasons)) AS reason
    WHERE {elig_where}
    GROUP BY owns_business, reason
    QUALIFY ROW_NUMBER() OVER (PARTITION BY owns_business ORDER BY COUNT(*) DESC) <= 5
    ORDER BY owns_business DESC, count DESC
    """
    biz_reasons = database.run_query(biz_reasons_sql, base_params, role=user.role)

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
            "duplicate_count": demo.get("duplicate_count") or 0,
            "duplicate_rate": round(100 * (demo.get("duplicate_count") or 0) / demo["total_count"], 1) if demo.get("total_count") else None,
        },
        "activity": activity,
        "reasons": reasons,
        "business": {"by_gender_district": biz_rows, "reasons_by_ownership": biz_reasons},
        "channels": channels,
    }


@router.get("/api/recruitment/awareness-forecast")
def awareness_forecast(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
):
    """Daily registration trend vs target, with a simple pace-to-target
    projection, for the Awareness tab's Forecast sub-page."""
    where, params = build_where(
        districts=district,
        extra=[active_cohort_clause("awf")], prefix="awf",
        district_col="youth_district",
    )
    daily_sql = f"""
    SELECT report_date AS event_date, SUM(total_registered_youth) AS registered
    FROM {AWARENESS_SUMMARY}
    WHERE {where} AND report_date IS NOT NULL AND data_measure = '{AWARENESS_MEASURE_ACTUAL}'
    GROUP BY event_date ORDER BY event_date
    """
    daily = database.run_query(daily_sql, params, role=user.role)

    registered_sql = f"""
    SELECT SUM(total_registered_youth) AS registered
    FROM {AWARENESS_SUMMARY}
    WHERE {where} AND data_measure = '{AWARENESS_MEASURE_ACTUAL}'
    """
    target_sql = f"""
    SELECT SUM(registration_target) AS target
    FROM {AWARENESS_SUMMARY}
    WHERE {where} AND data_measure = '{AWARENESS_MEASURE_TARGET}'
    """
    registered = (database.run_query(registered_sql, params, role=user.role) or [{}])[0].get("registered") or 0
    target = (database.run_query(target_sql, params, role=user.role) or [{}])[0].get("target") or 0

    n_days = len(daily)
    avg_daily_rate = (registered / n_days) if n_days else None
    remaining = max(target - registered, 0)
    days_to_target = (
        round(remaining / avg_daily_rate) if avg_daily_rate else None
    )

    return {
        "daily": daily,
        "registered_to_date": registered,
        "target": target,
        "avg_daily_rate": round(avg_daily_rate, 1) if avg_daily_rate is not None else None,
        "days_to_target": days_to_target,
    }


@router.get("/api/recruitment/mobilisation")
def mobilisation(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),  # accepted but unused — see ACTIVE_COHORT
):
    """Assigned -> Reached -> Confirmed with reach & mobilisation rates.

    Backed by the live DAILY_ACQUISITION_SUMMARY mart, which mixes three row
    types under `measure` (see tables.py): assigned = preload_youth comes from
    the 'targets' rows (district-grain only — no gender breakdown exists for
    this figure); reached/confirmed come from the 'daily_aggregates' rows
    (the real per-day data, gender-filterable). This call-center "acquired"
    means confirmed-to-attend — distinct from the arrival-day "acquired" in
    SITE_FUNNEL_METRICS used by /acquisition below. `district` filters the
    calling agent's district (agent_district) — this table has no youth-side
    district.

    The pilot subcounties' "2.5-week cycle" youth are auto-confirmed by policy
    (AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT) rather than run through the same
    call-center process as the rest of the cohort's "4-week cycle" — blending
    them into one rate would hide the real call-center conversion, so the
    top-level fields (assigned/reached/confirmed/rates) are the blended
    "overall" view for backward compatibility, and `four_week`/`two_half_week`
    give the same shape split by which cycle each youth went through.
    Mobilisation rate is Confirmed/Assigned throughout (confirmed by the
    recruitment team — Assigned is "treatment-eligible-at-recruitment").
    """
    assigned_where, assigned_params = build_where(
        districts=district, extra=[active_cohort_clause("moa")], prefix="moa",
        district_col="agent_district",
    )
    preload_assigned = (database.run_query(
        f"SELECT SUM(preload_youth) AS assigned FROM {DAILY_ACQUISITION_SUMMARY} "
        f"WHERE {assigned_where} AND measure = '{DAILY_ACQ_MEASURE_TARGET}'",
        assigned_params, role=user.role) or [{}])[0].get("assigned") or 0

    actual_where, actual_params = build_where(
        districts=district, gender=gender, extra=[active_cohort_clause("mor")], prefix="mor",
        district_col="agent_district", gender_col="youth_gender",
    )
    actual = (database.run_query(
        f"SELECT SUM(total_youth_reached) AS reached, SUM(total_acquired_youth) AS confirmed "
        f"FROM {DAILY_ACQUISITION_SUMMARY} WHERE {actual_where} AND measure = '{DAILY_ACQ_MEASURE_ACTUAL}'",
        actual_params, role=user.role) or [{}])[0]
    four_week_reached   = actual.get("reached") or 0
    four_week_confirmed = actual.get("confirmed") or 0

    # Auto-confirmed pilot-subcounty youth never entered the preload list
    # either — they're both "assigned" and "confirmed" simultaneously, with
    # zero reach calls (they bypass the call center entirely).
    auto_confirmed = _auto_confirmed_count(district, gender, user.role)

    def _segment(assigned, reached, confirmed, reach_denominator=None):
        # "Reached" only exists as a concept for the 4-week cycle — the
        # 2.5-week cohort is auto-confirmed with zero call attempts, so it
        # must never inflate a reach-rate denominator (reach_denominator lets
        # `overall` use just the 4-week assigned count for that one rate).
        reach_denom = assigned if reach_denominator is None else reach_denominator
        return {
            "assigned": assigned,
            "reached": reached,
            "confirmed": confirmed,
            "reach_rate":        round(100 * reached / reach_denom, 1) if reach_denom else None,
            "mobilisation_rate": round(100 * confirmed / assigned, 1) if assigned else None,
        }

    four_week     = _segment(preload_assigned, four_week_reached, four_week_confirmed)
    two_half_week = _segment(auto_confirmed, 0, auto_confirmed)
    overall       = _segment(
        preload_assigned + auto_confirmed, four_week_reached, four_week_confirmed + auto_confirmed,
        reach_denominator=preload_assigned,
    )

    # Female share of confirmed and progress-vs-target are always computed on
    # the full (district/cohort-filtered) set regardless of the `gender` query
    # param — filtering to gender=FEMALE and then asking "what % is female"
    # would trivially always read 100%.
    gsplit_where, gsplit_params = build_where(
        districts=district, extra=[active_cohort_clause("mog")], prefix="mog",
        district_col="agent_district",
    )
    four_week_confirmed_female = (database.run_query(
        f"SELECT SUM(total_acquired_youth) AS n FROM {DAILY_ACQUISITION_SUMMARY} "
        f"WHERE {gsplit_where} AND measure = '{DAILY_ACQ_MEASURE_ACTUAL}' AND UPPER(youth_gender) = 'FEMALE'",
        gsplit_params, role=user.role) or [{}])[0].get("n") or 0
    confirmed_female = four_week_confirmed_female + _auto_confirmed_count(district, "FEMALE", user.role)

    target_where, target_params = build_where(
        districts=district, extra=[active_cohort_clause("mot")], prefix="mot",
        district_col="agent_district",
    )
    target = (database.run_query(
        f"SELECT SUM(mobilisation_target) AS t FROM {DAILY_ACQUISITION_SUMMARY} "
        f"WHERE {target_where} AND measure = '{DAILY_ACQ_MEASURE_TARGET}'",
        target_params, role=user.role) or [{}])[0].get("t") or 0

    total_confirmed = overall["confirmed"]
    return {
        **overall,
        "confirmed_female": confirmed_female,
        "confirmed_female_pct": round(100 * confirmed_female / total_confirmed, 1) if total_confirmed else None,
        "target": target,
        "progress_pct": round(100 * total_confirmed / target, 1) if target else None,
        "four_week": four_week,
        "two_half_week": two_half_week,
    }


@router.get("/api/recruitment/mobilisation-heatmap")
def mobilisation_heatmap(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
):
    """Day × venue matrix of unique youth reached and confirmed, for the
    Mobilisation tab's heatmap. Backed by DAILY_ACQUISITION_SUMMARY's real
    'daily_aggregates' rows (call_date and venue_name are both populated
    there — see tables.py)."""
    where, params = build_where(
        districts=district, extra=[active_cohort_clause("mh")], prefix="mh",
        district_col="agent_district",
    )
    sql = f"""
    SELECT call_date AS event_date, venue_name AS venue,
           SUM(total_youth_reached) AS reached, SUM(total_acquired_youth) AS confirmed
    FROM {DAILY_ACQUISITION_SUMMARY}
    WHERE {where} AND measure = '{DAILY_ACQ_MEASURE_ACTUAL}'
      AND call_date IS NOT NULL AND venue_name IS NOT NULL
    GROUP BY event_date, venue
    ORDER BY event_date, venue
    """
    return {"cells": database.run_query(sql, params, role=user.role)}


@router.get("/api/recruitment/mobilisation-forecast")
def mobilisation_forecast(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
):
    """Daily reached/confirmed trend vs the mobilisation target, with a simple
    pace-to-target projection — same shape as /api/recruitment/awareness-forecast."""
    where, params = build_where(
        districts=district, extra=[active_cohort_clause("mf")], prefix="mf",
        district_col="agent_district",
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
        districts=district, extra=[active_cohort_clause("mft")], prefix="mft",
        district_col="agent_district",
    )
    target = (database.run_query(
        f"SELECT SUM(mobilisation_target) AS t FROM {DAILY_ACQUISITION_SUMMARY} "
        f"WHERE {target_where} AND measure = '{DAILY_ACQ_MEASURE_TARGET}'",
        target_params, role=user.role) or [{}])[0].get("t") or 0

    confirmed_to_date = sum(d.get("confirmed") or 0 for d in daily) + _auto_confirmed_count(district, None, user.role)
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
def control_calls(user: User = Depends(current_user)):
    """The randomised control/comparison arm — eligible youth tracked (status
    and reachability only, no mobilisation pitch) but not actively mobilised,
    so the effect of mobilisation can be measured against a real counterfactual.

    Backed by the live CONTROL_CALLS_BC4 table (single-cycle — no bootcamp_cycle
    column, no district/gender filter param since the whole table already is
    the BC4 control arm). decision/interest fields are empty by design here —
    control calls only confirm status and reachability, no mobilisation pitch.
    """
    totals_sql = f"""
    SELECT COUNT(*) AS total,
           COUNTIF(is_control = TRUE) AS control,
           COUNTIF(is_control IS NOT TRUE) AS mobilization,
           COUNTIF(UPPER(status) = 'REACHED') AS reached,
           COUNTIF(UPPER(gender) = 'FEMALE') AS female,
           COUNTIF(UPPER(gender) = 'MALE') AS male,
           AVG(age) AS avg_age
    FROM {CONTROL_CALLS_BC4}
    """
    totals = (database.run_query(totals_sql, role=user.role) or [{}])[0]

    district_sql = f"""
    SELECT UPPER(district) AS district, COUNT(*) AS n
    FROM {CONTROL_CALLS_BC4} WHERE district IS NOT NULL
    GROUP BY district ORDER BY n DESC
    """
    by_district = database.run_query(district_sql, role=user.role)

    status_sql = f"""
    SELECT status, COUNT(*) AS n FROM {CONTROL_CALLS_BC4}
    WHERE status IS NOT NULL GROUP BY status ORDER BY n DESC
    """
    by_status = database.run_query(status_sql, role=user.role)

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


@router.get("/api/recruitment/call-centre-insights")
def call_centre_insights(user: User = Depends(current_user)):
    """Barriers youth raise on mobilisation/acquisition calls, for the
    Mobilisation tab's Call Centre Insights sub-page. Backed by the live
    ACQUISITION_CALL_LOG's `barriers` field — a comma-separated free-text
    column (not JSON), split into individual barriers since a call can raise
    more than one. Not tagged by district/gender in the source, so no filters.
    "Questions youth ask" (in the reference design) has no structured source
    in the live data — omitted rather than inventing sample question text.
    """
    sql = f"""
    SELECT TRIM(barrier) AS barrier, COUNT(*) AS count
    FROM {ACQUISITION_CALL_LOG}, UNNEST(SPLIT(barriers, ',')) AS barrier
    WHERE bootcamp_cycle = @cycle AND barriers IS NOT NULL AND barriers != '' AND TRIM(barrier) != ''
    GROUP BY barrier ORDER BY count DESC
    """
    rows = database.run_query(sql, [_scalar("cycle", "STRING", ACTIVE_COHORT)], role=user.role)
    total = sum(r["count"] for r in rows)
    for r in rows:
        r["pct"] = round(100 * r["count"] / total, 1) if total else None
    return {"barriers": rows}


@router.get("/api/recruitment/acquisition")
def acquisition(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    gender:   Optional[str] = Query(None),
    cohort:   List[str] = Query(default=[]),  # accepted but unused — see ACTIVE_COHORT
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
        extra=[active_cohort_clause("ac")], prefix="ac",
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
    return {"by_district": database.run_query(sql, params, role=user.role)}


@router.get("/api/recruitment/acquisition-arrival")
def acquisition_arrival(
    user: User = Depends(current_user),
    district: List[str] = Query(default=[]),
    cohort:   List[str] = Query(default=[]),  # accepted but unused — see ACTIVE_COHORT
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
        districts=district, extra=[active_cohort_clause("aa")], prefix="aa",
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
    limit:    int = Query(200, ge=1, le=1000),
):
    """Youth profile / KYC rows. Names masked for guests; raw id never serialised.

    Backed by the live AWARENESS_KYC per-youth record.
    """
    where, params = build_where(
        districts=district, gender=gender,
        extra=[active_cohort_clause("pe")], prefix="pe",
        district_col="youth_district", gender_col="youth_gender",
    )
    sql = f"""
    SELECT youth_phone, youth_name, youth_gender AS gender, youth_age AS age,
           UPPER(youth_district) AS district, youth_parish AS parish,
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
