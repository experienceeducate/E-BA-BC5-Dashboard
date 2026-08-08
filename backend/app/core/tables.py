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
_BRONZE = f"`{PROJECT_ID}`.bronze_eba"

# ─── Live tables (confirmed against real BigQuery schemas) ─────────────────────
# Cohort values in these tables are "BOOTCAMP_2".."BOOTCAMP_5" / "MINI_BOOTCAMP_3",
# not "BC2".."BC5". Every live-table query below is pinned to this list of active
# cycles rather than exposing the frontend's BC2..BC5 cohort filter (which doesn't
# apply to these tables). Add/remove a cycle here — nothing else needs to change.
#
# BOOTCAMP_4 dropped, 2026-08-08 (per Afra): confirmed live — BC4's last
# DAILY_ACQUISITION_SUMMARY activity is call_date 2026-07-24, BC5's first is
# 2026-07-27, a clean non-overlapping cutover, and BC4 is fully closed out.
# Blending a closed cohort into the unfiltered/"all cohorts" default was
# actively producing wrong numbers, not just stale ones: BC4's preload_youth
# (Assigned) and youth_gender are BOTH 100% NULL on every one of its rows, so
# any combined view showed Assigned undercounted against Reached/Confirmed
# (reach_rate >100%, reproduced live) and a diluted/wrong female share.
# BC4 is still explicitly selectable from the cohort dropdown (its rows are
# real and its own single-cohort numbers are fine) — this only removes it
# from the silent default blend. Reinstate here (and re-verify the same two
# NULL columns aren't still an issue) if BC4 numbers are ever needed in a
# combined view again.
ACTIVE_COHORTS = ["BOOTCAMP_5"]

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
# `measure`:
#   - 'daily_aggregates': the real per-day/gender/district/venue rows. Has
#     reached/acquired but preload_youth is NULL throughout — this table has
#     NO gender/venue/date breakdown of "assigned".
#   - 'targets' and 'venue_targets': NOT simple duplicates of each other —
#     re-verified live 2026-08-04, correcting an earlier assumption here.
#     BOOTCAMP_5: same mobilisation_target total (1428) but different
#     preload_youth (1995 'targets' vs 2073 'venue_targets'), and only
#     'venue_targets' carries a real venue_name (27/27 vs 0/27) — use
#     'venue_targets' for BC5 so a venue/parish breakdown is possible.
#     BOOTCAMP_4: different row counts (30 vs 43) AND different
#     mobilisation_target totals (3474 vs 4073) — genuinely unresolved which
#     is correct, so BC4 stays on the original 'targets' choice until
#     confirmed with the recruitment team; don't change it without checking.
# Always filter to ONE of these for reached/acquired ('daily_aggregates') and
# ONE for preload_youth/mobilisation_target (TARGET_MEASURE_BY_COHORT, below).
DAILY_ACQ_MEASURE_ACTUAL = "daily_aggregates"
DAILY_ACQ_MEASURE_TARGET = "targets"
DAILY_ACQUISITION_SUMMARY = f"{_GOLD}.eba_bootcamp_daily_acquisition_summary"

# 'daily_aggregates' rows also carry a `collection_type` column distinguishing
# two genuinely different acquisition channels — "Mobilisation" as a whole is
# both together. Confirmed live, 2026-08-08, re-verified same day after an
# upstream data-model change (values below were originally NULL/'MOBILIZATION'
# with Offline's total_youth_reached always 0 — that first cut is what
# produced Confirmed > Reached, mobilisation_rate >100%, reproduced live; the
# upstream fix gave Offline its own genuine total_youth_reached, so a plain
# SUM across both collection_types is correct again for reached/confirmed —
# no more special-casing needed there). Current values:
#   'ONLINE'  — the call-center pathway this mart originally modeled.
#   'OFFLINE' — an in-person channel, live since call_date 2026-08-07, with
#               its own real total_youth_reached/total_acquired_youth pair.
# Still split by this column wherever the ONLINE-vs-OFFLINE breakdown itself
# is the point (mobilisation()'s `online`/`offline` segments, the share
# display, drill-downs) — just not required anymore to get a correct blended
# reached/confirmed total.
ONLINE_COLLECTION_TYPE = "ONLINE"
OFFLINE_COLLECTION_TYPE = "OFFLINE"

# The 'targets'/'venue_targets' rows are a live per-venue snapshot LOG, not
# one static row per venue — confirmed 2026-08-05, reading every column:
# preload_youth/mobilisation_target genuinely never change for a given venue
# (Iganga's Bugabwe Primary School is preload_youth=192, target=100 on all 15
# of its 'venue_targets' rows), but total_youth_called/total_youth_reached/
# total_acquired_youth climb across those same 15 rows as a call-progress
# counter gets re-appended over time. A plain `SELECT DISTINCT *` does NOT
# collapse these — the varying progress columns make every row look unique —
# which is why that was tried and still summed to an inflated total. Only
# de-duplicating on the columns that identify "this venue's target" (not the
# whole row) collapses correctly: verified live, this gives back BOOTCAMP_5's
# already-documented totals exactly (2,073 'venue_targets', 1,995 'targets').
# 'targets' rows carry no venue_name/venue_parish (see comment above) — the
# (preload_youth, mobilisation_target) pair is what distinguishes one venue's
# repeated rows from another's there, so it's included in the dedup key for
# both measures, not just used as the thing being summed.
# Use this instead of DAILY_ACQUISITION_SUMMARY for any query that SUMs
# preload_youth or mobilisation_target; queries reading DAILY_ACQ_MEASURE_ACTUAL
# rows (reached/confirmed) are unaffected and should keep using the plain table.
DAILY_ACQUISITION_TARGETS_DEDUPED = f"""(
    SELECT DISTINCT bootcamp_cycle, measure, agent_district, venue_parish, venue_name,
           preload_youth, mobilisation_target
    FROM {DAILY_ACQUISITION_SUMMARY}
    WHERE measure IN ('{DAILY_ACQ_MEASURE_TARGET}', 'venue_targets')
)"""

# Which `measure` value a cohort's preload_youth/mobilisation_target queries
# should use — see the DAILY_ACQUISITION_SUMMARY comment above. Confirmed
# 2026-08-04 for BOOTCAMP_5 only; every other cohort keeps DEFAULT_TARGET_MEASURE
# until it gets its own confirmation.
TARGET_MEASURE_BY_COHORT = {
    "BOOTCAMP_5": "venue_targets",
}
DEFAULT_TARGET_MEASURE = "targets"


def target_measure_where(prefix: str, cohorts: list):
    """(clause, params) OR-ing together `(bootcamp_cycle = X AND measure = Y)`
    for each cohort in `cohorts`, Y being whichever measure
    TARGET_MEASURE_BY_COHORT assigns that cohort (or the default). Splice into
    build_where(extra=[...]) alongside the district filter — do NOT also add
    active_cohort_clause for the same query, this already scopes the cohorts."""
    clauses, params = [], []
    for i, cyc in enumerate(cohorts):
        measure = TARGET_MEASURE_BY_COHORT.get(cyc, DEFAULT_TARGET_MEASURE)
        clauses.append(f"(bootcamp_cycle = @{prefix}_c{i} AND measure = @{prefix}_m{i})")
        params.append(_scalar(f"{prefix}_c{i}", "STRING", cyc))
        params.append(_scalar(f"{prefix}_m{i}", "STRING", measure))
    return "(" + " OR ".join(clauses) + ")", params


# Per-parish BC5 planning targets from the recruitment team's own sheet — has
# no cohort/bootcamp_cycle column, it's BC5-only by construction. Richer than
# AWARENESS_ELIGIBLE_TARGET_BC5 below: carries the same eligible-target number
# (total_new_recruits_awareness_eligible_target sums to 1428, identical to
# AWARENESS_ELIGIBLE_TARGET_BC5's total) plus a treatment/control split
# (pct_new_recruits_treatment/control) to derive from it. Confirmed with the
# recruitment team 2026-08-04: the acquisition-stage treatment/control target
# is eligible_target × that pct split (≈802/626) — NOT this table's own
# new_recruits_treatment_acquisition/control_acquisition columns (640/500),
# which are a different funnel stage ("arrival"), not acquisition/mobilisation.
PARISH_TARGETS_BC5 = f"{_BRONZE}.raw_bc5_parish_targets"

# Parish-name spelling variants confirmed live 2026-08-05 in BOTH
# DAILY_ACQUISITION_SUMMARY (venue_parish) and AWARENESS_KYC (youth_parish) —
# same real Mayuge parish, inconsistent data entry (e.g. "Family Church Of
# God"'s target row is filed under the misspelled variant, splitting its
# preload/target away from that parish's real call-center + auto-confirm
# activity, which is correctly spelled). Canonical spelling is whichever
# PARISH_TARGETS_BC5 — the recruitment team's own planning sheet — uses,
# since every parish-grain rollup ultimately joins against it. Add new
# entries here as more variants are confirmed; this stays a flat map, not a
# fuzzy-match, so it never silently merges two genuinely different parishes.
PARISH_NAME_ALIASES = {
    "MAIRINYA": "MAYIRINYA",
}


def canonical_parish_sql(col: str) -> str:
    """UPPER(col), corrected for known spelling variants (PARISH_NAME_ALIASES)
    — splice in place of a bare `UPPER(col)` in any SELECT/GROUP BY that reads
    a live parish column, so the same real parish doesn't fragment into two
    rows across a cross-table rollup."""
    base = f"UPPER({col})"
    if not PARISH_NAME_ALIASES:
        return base
    whens = " ".join(f"WHEN {base} = '{wrong}' THEN '{right}'" for wrong, right in PARISH_NAME_ALIASES.items())
    return f"(CASE {whens} ELSE {base} END)"

# Per-venue mobilisation targets — DAILY_ACQUISITION_SUMMARY's 'venue_targets'
# measure was confirmed above to be an exact duplicate of the district-grain
# 'targets' rows, not real per-venue values, so there's no live BigQuery
# source for this yet. Hardcoded from the recruitment team's BC3 Control List
# pending a real upstream fix — keyed by venue_name, matched case/whitespace-
# insensitively in mobilisation_heatmap() since live venue_name casing varies.
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



# Live venue_name spelling variants confirmed live 2026-08-05 — a doubled
# word, a stray "(Junior)" suffix, and a missing space before "&". Each of
# these three real venues was fragmenting into TWO rows in
# mobilisation_heatmap()'s by_venue: DAILY_ACQUISITION_TARGETS_DEDUPED (the
# target side) spells it one way, DAILY_ACQUISITION_SUMMARY (the actual
# side) spells it the other, so grouping by bare UPPER(venue_name) split one
# venue's assigned/target onto one row and its reached/confirmed onto a
# separate row — never both together, and the actual-side row's target fell
# through to VENUE_MOBILISATION_TARGET's hardcoded fallback, which ALSO
# didn't match the variant spelling, reading target=0 despite real activity.
# Flat alias map (not fuzzy matching) for the same reason as
# PARISH_NAME_ALIASES — it never silently merges two genuinely different
# venues. Used two ways: canonical_venue_sql() folds both spellings onto one
# row before the two sides ever get grouped; venue_mobilisation_target()
# below still needs it too, for a venue that only ever appears under the
# variant spelling (no live target row under either spelling at all).
VENUE_NAME_ALIASES = {
    "GOLDEN JUNIOR PRIMARY SCHOOL (JUNIOR)": "Golden Junior Primary School",
    "KINAWAMBUZI PRIMARY PRIMARY SCHOOL": "Kinawambuzi Primary School",
    "ABU HURAIRAH ISLAMIC NUS& PRIMARY SCHOOL": "Abu Hurairah Islamic Nus & Primary School",
}


def canonical_venue_sql(col: str) -> str:
    """UPPER(col), corrected for known live spelling variants
    (VENUE_NAME_ALIASES) — splice in place of a bare `UPPER(col)` in any
    SELECT/GROUP BY that reads a live venue_name column, so the same real
    venue doesn't fragment into two rows across a cross-table rollup (see
    the note at VENUE_NAME_ALIASES)."""
    base = f"UPPER({col})"
    if not VENUE_NAME_ALIASES:
        return base
    whens = " ".join(f"WHEN {base} = '{wrong}' THEN '{right.upper()}'" for wrong, right in VENUE_NAME_ALIASES.items())
    return f"(CASE {whens} ELSE {base} END)"


def venue_mobilisation_target(venue_name: str):
    """Case/whitespace-insensitive lookup into VENUE_MOBILISATION_TARGET —
    live venue_name values aren't guaranteed to match this hardcoded list's
    casing exactly, and a handful don't match even after normalising (see
    VENUE_NAME_ALIASES). Returns None (not 0) for an unmatched venue, so
    callers can tell "no target on file" apart from "target is genuinely
    zero"."""
    if not venue_name:
        return None
    normalized = " ".join(venue_name.split())
    canonical = VENUE_NAME_ALIASES.get(normalized.upper(), normalized)
    key = canonical.casefold()
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

# Per Afra (2026-08-08): starting this date the BC5 call-centre team switched
# from acquisition calling to quality-assurance calling (re-confirming
# identity/name on already-registered youth) — a SEPARATE pipeline
# (QUALITY_ASSURANCE_BC5/QUALITY_ASSURANCE_SILVER below), not a later date
# range within BC5_ACQUISITION_CALLS (confirmed live: that table has zero rows
# after LAST_ACQUISITION_CALL_DATE, the day before — kept as its own literal,
# not derived from this one, so nothing here depends on date arithmetic).
# /api/recruitment/call-centre-insights caps its date_to at
# LAST_ACQUISITION_CALL_DATE — even if a caller asks for a later date, its
# acquisition-outcome metrics would be meaningless for a QA call.
# QA_CALLS_START_DATE itself is display-only (surfaced in /api/recruitment/
# qa-calls' response) — the QA tables have no date column at all to filter on.
QA_CALLS_START_DATE = "2026-08-07"
LAST_ACQUISITION_CALL_DATE = "2026-08-06"

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
# /api/implementation/attendance's daily/by_venue/by_venue_day.
ATTENDANCE_SUMMARY = f"{_GOLD}.eba_bootcamp_attendance_summary"

# Per-youth, per-lesson attendance RECORD (confirmed live 2026-08-07) --
# genuinely different grain from ATTENDANCE_SUMMARY above (that's a daily
# venue-level aggregate; this is one row per youth per lesson, with a real
# lesson_id/lesson_name/lesson_time). site_name == venue_name in every sample
# checked -- "site" isn't a distinct grain here, just venue's other name in
# this table. report_created_by/submitted_by are opaque auth-system user IDs
# (e.g. "user_3Cyn4wLkPlFZf3JhkTcbmLwj8ly"), not names -- already
# de-identified, no PII masking needed to show a "reported by" breakdown.
# Backs /api/implementation/attendance-lessons.
LESSON_ATTENDANCE = f"{_SILVER}.eba_bootcamp_attendance"

# A report's on-time flag, per the recruitment team's cutoff: a Morning
# lesson's report is timely if submitted before 12:00 noon LOCAL time; an
# Afternoon lesson's report is timely if submitted at/before 17:00 LOCAL.
# submission_time is stored in UTC (confirmed live -- Morning reports cluster
# 05:00-08:00 UTC, i.e. 08:00-11:00 EAT, right before the actual local
# cutoff; Afternoon reports cluster 10:00-12:00 UTC, i.e. 13:00-15:00 EAT),
# so this converts to Africa/Kampala (EAT, UTC+3, no DST) before comparing.
# `report_id` (not this row alone) is the real unit a "timely" flag applies
# to -- every youth row in the same report shares one submission_time.
LESSON_TIMELY_REPORT_SQL = """CASE
      WHEN lesson_time = 'Morning' THEN TIME(DATETIME(submission_time, 'Africa/Kampala')) < TIME(12, 0, 0)
      WHEN lesson_time = 'Afternoon' THEN TIME(DATETIME(submission_time, 'Africa/Kampala')) <= TIME(17, 0, 0)
      ELSE NULL
    END"""

# Trainer quality: raw per-lesson observation form export (ODK-style — every
# column is STRING, one row per classroom observation). Has no bootcamp_cycle
# column and mixes two scoring vintages (an older class_score/_category scheme
# and the current v2 tool's 0-4 overall_average_class_observation_score) in the
# same table, so rows are scoped to the current cohort by report_type + a
# submission-date window instead (per the recruitment team's reference query,
# trainer_quality_summary_sql.sql). Backs /api/implementation/trainers.
#
# Observations span three cohort windows. BOOTCAMP_4 is the prior cohort (per
# instruction, 2026-08-03) and carries the same v2 scoring columns, so it gets
# the identical treatment: 310 rows / 79 trainers across BUGIRI + BUGWERI.
# BC5 then splits into two distinct phases (per instruction, 2026-07-30):
# TOT ("Training of Trainers" — trainers being certified, before they teach
# youth) and the BOOTCAMP_5 delivery window itself (trainers observed while
# actually teaching). TOT and BOOTCAMP_5 are contiguous but conceptually
# different populations — a trainer's TOT score isn't the same signal as their
# in-classroom BOOTCAMP_5 score — so the endpoint reports a per-cohort
# breakdown alongside the register.
#
# BOOTCAMP_4 is NOT contiguous with BC5: 2026-05-30..2026-07-28 belongs to no
# cohort. The endpoint therefore filters on an OR of the three windows rather
# than one wide span, so every row it returns maps to exactly one cohort and
# the two-month gap can never leak in un-labelled.
#
# Update these dates alongside ACTIVE_COHORTS once BC6 trainer data lands.
TRAINER_OBSERVATIONS         = f"{_SILVER}.raw_eba_2025_monitoring_tool_v2_ug"
TRAINER_BC4_START_DATE       = "2026-05-04"
TRAINER_BC4_END_DATE         = "2026-05-29"
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

# The SAME 3,010 BOOTCAMP_5 calls as ACQUISITION_CALL_LOG WHERE bootcamp_cycle
# = 'BOOTCAMP_5' — confirmed live 2026-08-04: identical row count and, column
# for column, identical values/counts (call_status; interest ↔ attendance_status,
# just 'yes'/'no'/'maybe' vs 'Yes'/'No'/'Maybe'; decision ↔ decision_consultant;
# why_interest ↔ non_attendance_reason; questions_feedback ↔ questions). This is
# BC5's OWN native call-log schema, though — the cross-cohort
# ACQUISITION_CALL_LOG mart that folds BC2–BC5 into one shape drops two fields
# entirely for BC5 (blank in ACQUISITION_CALL_LOG, real here):
#   - `gatekeeper_relationship` — structured (Parent/Spouse/Relative/Other),
#     640/3010 populated. A direct, much larger-N replacement for inferring
#     "who is the gatekeeper" from free-text keyword matching.
#   - `attendance_support_notes` — a coded field (Transport/No support
#     needed/Follow up calls/Other/Enough information/...), 720/3010
#     populated. THE real answer to "what support do youth need" — not the
#     always-empty-for-BC5 `support_needed`/`other_support_details` columns
#     on either table, and not something to mine out of general call notes.
# call_centre_insights() uses this table instead of ACQUISITION_CALL_LOG for
# exactly those two fields' sake, reading every other field under its native
# name here rather than the cross-cohort mart's renamed version.
BC5_ACQUISITION_CALLS = f"{_SILVER}.eba_bc5_acquisition"

# Quality Assurance calls — a SEPARATE pipeline from BC5_ACQUISITION_CALLS,
# not a later date range within it (confirmed live, 2026-08-08: BC5_ACQUISITION_
# CALLS has zero rows after LAST_ACQUISITION_CALL_DATE — QA call activity is
# loaded into these two tables instead once the call-centre team switches over).
# GOLD is a pre-aggregated rollup (venue x mobilizer x cycle grain) with
# call-status/confirmed-identity/name-verification counts already summed,
# incl. by gender — use this for every numeric KPI/breakdown, it's far
# lighter than re-aggregating the per-call SILVER table client-side.
#
# ⚠️ Added by Afra, 2026-08-08: GOLD carries TWO row types under `measure`,
# same double-counting trap as every other `measure`-column mart in this
# codebase (AWARENESS_SUMMARY, DAILY_ACQUISITION_SUMMARY, ...) — verified
# live, both sum to IDENTICAL totals (792 total_call_attempts each):
#   - 'cumulative': one row per venue x mobilizer, no call_date — the whole-
#     campaign-to-date totals. Use this for every aggregate KPI/breakdown
#     (by_district/by_venue/by_gender/overall totals).
#   - 'daily': one row per venue x mobilizer x call_date — use this (and
#     ONLY this) for a day-by-day trend, grouped by call_date. Never sum
#     both measures together in the same query.
# Always filter to exactly one of QA_MEASURE_CUMULATIVE/QA_MEASURE_DAILY.
QA_MEASURE_CUMULATIVE = "cumulative"
QA_MEASURE_DAILY = "daily"
# SILVER is the per-call record (607 BOOTCAMP_5 rows) — only has a real
# qualitative signal in `support_needed` (mirrors BC5_ACQUISITION_CALLS'
# `attendance_support_notes`, but sparser here); query just that column from
# it, never the whole row, to keep this page's queries light.
QUALITY_ASSURANCE_BC5 = f"{_GOLD}.eba_bootcamp_quality_assurance"
QUALITY_ASSURANCE_SILVER = f"{_SILVER}.eba_bc5_quality_assurance"

# Weekly per-youth business-plan pitch record — backs the Product Design >
# Milestones page. `week` is a STRING ('Week 1'..'Week 4'); `business_plan_score`
# uses TWO DIFFERENT SCALES for the same column depending on week — confirmed
# against every row live, 2026-08-05: Weeks 1-3 are always 0-9, Week 4 is
# always 0-20. No BOOTCAMP_5 rows exist yet (BOOTCAMP_3/4 + MINI_BOOTCAMP_3
# only) — callers should NOT default to ACTIVE_COHORTS here, unlike most of
# this dashboard, since that would show nothing.
MILESTONES = f"{_SILVER}.eba_bootcamp_business_plan_reports"

# below/meet/exceed thresholds and the "completed" definition are the
# recruitment/M&E team's own reference query (not derived by this dashboard):
#   Weeks 1-3: score 1-3 below, 4-6 meet, 7-9 exceed
#   Week 4:    score 1-8 below, 9-15 meet, 16-20 exceed
#   score 0 (any week) is left unclassified (NULL) -- no pitch attempt to grade,
#   distinct from a genuinely low score
# "completed" a milestone = business_plan_score >= 1, not the table's own
# `completed` boolean column — the reference query ignores that column too.
MILESTONE_PERFORMANCE_CATEGORY_SQL = """CASE
      WHEN week = 'Week 4' AND business_plan_score BETWEEN 1 AND 8 THEN 'below'
      WHEN week = 'Week 4' AND business_plan_score BETWEEN 9 AND 15 THEN 'meet'
      WHEN week = 'Week 4' AND business_plan_score >= 16 THEN 'exceed'
      WHEN week IN ('Week 1', 'Week 2', 'Week 3') AND business_plan_score BETWEEN 1 AND 3 THEN 'below'
      WHEN week IN ('Week 1', 'Week 2', 'Week 3') AND business_plan_score BETWEEN 4 AND 6 THEN 'meet'
      WHEN week IN ('Week 1', 'Week 2', 'Week 3') AND business_plan_score BETWEEN 7 AND 9 THEN 'exceed'
      ELSE NULL
    END"""


def resolve_active_cohorts(requested: list = None, default: list = None) -> list:
    """The cycles a live-table query should scope to: `requested` (the
    frontend's cohort filter selection) when given and non-empty, else
    `default` if the caller supplied one, else the shared ACTIVE_COHORTS set.

    `default` exists because ACTIVE_COHORTS is shared across every live-table
    query, but not every mart agrees on which cycle is "active" -- Mobilisation/
    Recruitment tables (DAILY_ACQUISITION_SUMMARY etc.) closed out BOOTCAMP_4
    and moved to BOOTCAMP_5 (confirmed live 2026-08-08), while ATTENDANCE_
    SUMMARY/SITE_FUNNEL_METRICS/LESSON_ATTENDANCE have zero BOOTCAMP_5 rows at
    all (confirmed live throughout this session) -- their only real data is
    BOOTCAMP_4. Bumping the shared ACTIVE_COHORTS to BOOTCAMP_5-only for the
    former silently emptied the latter. Callers on the BC4-only side pass
    `default=ATTENDANCE_MART_COHORTS` instead of relying on the shared default.

    `requested` is trusted as-is rather than intersected against ACTIVE_
    COHORTS/`default` — the filter dropdown's cohort options now come from a
    live `SELECT DISTINCT bootcamp_cycle` (see /api/filters), which can
    include cohorts outside either list (e.g. BOOTCAMP_2/3), so filtering a
    real user selection down would silently ignore it. Values are always
    passed as a BigQuery query parameter (never string-interpolated), so
    there's no injection risk in trusting an unrecognized string here — it
    just matches zero rows."""
    cleaned = [c for c in (requested or []) if c]
    if cleaned:
        return cleaned
    return default if default is not None else ACTIVE_COHORTS


def active_cohort_clause(prefix: str, requested: list = None, default: list = None):
    """(clause, params) restricting bootcamp_cycle to
    resolve_active_cohorts(requested, default) for a live-table query.
    Splice into build_where(extra=[...]). See resolve_active_cohorts' and
    ACTIVE_COHORTS' comments -- pass `default` for a mart whose active cycle
    disagrees with the shared ACTIVE_COHORTS set (e.g. ATTENDANCE_MART_COHORTS)."""
    return (
        f"bootcamp_cycle IN UNNEST(@{prefix}_cycle)",
        [_array(f"{prefix}_cycle", "STRING", resolve_active_cohorts(requested, default))],
    )


# BC5 has zero rows across ATTENDANCE_SUMMARY, SITE_FUNNEL_METRICS, and
# LESSON_ATTENDANCE (confirmed live throughout this session) -- unlike
# ACTIVE_COHORTS (BOOTCAMP_5-only, governing Mobilisation/Recruitment tables
# where BC4 is closed out), these three tables' only real data is BOOTCAMP_4.
# Passed as active_cohort_clause(..., default=ATTENDANCE_MART_COHORTS) by
# /api/implementation/attendance, /attendance-lessons, and /retention. Update
# (or drop back to the shared ACTIVE_COHORTS) once BC5 data lands here too.
ATTENDANCE_MART_COHORTS = ["BOOTCAMP_4"]

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
RETENTION_VENUE      = f"{_GOLD}.eba_retention_venue"         # TODO: confirm — acquired/activated/retained per venue
TRAINER_QUALITY      = f"{_GOLD}.eba_trainer_quality"         # TODO: confirm — trainer observation scores
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
