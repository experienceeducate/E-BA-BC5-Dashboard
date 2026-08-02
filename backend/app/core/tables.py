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

from app.core.database import PROJECT_ID, DATASET, TABLE, _array, _scalar

# Primary summary table (BQ_TABLE default = eba_recruitment_funnel).
FULL_TABLE = f"`{PROJECT_ID}`.{DATASET}.{TABLE}"

_GOLD   = f"`{PROJECT_ID}`.gold_eba"
_SILVER = f"`{PROJECT_ID}`.silver_eba"

# ─── Live tables (confirmed against real BigQuery schemas) ─────────────────────
# Cohort values in these tables are "BOOTCAMP_2".."BOOTCAMP_5" / "MINI_BOOTCAMP_3",
# not "BC2".."BC5". Every live-table query below is pinned to this list of active
# cycles rather than exposing the frontend's BC2..BC5 cohort filter (which doesn't
# apply to these tables). Add/remove a cycle here — nothing else needs to change.
ACTIVE_COHORTS = ["BOOTCAMP_4", "BOOTCAMP_5"]

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

# Per-venue mobilisation targets — DAILY_ACQUISITION_SUMMARY's 'venue_targets'
# measure was confirmed above to be an exact duplicate of the district-grain
# 'targets' rows, not real per-venue values, so there's no live BigQuery
# source for this yet. Hardcoded from the recruitment team's BOOTCAMP_5
# Control List pending a real upstream fix — keyed by venue_name, matched
# case/whitespace-insensitively in mobilisation_heatmap() since live
# venue_name casing varies. Mobilisation-stage targets ONLY — do not use for
# Awareness (see AWARENESS_ELIGIBLE_TARGET_BC5 below for that stage's
# targets; the two tables are for different funnel stages and must not be
# cross-wired, even though some venue names appear in both).
# "Busenda Primary School" appeared twice in that list (targets 39 and 17);
# summed here (56) pending confirmation of whether that's two distinct venues.
VENUE_MOBILISATION_TARGET = {
    "Kinawambuzi Primary School": 50,
    "Family Church Of God": 55,
    "Walukuba Primary School": 24,
    "Nakazigo Primary School": 64,
    "Bugadde Primary School": 22,
    "Busenda Primary School": 56,
    "Busaala Primary School": 44,
    "Kaluuba Primary School": 50,
    "Bwondha Secondary School": 29,
    "Bwondha Primary School": 39,
    "Busimo Primary School": 42,
    "Lutale 'A' Primary School": 84,
    "Mitimito St. Philip'S Primary School": 47,
    "Ndaiga Nasur Islamic Primary School": 44,
    "Wandgeya Primary School": 42,
    "Bukatabira Primary School": 59,
    "Buluta Parents Primary School": 59,
    "Golden Junior Primary School": 64,
    "St. Jude Nango Primary School": 89,
    "Namungalwe Primary School": 74,
    "Seven Stars Junior School": 66,
    "Prayer Centre Baptist Church": 35,
    "Buseyi Primary School": 67,
    "Nabirye Primary School": 49,
    "Bugabwe Primary School": 134,
    "Abu Hurairah Islamic Nus & Primary School": 59,
}


def venue_mobilisation_target(venue_name: str):
    """Case/whitespace-insensitive lookup into VENUE_MOBILISATION_TARGET —
    live venue_name values aren't guaranteed to match this hardcoded list's
    casing exactly. Returns None (not 0) for an unmatched venue, so callers
    can tell "no target on file" apart from "target is genuinely zero"."""
    if not venue_name:
        return None
    key = " ".join(venue_name.split()).casefold()
    for name, target in VENUE_MOBILISATION_TARGET.items():
        if " ".join(name.split()).casefold() == key:
            return target
    return None


# "New Recruits - Awareness Eligible Target" — district/parish/venue planning
# quota for BC5, hardcoded from the recruitment team's target sheet (not a
# live BigQuery column). Distinct from VENUE_MOBILISATION_TARGET: this is an
# earlier-funnel target (eligible youth, at Awareness) keyed to a *planned*
# venue, whereas the eligible-youth record itself (AWARENESS_KYC) carries no
# venue at all — venue assignment only happens once someone reaches
# Mobilisation. So the venue level of this target can't be checked against a
# live per-venue actual; only district/parish grain has a real actual to
# compare against (see awareness_eligible_target() in recruitment.py).
# "Busenda Primary School" appears twice below with two different parishes —
# kept as two separate rows (same venue can draw recruits from more than one
# parish), unlike VENUE_MOBILISATION_TARGET's same-name duplicate, which was
# summed because there it was ambiguous whether that was one venue or two.
AWARENESS_ELIGIBLE_TARGET_BC5 = [
    {"district": "MAYUGE", "parish": "BUYUGU", "venue": "Kinawambuzi Primary School", "target": 29},
    {"district": "MAYUGE", "parish": "MAIRINYA", "venue": "Family Church Of God", "target": 31},
    {"district": "MAYUGE", "parish": "BUGONDO", "venue": "Walukuba Primary School", "target": 49},
    {"district": "MAYUGE", "parish": "KIGANDALO", "venue": "Nakazigo Primary School", "target": 88},
    {"district": "MAYUGE", "parish": "BUGADE WARD", "venue": "Bugadde Primary School", "target": 50},
    {"district": "MAYUGE", "parish": "KITYERERA WARD", "venue": "Busenda Primary School", "target": 31},
    {"district": "MAYUGE", "parish": "NAKIBENGO WARD", "venue": "Busenda Primary School", "target": 0},
    {"district": "MAYUGE", "parish": "BUKUNJA", "venue": "Busaala Primary School", "target": 34},
    {"district": "MAYUGE", "parish": "KALUUBA", "venue": "Kaluuba Primary School", "target": 29},
    {"district": "MAYUGE", "parish": "BWONDHA CENTRAL WARD", "venue": "Bwondha Secondary School", "target": 45},
    {"district": "MAYUGE", "parish": "NALUBABWE WARD", "venue": "Bwondha Primary School", "target": 38},
    {"district": "MAYUGE", "parish": "BUBINGE", "venue": "Busimo Primary School", "target": 35},
    {"district": "MAYUGE", "parish": "BUKALENZI", "venue": "Lutale 'A' Primary School", "target": 73},
    {"district": "MAYUGE", "parish": "KITOVU", "venue": "Mitimito St. Philip'S Primary School", "target": 31},
    {"district": "MAYUGE", "parish": "NDAIGA", "venue": "Ndaiga Nasur Islamic Primary School", "target": 34},
    {"district": "MAYUGE", "parish": "WANDEGEYA", "venue": "Wandgeya Primary School", "target": 35},
    {"district": "MAYUGE", "parish": "BUKATABIRA", "venue": "Bukatabira Primary School", "target": 29},
    {"district": "MAYUGE", "parish": "BULUTA", "venue": "Buluta Parents Primary School", "target": 29},
    {"district": "MAYUGE", "parish": "BUMWENA", "venue": "Golden Junior Primary School", "target": 88},
    {"district": "MAYUGE", "parish": "MALONGO", "venue": "St. Jude Nango Primary School", "target": 69},
    {"district": "IGANGA", "parish": "NAMUNGALWE WARD", "venue": "Namungalwe Primary School", "target": 80},
    {"district": "IGANGA", "parish": "BUKAYE", "venue": "Seven Stars Junior School", "target": 86},
    {"district": "IGANGA", "parish": "BUKOONA", "venue": "Prayer Centre Baptist Church", "target": 40},
    {"district": "IGANGA", "parish": "BUSEYI", "venue": "Buseyi Primary School", "target": 85},
    {"district": "IGANGA", "parish": "NAKALAMA", "venue": "Nabirye Primary School", "target": 99},
    {"district": "IGANGA", "parish": "BULUBANDI", "venue": "Bugabwe Primary School", "target": 100},
    {"district": "IGANGA", "parish": "MAGOGO", "venue": "Abu Hurairah Islamic Nus & Primary School", "target": 91},
]

# Some subcounties run a shorter pilot ("2.5 Recruitment Cycle") instead of the
# standard "4-Week Recruitment Cycle" the rest of the cohort follows. Any
# eligible + treatment-assigned youth from these subcounties is auto-confirmed
# at the mobilisation stage — they never go through daily_acquisition_summary's
# call-center reach/confirm process at all, so they must be added on top of
# that table's "confirmed" count, not looked up inside it. Per-cohort because
# each cycle's pilot area has different subcounties — update this dict (don't
# just overwrite an existing cycle's list) if a new one is confirmed.
AUTO_CONFIRM_SUBCOUNTIES_BY_COHORT = {
    "BOOTCAMP_4": ["IGOMBE", "NANKOMA"],
}

# BOOTCAMP_5's 2.5-week pilot isn't subcounty-scoped like BC4's — per Afra
# (2026-07-25), any youth registered on/after this date counts as the
# short-cycle pilot instead. TEMPORARY: a source-table flag distinguishing the
# 2.5-week cohort is being added upstream — once that lands and Afra notifies,
# replace this date cutoff with a filter on that flag instead.
AUTO_CONFIRM_REGISTERED_SINCE_BY_COHORT = {
    "BOOTCAMP_5": "2026-07-27",
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
# trainer_quality_summary_sql.sql). Backs /api/implementation/trainers.
#
# BC5 observations span two distinct phases (per instruction, 2026-07-30):
# TOT ("Training of Trainers" — trainers being certified, before they teach
# youth) and the BOOTCAMP_5 delivery window itself (trainers observed while
# actually teaching). These are contiguous but conceptually different
# populations — a trainer's TOT score isn't the same signal as their in-
# classroom BOOTCAMP_5 score — so the endpoint reports both the full-window
# register and a per-phase breakdown. Update these four dates alongside
# ACTIVE_COHORTS once BC6 trainer-quality data lands.
TRAINER_OBSERVATIONS         = f"{_SILVER}.raw_eba_2025_monitoring_tool_v2_ug"
TRAINER_TOT_START_DATE       = "2026-07-29"
TRAINER_TOT_END_DATE         = "2026-08-16"
TRAINER_BOOTCAMP_START_DATE  = "2026-08-17"
TRAINER_BOOTCAMP_END_DATE    = "2026-09-11"

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

# Note: current_activty / registration_reasons / decision_consultation /
# open_questions / bc5_support_required are JSON-array-as-string columns
# (e.g. '["Staying home"]') — query with JSON_EXTRACT_STRING_ARRAY(...), not
# as plain strings. bc5_parental_relationship, by contrast, reads as a plain
# single-answer categorical column — see the assumption noted at its query
# in recruitment.py.

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


def resolve_active_cohorts(requested: list = None) -> list:
    """The cycles a live-table query should scope to: `requested` (the
    frontend's cohort filter selection) when given and non-empty, else the
    default ACTIVE_COHORTS set.

    `requested` is trusted as-is rather than intersected against
    ACTIVE_COHORTS — the filter dropdown's cohort options now come from a
    live `SELECT DISTINCT bootcamp_cycle` (see /api/filters), which can
    include cohorts outside ACTIVE_COHORTS (e.g. BOOTCAMP_2/3), so filtering
    a real user selection down to just the BC4/5 default would silently
    ignore it. Values are always passed as a BigQuery query parameter
    (never string-interpolated), so there's no injection risk in trusting
    an unrecognized string here — it just matches zero rows."""
    cleaned = [c for c in (requested or []) if c]
    return cleaned or ACTIVE_COHORTS


def active_cohort_clause(prefix: str, requested: list = None):
    """(clause, params) restricting bootcamp_cycle to resolve_active_cohorts(requested)
    for a live-table query. Splice into build_where(extra=[...]). See the
    ACTIVE_COHORTS comment."""
    return (
        f"bootcamp_cycle IN UNNEST(@{prefix}_cycle)",
        [_array(f"{prefix}_cycle", "STRING", resolve_active_cohorts(requested))],
    )

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
