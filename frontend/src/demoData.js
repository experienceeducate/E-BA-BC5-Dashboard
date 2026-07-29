/*
 * Illustrative demo data for "not connected to live data" mode.
 *
 * The SPA falls back to these fixtures (see useApi in App.jsx) when a data
 * endpoint returns 503 — i.e. the upstream BigQuery table doesn't exist yet
 * because the BC5 feed isn't live — or when the API is unreachable. It lets
 * stakeholders preview how every panel looks populated. A banner + per-card
 * "DEMO DATA" badge make clear the figures are fabricated, not real.
 *
 * Keyed by endpoint PATH ONLY (query string stripped). Shapes mirror exactly
 * what each router returns / each component reads. When the feed lands these are
 * never served — real rows replace them automatically. Kept in its own file so
 * App.jsx stays logic-only (see docs/DECISION.md ADR-008).
 */

// Names below are fabricated for the demo and are not real people.
export const DEMO = {
  "/api/overview/kpis": {
    rates: {
      eligibility_rate: 78,
      mobilisation_rate: 86,
      acquisition_rate: 81,
      activation_rate: 91,
      retention_rate: 84,
    },
  },

  "/api/overview/funnel": {
    stages: [
      { stage: "Registered", count: 12000 },
      { stage: "Interested", count: 8600 },
      { stage: "Eligible", count: 6700 },
      { stage: "Assigned", count: 6400 },
      { stage: "Reached", count: 6100 },
      { stage: "Confirmed", count: 5250 },
      { stage: "Verified", count: 4900 },
      { stage: "Acquired", count: 4200 },
      { stage: "Activated", count: 3820 },
      { stage: "Retained", count: 3210 },
    ],
  },

  "/api/overview/gender": {
    stages: [
      { stage: "Registered", female: 7080, male: 4920, pct_female: 59, target_female: 60 },
      { stage: "Interested", female: 5160, male: 3440, pct_female: 60, target_female: 60 },
      { stage: "Eligible", female: 4020, male: 2680, pct_female: 60, target_female: 60 },
      { stage: "Assigned", female: 3840, male: 2560, pct_female: 60, target_female: 60 },
      { stage: "Reached", female: 3660, male: 2440, pct_female: 60, target_female: 60 },
      { stage: "Confirmed", female: 3200, male: 2050, pct_female: 61, target_female: 60 },
      { stage: "Verified", female: 2990, male: 1910, pct_female: 61, target_female: 60 },
      { stage: "Acquired", female: 2560, male: 1640, pct_female: 61, target_female: 60 },
      { stage: "Activated", female: 2330, male: 1490, pct_female: 61, target_female: 60 },
      { stage: "Retained", female: 1960, male: 1250, pct_female: 61, target_female: 60 },
    ],
  },

  "/api/overview/eligibility-barriers": {
    barriers: [
      { barrier: "Over age (30+)", count: 820 },
      { barrier: "Education above S3", count: 610 },
      { barrier: "Income above UGX 30k", count: 540 },
      { barrier: "Under age (<18)", count: 460 },
      { barrier: "Incomplete data", count: 300 },
    ],
  },

  "/api/overview/cohort-comparison": {
    cohorts: [
      { cohort: "BC2", eligible: 5200, acquired: 3100, pct_female: 55, overall_conversion: 26 },
      { cohort: "BC3", eligible: 5900, acquired: 3600, pct_female: 57, overall_conversion: 28 },
      { cohort: "BC4", eligible: 6300, acquired: 3950, pct_female: 59, overall_conversion: 30 },
      { cohort: "BC5", eligible: 6700, acquired: 4200, pct_female: 61, overall_conversion: 31 },
    ],
  },

  "/api/overview/stage-progress": {
    stages: [
      { stage: "Registered", count: 12000, target: 16000, pct_of_target: 75.0, target_is_implied: false },
      { stage: "Interested", count: 8600, target: 16000, pct_of_target: 53.8, target_is_implied: false },
      { stage: "Eligible", count: 6700, target: 16000, pct_of_target: 41.9, target_is_implied: false },
      { stage: "Assigned", count: 6400, target: 6500, pct_of_target: 98.5, target_is_implied: false },
      { stage: "Reached", count: 6100, target: 6500, pct_of_target: 93.8, target_is_implied: false },
      { stage: "Confirmed", count: 5250, target: 6500, pct_of_target: 80.8, target_is_implied: false },
      { stage: "Verified", count: 4900, target: 5100, pct_of_target: 96.1, target_is_implied: false },
      { stage: "Acquired", count: 4200, target: 5100, pct_of_target: 82.4, target_is_implied: false },
      { stage: "Activated", count: 3820, target: 3780, pct_of_target: 101.1, target_is_implied: true },
      { stage: "Retained", count: 3210, target: 3247, pct_of_target: 98.9, target_is_implied: true },
    ],
  },

  "/api/recruitment/awareness": {
    by_district: [
      { district: "BUGIRI", registered: 3200, interested: 2300, eligible: 1800 },
      { district: "BUGWERI", registered: 2100, interested: 1500, eligible: 1200 },
      { district: "IGANGA", registered: 2800, interested: 2000, eligible: 1550 },
      { district: "KAMULI", registered: 1800, interested: 1250, eligible: 980 },
      { district: "MAYUGE", registered: 2100, interested: 1550, eligible: 1170 },
    ],
  },

  "/api/recruitment/awareness-mobilisers": {
    mobilisers: [
      { mobilizer_id: "M001", mobiliser_name: "Sarah N.", district: "BUGIRI", reached: 1200, eligible: 720, eligible_female: 460, pct_eligible_female: 63.9 },
      { mobilizer_id: "M002", mobiliser_name: "James O.", district: "IGANGA", reached: 1000, eligible: 610, eligible_female: 380, pct_eligible_female: 62.3 },
      { mobilizer_id: "M003", mobiliser_name: "Grace A.", district: "MAYUGE", reached: 850, eligible: 500, eligible_female: 310, pct_eligible_female: 62.0 },
      { mobilizer_id: "M004", mobiliser_name: "Peter M.", district: "BUGWERI", reached: 780, eligible: 470, eligible_female: 280, pct_eligible_female: 59.6 },
      { mobilizer_id: "M005", mobiliser_name: "Mary K.", district: "KAMULI", reached: 700, eligible: 400, eligible_female: 230, pct_eligible_female: 57.5 },
      { mobilizer_id: "M006", mobiliser_name: "David T.", district: "BUGIRI", reached: 600, eligible: 350, eligible_female: 210, pct_eligible_female: 60.0 },
    ],
  },

  "/api/recruitment/awareness-mobiliser-detail": {
    detail: [
      { mobilizer_id: "M001", mobiliser_name: "Sarah N.", district: "BUGIRI", parish: "BUGIRI TOWN COUNCIL", reached: 700, eligible: 430, eligible_female: 275, pct_eligible_female: 64.0 },
      { mobilizer_id: "M001", mobiliser_name: "Sarah N.", district: "BUGIRI", parish: "BUWUNGA", reached: 500, eligible: 290, eligible_female: 185, pct_eligible_female: 63.8 },
      { mobilizer_id: "M002", mobiliser_name: "James O.", district: "IGANGA", parish: "IGANGA TOWN COUNCIL", reached: 600, eligible: 370, eligible_female: 230, pct_eligible_female: 62.2 },
      { mobilizer_id: "M002", mobiliser_name: "James O.", district: "IGANGA", parish: "NAMALEMBA", reached: 400, eligible: 240, eligible_female: 150, pct_eligible_female: 62.5 },
      { mobilizer_id: "M003", mobiliser_name: "Grace A.", district: "MAYUGE", parish: "MAYUGE TOWN COUNCIL", reached: 850, eligible: 500, eligible_female: 310, pct_eligible_female: 62.0 },
      { mobilizer_id: "M004", mobiliser_name: "Peter M.", district: "BUGWERI", parish: "BUGWERI TOWN COUNCIL", reached: 780, eligible: 470, eligible_female: 280, pct_eligible_female: 59.6 },
      { mobilizer_id: "M005", mobiliser_name: "Mary K.", district: "KAMULI", parish: "KAMULI TOWN COUNCIL", reached: 700, eligible: 400, eligible_female: 230, pct_eligible_female: 57.5 },
      { mobilizer_id: "M006", mobiliser_name: "David T.", district: "BUGIRI", parish: "BUGIRI TOWN COUNCIL", reached: 600, eligible: 350, eligible_female: 210, pct_eligible_female: 60.0 },
    ],
  },

  "/api/recruitment/awareness-parish": {
    parishes: [
      { district: "BUGIRI", parish: "BUGIRI TOWN COUNCIL", reached: 1800, reached_female: 1062, reached_male: 738, interested: 1290, interested_female: 774, interested_male: 516, eligible: 1005, eligible_female: 607, eligible_male: 398, pct_female: 60.4, target: 2200 },
      { district: "BUGIRI", parish: "BUWUNGA", reached: 1400, reached_female: 826, reached_male: 574, interested: 1003, interested_female: 602, interested_male: 401, eligible: 782, eligible_female: 472, eligible_male: 310, pct_female: 60.4, target: 2000 },
      { district: "BUGWERI", parish: "BUGWERI TOWN COUNCIL", reached: 1200, reached_female: 708, reached_male: 492, interested: 860, interested_female: 516, interested_male: 344, eligible: 670, eligible_female: 405, eligible_male: 265, pct_female: 60.4, target: 1500 },
      { district: "BUGWERI", parish: "IVUKULA", reached: 900, reached_female: 531, reached_male: 369, interested: 645, interested_female: 387, interested_male: 258, eligible: 502, eligible_female: 303, eligible_male: 199, pct_female: 60.4, target: 1300 },
      { district: "IGANGA", parish: "IGANGA TOWN COUNCIL", reached: 1600, reached_female: 944, reached_male: 656, interested: 1147, interested_female: 688, interested_male: 459, eligible: 894, eligible_female: 540, eligible_male: 354, pct_female: 60.4, target: 2000 },
      { district: "IGANGA", parish: "NAMALEMBA", reached: 1200, reached_female: 708, reached_male: 492, interested: 860, interested_female: 516, interested_male: 344, eligible: 670, eligible_female: 405, eligible_male: 265, pct_female: 60.4, target: 1700 },
      { district: "KAMULI", parish: "KAMULI TOWN COUNCIL", reached: 1000, reached_female: 590, reached_male: 410, interested: 717, interested_female: 430, interested_male: 287, eligible: 559, eligible_female: 338, eligible_male: 221, pct_female: 60.5, target: 1400 },
      { district: "KAMULI", parish: "BUGULUMBYA", reached: 800, reached_female: 472, reached_male: 328, interested: 573, interested_female: 344, interested_male: 229, eligible: 446, eligible_female: 269, eligible_male: 177, pct_female: 60.3, target: 1100 },
      { district: "MAYUGE", parish: "MAYUGE TOWN COUNCIL", reached: 1300, reached_female: 767, reached_male: 533, interested: 932, interested_female: 559, interested_male: 373, eligible: 726, eligible_female: 438, eligible_male: 288, pct_female: 60.3, target: 1700 },
      { district: "MAYUGE", parish: "MALONGO", reached: 800, reached_female: 472, reached_male: 328, interested: 573, interested_female: 344, interested_male: 229, eligible: 446, eligible_female: 269, eligible_male: 177, pct_female: 60.3, target: 1100 },
    ],
  },

  "/api/recruitment/awareness-forecast": {
    daily: [
      { event_date: "2026-07-01", registered: 750, interested: 538, eligible: 419 },
      { event_date: "2026-07-02", registered: 800, interested: 573, eligible: 447 },
      { event_date: "2026-07-03", registered: 850, interested: 609, eligible: 475 },
      { event_date: "2026-07-04", registered: 900, interested: 645, eligible: 503 },
      { event_date: "2026-07-05", registered: 950, interested: 681, eligible: 530 },
      { event_date: "2026-07-06", registered: 900, interested: 645, eligible: 503 },
      { event_date: "2026-07-07", registered: 850, interested: 609, eligible: 475 },
      { event_date: "2026-07-08", registered: 800, interested: 573, eligible: 447 },
      { event_date: "2026-07-09", registered: 900, interested: 645, eligible: 503 },
      { event_date: "2026-07-10", registered: 950, interested: 681, eligible: 530 },
      { event_date: "2026-07-11", registered: 900, interested: 645, eligible: 503 },
      { event_date: "2026-07-12", registered: 850, interested: 609, eligible: 475 },
      { event_date: "2026-07-13", registered: 800, interested: 573, eligible: 447 },
      { event_date: "2026-07-14", registered: 800, interested: 574, eligible: 443 },
    ],
    registered_to_date: 12000,
    interested_to_date: 8600,
    eligible_to_date: 6700,
    eligibility_rate: 77.9,
    target: 16000,
    n_days: 14,
    avg_daily_rate: 857.1,
    days_to_target: 5,
    by_district: [
      { district: "BUGIRI", registered: 3200, target: 4200, gap: 1000, pct_of_target: 76.2, avg_daily_rate: 228.6, days_to_target: 4 },
      { district: "BUGWERI", registered: 2100, target: 2800, gap: 700, pct_of_target: 75.0, avg_daily_rate: 150.0, days_to_target: 5 },
      { district: "IGANGA", registered: 2800, target: 3700, gap: 900, pct_of_target: 75.7, avg_daily_rate: 200.0, days_to_target: 5 },
      { district: "KAMULI", registered: 1800, target: 2500, gap: 700, pct_of_target: 72.0, avg_daily_rate: 128.6, days_to_target: 5 },
      { district: "MAYUGE", registered: 2100, target: 2800, gap: 700, pct_of_target: 75.0, avg_daily_rate: 150.0, days_to_target: 5 },
    ],
  },

  "/api/recruitment/duplicate-summary": {
    total_count: 12000,
    duplicate_count: 708,
    duplicate_rate: 5.9,
  },

  "/api/recruitment/awareness-kyc": {
    demographics: {
      eligible_count: 6700,
      pct_female: 60.4,
      avg_age: 22.3,
      owns_business_count: 2010,
      pct_owns_business: 30,
      duplicate_count: 268,
      duplicate_rate: 4,
      pct_p5_p7: 71.5,
      pct_age_18_25: 64.2,
      pct_owns_phone: 82.6,
    },
    activity: [
      { activity: "Casual labour", count: 2400 },
      { activity: "Staying home", count: 1800 },
      { activity: "Farming", count: 1300 },
      { activity: "Petty trade", count: 900 },
      { activity: "In school", count: 300 },
    ],
    reasons: [
      { reason: "Want a stable income", count: 2900 },
      { reason: "Want to start a business", count: 2200 },
      { reason: "Want a new skill", count: 1400 },
      { reason: "Encouraged by family", count: 700 },
      { reason: "Encouraged by mobiliser", count: 500 },
    ],
    business: {
      by_gender_district: [
        { district: "BUGIRI", gender: "Female", owners: 420, total: 1400, pct_owns_business: 30 },
        { district: "BUGIRI", gender: "Male", owners: 310, total: 950, pct_owns_business: 32.6 },
        { district: "BUGWERI", gender: "Female", owners: 260, total: 900, pct_owns_business: 28.9 },
        { district: "BUGWERI", gender: "Male", owners: 190, total: 620, pct_owns_business: 30.6 },
      ],
    },
    channels: [
      { channel: "Mobiliser referral", eligible: 2600, ineligible: 900 },
      { channel: "Radio", eligible: 1400, ineligible: 700 },
      { channel: "Word of mouth", eligible: 1600, ineligible: 800 },
      { channel: "Church/mosque", eligible: 700, ineligible: 400 },
      { channel: "SMS", eligible: 400, ineligible: 250 },
    ],
  },

  "/api/recruitment/mobilisation": {
    assigned: 6400,
    reached: 6100,
    confirmed: 5250,
    reach_rate: 95,
    mobilisation_rate: 86,
    confirmed_female: 3150,
    confirmed_female_pct: 60.0,
    target: 6500,
    progress_pct: 80.8,
    four_week: { assigned: 6200, reached: 6100, confirmed: 5050, reach_rate: 98.4, mobilisation_rate: 81.5, pct_female: 60.2 },
    two_half_week: { assigned: 200, reached: 0, confirmed: 200, reach_rate: 0.0, mobilisation_rate: 100.0, pct_female: 55.0 },
  },

  "/api/recruitment/mobilisation-heatmap": {
    by_venue: [
      { district: "BUGIRI", venue: "St. Peter's PS", reached: 1800, confirmed: 1500, confirmed_female: 900 },
      { district: "BUGWERI", venue: "Buwaya SS", reached: 1200, confirmed: 950, confirmed_female: 570 },
      // Deliberately below IGANGA's district-level confirmed total (1150) —
      // a real district total can come from multiple venues, and this one's
      // own rate (71.4%) is kept intentionally "High Risk" so the High-Risk-
      // venue(s) insight and the Site early-warning flags panel both still
      // have something to show in local demo mode.
      { district: "IGANGA", venue: "Naigobya PS", reached: 1400, confirmed: 1000, confirmed_female: 600 },
    ],
    by_district: [
      { district: "BUGIRI", assigned: 1800, target: 1900, reached: 1800, confirmed: 1500, confirmed_female: 900 },
      { district: "BUGWERI", assigned: 1200, target: 1300, reached: 1200, confirmed: 950, confirmed_female: 570 },
      { district: "IGANGA", assigned: 1400, target: 1450, reached: 1400, confirmed: 1150, confirmed_female: 690 },
      { district: "KAMULI", assigned: 900, target: 950, reached: 850, confirmed: 700, confirmed_female: 385 },
      { district: "MAYUGE", assigned: 900, target: 900, reached: 850, confirmed: 750, confirmed_female: 488 },
    ],
  },

  "/api/recruitment/mobilisation-forecast": {
    daily: [
      { event_date: "2026-07-01", reached: 450, confirmed: 387 }, { event_date: "2026-07-02", reached: 440, confirmed: 378 },
      { event_date: "2026-07-03", reached: 430, confirmed: 370 }, { event_date: "2026-07-04", reached: 450, confirmed: 387 },
      { event_date: "2026-07-05", reached: 460, confirmed: 396 }, { event_date: "2026-07-06", reached: 440, confirmed: 378 },
      { event_date: "2026-07-07", reached: 430, confirmed: 370 }, { event_date: "2026-07-08", reached: 420, confirmed: 361 },
      { event_date: "2026-07-09", reached: 440, confirmed: 378 }, { event_date: "2026-07-10", reached: 450, confirmed: 387 },
      { event_date: "2026-07-11", reached: 430, confirmed: 370 }, { event_date: "2026-07-12", reached: 420, confirmed: 361 },
      { event_date: "2026-07-13", reached: 410, confirmed: 353 }, { event_date: "2026-07-14", reached: 430, confirmed: 374 },
    ],
    confirmed_to_date: 5250,
    target: 6500,
    avg_daily_rate: 375.0,
    days_to_target: 3,
  },

  "/api/recruitment/control-calls": {
    total: 850,
    control: 430,
    mobilization: 420,
    reached: 610,
    reach_pct: 71.8,
    female: 510,
    male: 340,
    pct_female: 60.0,
    avg_age: 23.4,
    by_district: [
      { district: "BUGIRI", n: 220 },
      { district: "IGANGA", n: 190 },
      { district: "MAYUGE", n: 160 },
      { district: "BUGWERI", n: 150 },
      { district: "KAMULI", n: 130 },
    ],
    by_status: [
      { status: "REACHED", n: 610 },
      { status: "NOT_REACHED", n: 180 },
      { status: "INVALID_NUMBER", n: 60 },
    ],
  },

  "/api/recruitment/call-centre-insights": {
    barriers: [
      { barrier: "Not interested at this time", count: 320, pct: 38.8 },
      { barrier: "Number unreachable", count: 210, pct: 25.5 },
      { barrier: "Already engaged elsewhere", count: 140, pct: 17.0 },
      { barrier: "Family/parental objection", count: 95, pct: 11.5 },
      { barrier: "Distance to venue", count: 60, pct: 7.3 },
    ],
  },

  "/api/recruitment/acquisition": {
    by_district: [
      { district: "BUGIRI", verified: 1400, acquired: 1200 },
      { district: "BUGWERI", verified: 900, acquired: 770 },
      { district: "IGANGA", verified: 1150, acquired: 990 },
      { district: "KAMULI", verified: 720, acquired: 620 },
      { district: "MAYUGE", verified: 730, acquired: 620 },
    ],
    totals: {
      verified: 4900,
      acquired: 4200,
      registered: 12000,
      activated: 3820,
      retained: 3210,
      acquisition_rate: 85.7,
      overall_conversion_rate: 35.0,
      retention_rate: 84.0,
    },
  },

  "/api/recruitment/acquisition-arrival": {
    by_venue: [
      { district: "BUGIRI", venue: "Bugiri Core PTC", verified: 1400, acquired: 1200, acquired_female: 732, acquisition_rate: 85.7, pct_female_acquired: 61.0 },
      { district: "BUGWERI", venue: "Bugweri Vocational Institute", verified: 900, acquired: 770, acquired_female: 470, acquisition_rate: 85.6, pct_female_acquired: 61.0 },
      { district: "IGANGA", venue: "Iganga Technical Institute", verified: 1150, acquired: 990, acquired_female: 604, acquisition_rate: 86.1, pct_female_acquired: 61.0 },
      { district: "KAMULI", venue: "Kamuli Skills Center", verified: 720, acquired: 620, acquired_female: 378, acquisition_rate: 86.1, pct_female_acquired: 61.0 },
      { district: "MAYUGE", venue: "Mayuge Youth Hub", verified: 730, acquired: 620, acquired_female: 378, acquisition_rate: 84.9, pct_female_acquired: 61.0 },
    ],
  },

  "/api/recruitment/mobilisers": {
    mobilisers: [
      { mobiliser_name: "Sarah N.", district: "BUGIRI", reached: 620, confirmed: 540 },
      { mobiliser_name: "James O.", district: "IGANGA", reached: 580, confirmed: 500 },
      { mobiliser_name: "Grace A.", district: "MAYUGE", reached: 540, confirmed: 470 },
      { mobiliser_name: "Peter M.", district: "BUGWERI", reached: 510, confirmed: 430 },
      { mobiliser_name: "Mary K.", district: "KAMULI", reached: 470, confirmed: 400 },
    ],
  },

  "/api/recruitment/tam": {
    parishes: [
      { district: "BUGIRI", parish: "BUBUGO", predicted: 127, actual: 176, validation_rate: 138, status: "Met Target" },
      { district: "BUGIRI", parish: "NAMBALE", predicted: 171, actual: 344, validation_rate: 201, status: "Met Target" },
      { district: "BUGWERI", parish: "MAJENGO WARD", predicted: 174, actual: 171, validation_rate: 98, status: "On Track" },
      { district: "KAMULI", parish: "NAWANGO", predicted: 117, actual: 167, validation_rate: 143, status: "Met Target" },
      { district: "MAYUGE", parish: "LUGOLOLE", predicted: 306, actual: 162, validation_rate: 53, status: "At Risk" },
      { district: "IGANGA", parish: "BUKOYO", predicted: 222, actual: 76, validation_rate: 34, status: "Low / Critical" },
    ],
  },

  "/api/implementation/retention": {
    targets: { activation: 90, retention: 85 },
    by_venue: [
      { district: "BUGIRI", venue: "Isegero VTC", acquired: 420, activated: 390, retained: 335, activation_rate: 93, retention_rate: 86 },
      { district: "IGANGA", venue: "Nakalama CC", acquired: 360, activated: 320, retained: 270, activation_rate: 89, retention_rate: 84 },
      { district: "MAYUGE", venue: "Kigandalo HS", acquired: 300, activated: 275, retained: 230, activation_rate: 92, retention_rate: 84 },
      { district: "BUGWERI", venue: "Busembatia CC", acquired: 280, activated: 255, retained: 215, activation_rate: 91, retention_rate: 84 },
      { district: "KAMULI", venue: "Namwendwa VTC", acquired: 240, activated: 220, retained: 188, activation_rate: 92, retention_rate: 85 },
    ],
  },

  "/api/implementation/attendance": {
    daily: [
      { event_date: "2026-05-06", present: 3820, net_churn: -12 },
      { event_date: "2026-05-07", present: 3790, net_churn: -30 },
      { event_date: "2026-05-08", present: 3750, net_churn: -40 },
      { event_date: "2026-05-11", present: 3700, net_churn: -50 },
      { event_date: "2026-05-12", present: 3680, net_churn: -20 },
    ],
    lessons: [],
  },

  "/api/implementation/retention-calls": {
    daily: [
      { event_date: "2026-05-11", called: 210, reached: 160, promised: 120, returned: 95 },
      { event_date: "2026-05-12", called: 195, reached: 150, promised: 110, returned: 88 },
      { event_date: "2026-05-13", called: 180, reached: 140, promised: 105, returned: 84 },
      { event_date: "2026-05-14", called: 165, reached: 128, promised: 96, returned: 76 },
    ],
  },

  "/api/implementation/milestones": {
    weekly: [
      { week_number: 1, below: 60, meet: 240, exceed: 100, completion_pct: 92, parent_present_pct: 58 },
      { week_number: 2, below: 45, meet: 260, exceed: 120, completion_pct: 94, parent_present_pct: 61 },
      { week_number: 3, below: 38, meet: 255, exceed: 140, completion_pct: 95, parent_present_pct: 63 },
      { week_number: 4, below: 30, meet: 250, exceed: 155, completion_pct: 96, parent_present_pct: 65 },
    ],
  },

  "/api/implementation/trainers": {
    trainers: [
      { trainer_name: "T. Wanyama", venue: "Isegero VTC", district: "BUGIRI", rating: "Excellent", score: 92 },
      { trainer_name: "D. Mukasa", venue: "Kigandalo HS", district: "MAYUGE", rating: "Excellent", score: 90 },
      { trainer_name: "A. Nabirye", venue: "Nakalama CC", district: "IGANGA", rating: "Good", score: 85 },
      { trainer_name: "F. Achieng", venue: "Busembatia CC", district: "BUGWERI", rating: "Good", score: 83 },
      { trainer_name: "S. Opio", venue: "Namwendwa VTC", district: "KAMULI", rating: "Satisfactory", score: 78 },
    ],
  },

  "/api/implementation/youth-experience": {
    target: 50,
    weekly: [
      { week_number: 1, nps: 42 },
      { week_number: 2, nps: 48 },
      { week_number: 3, nps: 55 },
      { week_number: 4, nps: 58 },
      { week_number: 5, nps: 61 },
      { week_number: 6, nps: 64 },
      { week_number: 7, nps: 62 },
      { week_number: 8, nps: 66 },
    ],
  },

  "/api/operations/venue": {
    by_venue: [
      { district: "BUGIRI", venue: "Isegero VTC", reports: 24, compliant: 22, compliance_rate: 92 },
      { district: "IGANGA", venue: "Nakalama CC", reports: 24, compliant: 20, compliance_rate: 83 },
      { district: "MAYUGE", venue: "Kigandalo HS", reports: 24, compliant: 23, compliance_rate: 96 },
      { district: "BUGWERI", venue: "Busembatia CC", reports: 24, compliant: 21, compliance_rate: 88 },
      { district: "KAMULI", venue: "Namwendwa VTC", reports: 24, compliant: 22, compliance_rate: 92 },
    ],
  },

  "/api/operations/transport": {
    by_site: [
      { venue: "Isegero VTC", timeliness_score: 88 },
      { venue: "Nakalama CC", timeliness_score: 72 },
      { venue: "Kigandalo HS", timeliness_score: 91 },
      { venue: "Busembatia CC", timeliness_score: 84 },
      { venue: "Namwendwa VTC", timeliness_score: 69 },
    ],
  },
};

// Filter-bar options when the live /api/filters call can't be reached.
export const DEMO_FILTERS = {
  districts: ["BUGIRI", "BUGWERI", "IGANGA", "KAMULI", "MAYUGE"],
  genders: ["FEMALE", "MALE"],
  cohorts: ["BOOTCAMP_2", "BOOTCAMP_3", "BOOTCAMP_4", "BOOTCAMP_5", "MINI_BOOTCAMP_3"],
};
