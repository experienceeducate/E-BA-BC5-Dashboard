"""
Table-reference constants — the ONE place BigQuery table names live.

⚠️ SCAFFOLD STATE: the BC5 data feed is not live yet. These are the *intended*
fully-qualified names under the `gold_eba` (marts) and `silver_eba` (cleaned
row-level) datasets, derived from the shapes in the prototype
(`reference/prototype-index.html`). Every constant below is marked
`# TODO: confirm real table name when feed lands`. Routers query them via
`database.run_query(...)`; until the tables exist, `/api/*` data endpoints will
return a BigQuery 404 — that is expected (see docs/CONTEXT.md).

Naming discipline: the *product* is "E!BA Dashboard" (E!BA Recruitment) in the UI, and
the data layer keeps the same neutral `eba_` prefix. Do not rename tables to match UI copy.
"""

from app.core.database import PROJECT_ID, DATASET, TABLE, _scalar

# Primary summary table (BQ_TABLE default = eba_recruitment_funnel).
FULL_TABLE = f"`{PROJECT_ID}`.{DATASET}.{TABLE}"

_GOLD   = f"`{PROJECT_ID}`.gold_eba"
_SILVER = f"`{PROJECT_ID}`.silver_eba"

# ─── Live tables (confirmed against real BigQuery schemas) ─────────────────────
# Cohort values in these tables are "BOOTCAMP_2".."BOOTCAMP_4" / "MINI_BOOTCAMP_3",
# not "BC2".."BC5". The BC5 cycle isn't in the data yet, so every live-table query
# below is pinned to the current active cycle rather than exposing the frontend's
# BC2..BC5 cohort filter (which doesn't apply to these tables). To move onto BC5
# once it lands, flip this one constant — nothing else needs to change.
ACTIVE_COHORT = "BOOTCAMP_4"

# Awareness: district-level daily rollup — registered/interested/eligible counts
# (+ female/male splits) per mobiliser/day/district. Backs /api/recruitment/awareness.
#
# ⚠️ This table mixes TWO row types in one `data_measure` column, and both
# carry the SAME actual registered/interested/eligible totals (confirmed by
# direct query — summing across both types silently double-counts):
#   - 'daily_awareness': per mobiliser/day/parish actuals. Has report_date;
#     this is the only type with a real daily series.
#   - 'parish_targets':  per-parish rows carrying registration_target (the
#     only type with a non-null target) alongside a mirrored copy of the same
#     actuals. Has NO report_date.
# Always filter to ONE of these two constants — never sum the table unfiltered.
AWARENESS_MEASURE_ACTUAL = "daily_awareness"
AWARENESS_MEASURE_TARGET = "parish_targets"
AWARENESS_SUMMARY = f"{_GOLD}.eba_bootcamp_daily_awareness_summary_cleaned"

# Mobilisation: daily call-center rollup — preload/called/reached/acquired counts
# per agent/venue/day. Backs /api/recruitment/mobilisation.
#
# ⚠️ Same class of bug as AWARENESS_SUMMARY, but worse: THREE row types under
# `measure`, confirmed by direct query:
#   - 'daily_aggregates': the real per-day/gender/district/venue rows. Has
#     reached/acquired but preload_youth is NULL throughout — this table has
#     NO gender/venue/date breakdown of "assigned".
#   - 'targets' and 'venue_targets': row-for-row EXACT DUPLICATES of each
#     other (same district, same preload/reached/target values) — summing
#     both double-counts. No gender/venue/date dimension on these rows either.
# Always filter to ONE of these — 'daily_aggregates' for reached/acquired,
# 'targets' (never 'venue_targets', which would double it again) for
# preload_youth/mobilisation_target.
DAILY_ACQ_MEASURE_ACTUAL = "daily_aggregates"
DAILY_ACQ_MEASURE_TARGET = "targets"
DAILY_ACQUISITION_SUMMARY = f"{_GOLD}.eba_bootcamp_daily_acquisition_summary"

# Some subcounties run a shorter pilot ("2.5 Recruitment Cycle") instead of the
# standard "4-Week Recruitment Cycle" the rest of the cohort follows. Any
# eligible + treatment-assigned youth from these subcounties is auto-confirmed
# at the mobilisation stage — they never go through daily_acquisition_summary's
# call-center reach/confirm process at all, so they must be added on top of
# that table's "confirmed" count, not looked up inside it. Per-cohort because
# the recruitment team confirmed BC5 will have an equivalent pilot area with
# different subcounties — update this dict (don't just overwrite BOOTCAMP_4's
# list) once that guidance lands.
AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT = {
    "BOOTCAMP_4": ["IGOMBE", "NANKOMA"],
}

# Site-level funnel: venue×gender×cycle grain — arrival verification (verified/
# acquired) AND retention (activated_youth, youth_80pct_lessons, ...). Backs
# /api/recruitment/acquisition and /api/implementation/retention.
#
# ⚠️ Same class of bug as AWARENESS_SUMMARY / DAILY_ACQUISITION_SUMMARY: TWO
# row types under `measure`, confirmed by direct query:
#   - 'site_targets': per-venue rows with NO gender dimension. Carries
#     total_verified_youth/pct_verified alongside mobilisation_target/
#     acquisition_target/total_interested_youth. This is the ONLY row type
#     with total_verified_youth — there is no per-gender verified figure.
#   - 'site_metrics': per-venue PER-GENDER rows. Carries acquired_youth,
#     activated_youth, youth_80pct_lessons, retention_rate* — and a separate
#     all_verified_count/waiver_count pair that is close to but NOT identical
#     to total_verified_youth (different source/timing) — never blend the two.
# Every field happens to be NULL on the "wrong" row type today, so plain
# unfiltered SUM()s don't currently double-count — but filter to the right
# measure explicitly rather than depending on that.
SITE_FUNNEL_MEASURE_TARGET = "site_targets"
SITE_FUNNEL_MEASURE_ACTUAL = "site_metrics"
SITE_FUNNEL_METRICS = f"{_GOLD}.eba_bootcamp_site_level_funnel_metrics"

# Attendance: daily present/absent/churn per venue. Backs
# /api/implementation/attendance (daily series only — no per-lesson table exists
# yet, so the "lessons" part of that response stays empty until one is confirmed).
ATTENDANCE_SUMMARY = f"{_GOLD}.eba_bootcamp_attendance_summary"

# Trainer quality: raw per-lesson observation form export (ODK-style — every
# column is STRING, one row per classroom observation). Has no bootcamp_cycle
# column and mixes two scoring vintages (an older class_score/_category scheme
# and the current v2 tool's 0-4 overall_average_class_observation_score) in the
# same table, so rows are scoped to the current cohort by report_type + a
# submission-date window instead (per the recruitment team's reference query,
# trainer_quality_summary_sql.sql). Update the window alongside ACTIVE_COHORT
# when BC5 lands. Backs /api/implementation/trainers.
TRAINER_OBSERVATIONS         = f"{_SILVER}.raw_eba_2025_monitoring_tool_v2_ug"
ACTIVE_COHORT_START_DATE     = "2026-05-06"
ACTIVE_COHORT_END_DATE       = "2026-05-30"

# Retention calls (absent-youth follow-up) — no dedicated mart exists yet;
# Afra is planning a silver model for this later. Until then, built directly
# from the two raw silver sources this joins (see Retention_calls_sql.sql at
# the repo root, the recruitment team's reference query). Kept as a single
# subquery function specifically so the swap is a one-line change later: once
# a real table lands, replace this function's body with `f"SELECT * FROM
# {{NEW_TABLE}}"` — the endpoint's outer aggregation query doesn't change.
RETENTION_ATTENDANCE_RAW = f"{_SILVER}.eba_bootcamp_attendance"
RETENTION_FOLLOWUP_RAW   = f"{_SILVER}.eba_2025_youth_absent_flow_up_script"
RETENTION_TRACKING_START_DATE = "2026-05-04"


def retention_calls_detail_sql():
    """One row per (youth, absence date): follow-up call outcome that day, and
    whether they ever returned. Mirrors Retention_calls_sql.sql's logic minus
    the columns /api/implementation/retention-calls doesn't currently
    aggregate (PII youth_name, next-day-specific vs. eventual-return detail,
    reason text) — add columns back here if a future endpoint needs them."""
    return f"""
    WITH attendance_base AS (
      SELECT TRIM(UPPER(youth_id)) AS youth_id, youth_gender,
             UPPER(youth_district) AS youth_district, venue_name, report_date, status
      FROM {RETENTION_ATTENDANCE_RAW}
      WHERE report_date >= DATE('{RETENTION_TRACKING_START_DATE}') AND youth_status = 'ACTIVE'
    ),
    absent_events AS (
      SELECT DISTINCT youth_id, youth_gender, youth_district, venue_name, report_date AS absent_date
      FROM attendance_base
      WHERE UPPER(TRIM(status)) != 'PRESENT'
        AND CONCAT(youth_id, '_', CAST(report_date AS STRING)) NOT IN (
          SELECT CONCAT(TRIM(UPPER(youth_id)), '_', CAST(report_date AS STRING))
          FROM {RETENTION_ATTENDANCE_RAW}
          WHERE UPPER(TRIM(status)) = 'PRESENT'
        )
    ),
    followup_calls AS (
      SELECT TRIM(UPPER(youth_id)) AS youth_id, DATE(submission_date) AS followup_date,
        CASE WHEN LOWER(TRIM(will_return)) = 'yes' THEN 'Yes'
             WHEN LOWER(TRIM(will_return)) = 'no' THEN 'No'
             ELSE 'Unknown' END AS will_return_clean
      FROM {RETENTION_FOLLOWUP_RAW}
      WHERE DATE(submission_date) >= DATE('{RETENTION_TRACKING_START_DATE}')
    ),
    absence_with_followup AS (
      SELECT a.youth_id, a.youth_gender, a.youth_district, a.venue_name, a.absent_date,
        COUNT(f.followup_date) AS calls_made_today,
        COUNTIF(f.will_return_clean IN ('Yes', 'No')) AS calls_reached_today,
        COUNTIF(f.will_return_clean = 'Yes') AS promised_return_today
      FROM absent_events a
      LEFT JOIN followup_calls f ON a.youth_id = f.youth_id AND f.followup_date = a.absent_date
      GROUP BY 1, 2, 3, 4, 5
    ),
    eventual_return AS (
      SELECT a.youth_id, a.absent_date, MIN(att.report_date) AS first_return_date
      FROM absent_events a
      JOIN attendance_base att
        ON a.youth_id = att.youth_id
       AND UPPER(TRIM(att.status)) = 'PRESENT'
       AND att.report_date > a.absent_date
      GROUP BY 1, 2
    )
    SELECT
      f.absent_date AS event_date, f.youth_gender, f.youth_district, f.venue_name,
      f.calls_made_today, f.calls_reached_today, f.promised_return_today,
      CASE WHEN e.first_return_date IS NOT NULL THEN 1 ELSE 0 END AS returned
    FROM absence_with_followup f
    LEFT JOIN eventual_return e ON f.youth_id = e.youth_id AND f.absent_date = e.absent_date
    """

# Per-youth KYC/registration record (age, education, income, eligibility flag,
# names/phone/location). Backs /api/overview/eligibility-barriers — each of the
# five documented eligibility criteria (docs/metrics.yaml: age 18-30, education
# P5-S3, income <= UGX 30,000/2wk, training_interest, participated_educate_training)
# is counted independently among elligible=FALSE rows, since a youth can fail
# more than one. Note the source column is spelled "elligible" (sic).
AWARENESS_KYC = f"{_SILVER}.eba_bootcamp_awareness"

# Note: current_activty / registration_reasons are JSON-array-as-string columns
# (e.g. '["Staying home"]') — query with JSON_EXTRACT_STRING_ARRAY(...), not as
# plain strings.

# Randomised control/comparison arm — eligible youth tracked (status +
# reachability only, no mobilisation pitch) but not actively mobilised, so the
# team can measure what the mobilisation treatment actually adds. Confirmed
# real: every summary figure here (1,898 total, 835 is_control, 1,831 reached,
# gender/district split) matches the recruitment team's own reference numbers
# exactly. Named per-cycle (no bootcamp_cycle column — it's a single-cycle
# table) — BC5 will land as a differently-named table; add it as a new
# constant rather than overwriting this one when that happens.
CONTROL_CALLS_BC4 = f"{_SILVER}.eba_bc4_control_calls"

# Per-call telemarketer log (mobilisation + acquisition calls) — `barriers` is
# a comma-separated free-text field (not JSON), well-populated (~51% of BC4
# rows), backing Call Centre Insights' barriers chart. `agent_name` present
# throughout.
ACQUISITION_CALL_LOG = f"{_SILVER}.eba_bootcamp_acquisition"


def active_cohort_clause(prefix: str):
    """(clause, params) pinning bootcamp_cycle to ACTIVE_COHORT for a live-table
    query. Splice into build_where(extra=[...]). See the ACTIVE_COHORT comment."""
    return f"bootcamp_cycle = @{prefix}_cycle", [_scalar(f"{prefix}_cycle", "STRING", ACTIVE_COHORT)]

# ─── gold_eba — aggregated marts (scaffold — BC5 feed not live yet) ────────────
RECRUITMENT_FUNNEL   = f"{_GOLD}.eba_recruitment_funnel"      # TODO: confirm — district×gender×stage×cohort counts
TAM_PARISH           = f"{_GOLD}.eba_tam_parish"              # TODO: confirm — parish predicted/actual/validation_rate
TAM_COVERAGE         = f"{_GOLD}.eba_tam_coverage"            # TODO: confirm — parishes covered/total per district
# MOBILISER_PERF: no live table has both a named mobiliser AND reach/confirm
# counts — DAILY_ACQUISITION_SUMMARY has reach/confirm but mobilizer_name is
# 100% NULL there; AWARENESS_SUMMARY has mobilizer_name but no reach/confirm.
# Left as a placeholder until a suitable table is identified.
MOBILISER_PERF       = f"{_GOLD}.eba_mobiliser_performance"   # TODO: confirm — per-mobiliser reached/confirmed
CHANNEL_PERF         = f"{_GOLD}.eba_channel_performance"     # TODO: confirm — online vs offline channel funnel
ATTENDANCE_DAILY     = f"{_GOLD}.eba_attendance_daily"        # TODO: confirm — daily present/churn per venue
ATTENDANCE_LESSON    = f"{_GOLD}.eba_attendance_lesson"       # TODO: confirm — per-lesson attendance %
RETENTION_VENUE      = f"{_GOLD}.eba_retention_venue"         # TODO: confirm — acquired/activated/retained per venue
TRAINER_QUALITY      = f"{_GOLD}.eba_trainer_quality"         # TODO: confirm — trainer observation scores
MILESTONES           = f"{_GOLD}.eba_milestones"             # TODO: confirm — weekly pitch milestone completion
YOUTH_NPS            = f"{_GOLD}.eba_youth_experience_nps"    # TODO: confirm — programme/venue/meals NPS by week
MEALS                = f"{_GOLD}.eba_meals"                   # TODO: confirm — meals served & quality per venue
VENUE_COMPLIANCE     = f"{_GOLD}.eba_venue_compliance"        # TODO: confirm — venue compliance reports
TRANSPORT            = f"{_GOLD}.eba_transport_timeliness"    # TODO: confirm — per-site transport timeliness

# ─── silver_eba — cleaned row-level (PII-bearing) ───────────────────────────────
YOUTHS = f"{_SILVER}.eba_youths"  # TODO: confirm — youth-level: name, gender, age, district, parish, village,
                                  #                 mobiliser, education, income, channel, has_phone, phone_number
MOBILISERS = f"{_SILVER}.eba_mobilisers"  # TODO: confirm — mobiliser roster (named)
TRAINERS   = f"{_SILVER}.eba_trainers"    # TODO: confirm — trainer roster (named)

# ─── Domain constants ───────────────────────────────────────────────────────────
# Canonical recruitment funnel order (from the prototype's Executive Summary).
FUNNEL_STAGES = [
    "Registered", "Interested", "Eligible", "Assigned",
    "Reached", "Confirmed", "Verified", "Acquired", "Activated", "Retained",
]
COHORTS = ["BC2", "BC3", "BC4", "BC5"]

# BC5 campaign start; Week 1 starts here. Used to bucket dates into week numbers.
# TODO: confirm the real BC5 program start date with the recruitment team.
PROGRAM_START_DATE = "2026-07-06"

# Universal filter: exclude test/QA rows from every reported query. NULL is treated
# as "not test data" so genuine rows with an unset flag are not dropped.
NOT_TEST_DATA = "COALESCE(is_test_data, FALSE) = FALSE"
