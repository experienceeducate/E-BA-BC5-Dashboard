# Architecture

## System context

```
BigQuery (educate-data-warehouse-test: gold_eba.*, silver_eba.*)
    ↓  service-account key auth (Data Viewer + Job User)
FastAPI backend (Python 3.14-slim)   — single replica, single process
    │  /api/auth/*   Google SSO (staff) + shared password (guest) → JWT (HS256, 8h)
    │  every /api/*  requires a valid JWT + the X-EBA-Client header
    │  guest responses mask personal names; raw phone/id never leaves the backend
    ↓  REST JSON (Authorization: Bearer <jwt> + CORS allowlist + X-EBA-Client)
React 19 + Vite SPA (nginx:stable-alpine)  — single replica
    ↓
DigitalOcean Kubernetes (educate-apps-cluster / sfo2, namespace data-ingestion)
    digest-pinned deploys via GitHub Actions
```

## Component map

### Backend (`backend/app/`)
- `main.py` — **app factory only**: FastAPI init, CORS (locked to the app host +
  `localhost:3000`), `SessionMiddleware`, the `X-EBA-Client` guard middleware, and
  `include_router(...)` for each domain. No route handlers here.
- `auth.py` — JWT create/verify, `current_user` dependency, Google OAuth (authlib),
  guest login. Routes under `/api/auth`.
- `core/config.py` — Pydantic `Settings`, fail-fast on missing `JWT_SECRET` /
  `DASHBOARD_PASSWORD` / `EBA_ID_SALT`.
- `core/cache.py` — process-local `TTLCache` (maxsize 512, TTL 300s).
- `core/database.py` — BigQuery client + `run_query(sql, params, role)` (the test
  seam; cache keyed by `(role, sql, params)`) + `_scalar`/`_array` param helpers.
- `core/sql.py` — `build_where()` / `cohort_clause()` / `date_clauses()`; every
  user value becomes a BigQuery parameter.
- `core/tables.py` — the ONE place table names live (placeholder `gold_eba` /
  `silver_eba` constants + `NOT_TEST_DATA`, `FUNNEL_STAGES`, `PROGRAM_START_DATE`).
- `core/pii.py` — `youth_id()` HMAC pseudonym + `mask_name(role, name)`.
- `routers/*` — one file per URL-prefix domain (see API surface).

### Frontend (`frontend/src/App.jsx`)
Single-file SPA: auth shell (`LoginScreen`) → group/sub-tab nav driven by a `NAV`
model (state in React + `sessionStorage`, no router) → one component per tab. A
`useApi` hook sends `Authorization: Bearer <jwt>` + `X-EBA-Client` on every call.
Shared filter bar (District / Gender / Cohort) → query string via `buildParams`.
Charts via recharts. Inline styles, no CSS framework.

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness (auth + guard exempt) |
| POST | `/api/auth/login` | guest login → JWT |
| GET | `/api/auth/google/login` · `/callback` | staff Google SSO |
| GET | `/api/auth/me` | current user |
| GET | `/api/filters` | filter-bar options (districts / genders / cohorts) |
| GET | `/api/overview/{funnel,kpis,gender,eligibility-barriers,dropoff,cohort-comparison}` | Executive Summary |
| GET | `/api/recruitment/{awareness,mobilisation,acquisition,mobilisers,channels,personas,forecast,tam,tam-coverage}` | Recruitment |
| GET | `/api/implementation/{arrival,attendance,retention,retention-calls,trainers,milestones,youth-experience}` | Implementation |
| GET | `/api/operations/{meals,venue,transport}` | Field Operations |

All `/api/*` (except the auth OAuth callbacks) require the `X-EBA-Client` header
and a valid JWT.

## Deployment

Two Docker images (`patrickgichini/eba-dashboard-{server,app}`), tagged `:latest`
+ `:<sha>`. `deploy.yml`: path filter → (backend) pytest gate → build/push →
`kubectl set image ...@sha256:<digest>` → `rollout status`. PRs run tests only.
`secret-scan.yml` runs gitleaks on every PR + push to main. k8s manifests are
applied manually (not reconciled by CI).
