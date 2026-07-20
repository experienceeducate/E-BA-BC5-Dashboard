"""
Table-reference constants — the ONE place BigQuery table names live.

⚠️ SCAFFOLD STATE: the BC5 data feed is not live yet. These are the *intended*
fully-qualified names under the `gold_eba` (marts) and `silver_eba` (cleaned
row-level) datasets, derived from the shapes in the prototype
(`reference/prototype-index.html`). Every constant below is marked
`# TODO: confirm real table name when feed lands`. Routers query them via
`database.run_query(...)`; until the tables exist, `/api/*` data endpoints will
return a BigQuery 404 — that is expected (see docs/CONTEXT.md).

Naming discipline: the *product* is "Take Off" (E!BA Recruitment) in the UI, but
the data layer keeps a neutral `eba_` prefix. Do not rename tables to match UI copy.
"""

from app.core.database import PROJECT_ID, DATASET, TABLE

# Primary summary table (BQ_TABLE default = eba_recruitment_funnel).
FULL_TABLE = f"`{PROJECT_ID}`.{DATASET}.{TABLE}"

_GOLD   = f"`{PROJECT_ID}`.gold_eba"
_SILVER = f"`{PROJECT_ID}`.silver_eba"

# ─── gold_eba — aggregated marts ────────────────────────────────────────────────
RECRUITMENT_FUNNEL   = f"{_GOLD}.eba_recruitment_funnel"      # TODO: confirm — district×gender×stage×cohort counts
COHORT_SUMMARY       = f"{_GOLD}.eba_cohort_summary"          # TODO: confirm — per-cohort BC2..BC5 rollup
GENDER_STAGE         = f"{_GOLD}.eba_gender_stage"            # TODO: confirm — female/male share per funnel stage
ELIGIBILITY_BARRIERS = f"{_GOLD}.eba_eligibility_barriers"    # TODO: confirm — why-not-eligible breakdown
TAM_PARISH           = f"{_GOLD}.eba_tam_parish"              # TODO: confirm — parish predicted/actual/validation_rate
TAM_COVERAGE         = f"{_GOLD}.eba_tam_coverage"            # TODO: confirm — parishes covered/total per district
MOBILISER_PERF       = f"{_GOLD}.eba_mobiliser_performance"   # TODO: confirm — per-mobiliser reached/confirmed
CHANNEL_PERF         = f"{_GOLD}.eba_channel_performance"     # TODO: confirm — online vs offline channel funnel
ATTENDANCE_DAILY     = f"{_GOLD}.eba_attendance_daily"        # TODO: confirm — daily present/churn per venue
ATTENDANCE_LESSON    = f"{_GOLD}.eba_attendance_lesson"       # TODO: confirm — per-lesson attendance %
RETENTION_VENUE      = f"{_GOLD}.eba_retention_venue"         # TODO: confirm — acquired/activated/retained per venue
RETENTION_CALLS      = f"{_GOLD}.eba_retention_calls"         # TODO: confirm — daily follow-up call outcomes
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
