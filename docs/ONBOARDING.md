# Onboarding — Take Off Recruitment Dashboard

Welcome. This is the orientation map. Read the docs in this order:

1. **ONBOARDING.md** (this file) — what the project is + how to get running.
2. **CONTEXT.md** — living project state, quirks, and gotchas. Read before coding.
3. **ARCHITECTURE.md** — component map, request path, API surface.
4. **DECISION.md** — the "why" behind the non-obvious choices (ADRs).
5. **FLOW.md** — step-by-step runtime traces.
6. **../README.md** — local setup, env vars, metric definitions.
7. **../CLAUDE.md** — the non-negotiable conventions.

## In one paragraph

A two-container, read-only dashboard over BigQuery showing Educate!'s E!BA
"Take Off" recruitment funnel for Bootcamp 5 in the Busoga region: Awareness →
Mobilisation → Acquisition, plus Implementation (attendance, retention, trainer
quality, NPS) and Field Operations (meals, venue, transport). FastAPI backend +
React/Vite SPA, JWT auth (staff Google SSO + guest password), deployed to
DigitalOcean Kubernetes via digest-pinned GitHub Actions.

## Quick start

See **../README.md** → "Local development". TL;DR: create `backend/.env` from
`.env.example`, `uvicorn app.main:app --port 8000`, then `npm run dev` in
`frontend/` with `VITE_API_URL=http://localhost:8000` in `.env.local`.

## The one thing to know first

The **BC5 BigQuery feed is not live yet**. The backend queries placeholder tables
under `gold_eba` / `silver_eba` (`app/core/tables.py`) that don't exist yet, so
data endpoints 404 and the UI shows empty/error states. Everything else — auth,
the header guard, caching, PII masking, the whole request path — works today and
is exercised by the test suite. When the feed lands, confirm the real table names
in `tables.py` and the column names in the router SQL. The prototype at
`reference/prototype-index.html` is the source-of-truth for what each view should
show and what data backs it.
