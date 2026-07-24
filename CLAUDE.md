# CLAUDE.md — E!BA Dashboard

Thin conventions file. Detail lives in `docs/` — read order: `ONBOARDING.md` →
`CONTEXT.md` → `ARCHITECTURE.md` → `DECISION.md` → `FLOW.md` → `README.md`.

**What this is:** a two-container read-only dashboard over BigQuery for Educate!'s
E!BA recruitment funnel (Bootcamp 5, Busoga region). FastAPI backend +
React/Vite SPA. Product name in UI/docs is **E!BA Dashboard**; the data layer keeps a
neutral `eba_` prefix (tables, image names, the `X-EBA-Client` header). Don't rename
data-layer identifiers to match UI copy.

## Non-negotiable conventions

- **Never commit/push directly to `main`** — it auto-deploys to prod. Branch + PR.
  Commits: capitalized imperative subject, no type prefix.
- **Never f-string user input into SQL.** Every user value goes through a BigQuery
  param via `build_where()` / `cohort_clause()` / `date_clauses()` in `app/core/sql.py`.
- **Universal query filters:** every reported query carries the `NOT_TEST_DATA`
  exclusion (`app/core/tables.py`). Add project-specific guards there, once.
- **Tri-state columns:** if a status is `active`/`inactive`/NULL, test `= 'active'`,
  never `!= 'inactive'` — NULL is a distinct "no data" state.
- **New routes → `app/routers/<domain>.py`**, included from `main.py`. Never add a
  route to `main.py` — it is the app factory only (middleware + include_router).
- **All `/api/*` routes** pass the `X-EBA-Client` header guard and depend on
  `current_user`. Use typed FastAPI query params (422 on bad input, not 500).
- **Call BigQuery as `database.run_query(...)`** through the module object, never a
  by-value `from app.core.database import run_query` — the test suite monkeypatches
  the module attribute.
- **PII:** mask personal names with `pii.mask_name(role, name)` before serialising
  (guest sees initials); never serialise a raw phone/id — use `pii.youth_id(...)`.
- **nginx security headers** go in `frontend/security-headers.conf`, `include`d from
  each `location` block — never per-location `add_header` (it shadows the others).
- **Secrets:** no `*.json` near the backend Docker context (`.dockerignore` excludes
  `*.json`). The GCP SA key lives only in a k8s Secret. gitleaks CI is the gate.
- **Frontend:** single-file `App.jsx`, inline styles, no CSS framework, no router —
  until scope justifies otherwise (document the trigger in an ADR).

## Single-process invariant (do NOT break)

The query cache (`app/core/cache.py`) is in-memory and process-local. **Do not add
replicas or `uvicorn --workers`** without first moving the cache to Redis. Backend
runs `replicas: 1`.

## Deployment

CI (`.github/workflows/deploy.yml`) only does `kubectl set image` with a digest pin.
`k8s/**` is NOT reconciled by CI — `kubectl apply` manually, and note that applying a
deployment resets its image to `:latest`, so re-run the workflow afterward to re-pin.
Order when a deployment env var needs a new Secret key: (1) apply `secret.yaml`,
(2) apply the deployment, (3) re-run the workflow.
