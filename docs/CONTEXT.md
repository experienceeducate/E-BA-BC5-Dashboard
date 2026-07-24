# Context — state, quirks & gotchas

_Living document. Update as the project evolves._

## Current state (2026-07-16)

- Full production scaffold built from the `mshauri-dashboard` reference
  architecture: backend, frontend, k8s, CI, docs.
- **BC5 BigQuery feed is NOT live.** Table constants in `app/core/tables.py` are
  intended names under `gold_eba` (marts) and `silver_eba` (row-level) with
  `# TODO: confirm real table name when feed lands` markers. Data endpoints return
  a BigQuery 404 until those tables exist — expected, not a bug.
- Backend test suite is green (35 tests) using a mocked `run_query`; the frontend
  builds and lints clean.

## Deliberate quirks

- **No analytics chat.** Unlike the reference, this project has no in-cluster bot,
  so there is no `chat.py`, no `/api/chat/*`, and no chat widget. (See DECISION.md.)
- **PII is masked, not dropped.** The prototype carries youth names + demographics,
  and named mobilisers/trainers. `app/core/pii.py` masks personal names to initials
  for the guest role and pseudonymises youth identifiers (HMAC-SHA256 keyed by
  `EBA_ID_SALT`); raw phone numbers / ids never appear in an API response.
- **Product vs data-layer naming.** UI/docs say "E!BA Dashboard"; the data layer uses a
  neutral `eba_` prefix (tables, image names, `X-EBA-Client` header, `eba_*`
  sessionStorage keys). Do not rename data-layer identifiers to match UI copy.
- **Windows dev:** `uvicorn --reload` is unstable — run without it. Vite prefers
  `.env.local` over `.env`; never create `frontend/.env`.

## Single-process invariant (operational constraint)

The query cache (`app/core/cache.py`) is an in-memory, process-local `TTLCache`.
The backend runs `replicas: 1` and a single uvicorn process. **Do not scale up or
add `--workers`** without moving the cache to a shared store (Redis) — a second
process would never see the first's cache entries. Pod restart is the recovery
path (acceptable for an internal pilot).

## Accepted v1 limitations

- Shared guest password (not per-user).
- JWT stored in `sessionStorage` (not an httpOnly cookie).
- `JWT_SECRET` doubles as the Starlette OAuth session key.
- No per-row authorization — every authenticated user sees the full cohort.

## When the data feed lands

1. Confirm real dataset/table names in `app/core/tables.py`.
2. Confirm the column names used in each `app/routers/*.py` query match the schema
   (`stage`, `youth_count`, `district`, `gender`, `cohort`, `venue`, `is_test_data`,
   the `MOBILISER_PERF`/`TRAINER_QUALITY` name columns, etc.).
3. Confirm `PROGRAM_START_DATE` (BC5 Week 1) in `tables.py`.
4. Point `GOOGLE_SERVICE_ACCOUNT_KEY` at a key with BigQuery Data Viewer + Job User.
