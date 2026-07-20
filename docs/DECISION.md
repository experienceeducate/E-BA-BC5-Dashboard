# Decision records (ADRs)

Short records of the non-obvious choices. Newest first.

## ADR-007 — Scaffold the backend ahead of the live data feed
The BC5 BigQuery tables don't exist yet. Rather than wait, the backend is built
with placeholder table constants and real parameterised query shapes so it's
ready to wire up when the feed lands. **Consequence:** data endpoints 404 until
the tables exist; the UI renders empty/error states. Table/column names in
`core/tables.py` and `routers/*` are best-guesses to confirm against the real schema.

## ADR-006 — Keep PII, mask it server-side
The prototype carries re-identifiable data (youth names + village + demographics;
named mobilisers and trainers). We mask personal names to initials for the guest
role and pseudonymise youth identifiers with HMAC-SHA256 (`core/pii.py`), rather
than dropping the data or exposing it to every authenticated user. Raw phone
numbers / ids never appear in a response. **Trade-off:** `EBA_ID_SALT` becomes a
secret to guard as carefully as `JWT_SECRET`.

## ADR-005 — Drop the analytics chat widget
The reference proxies an in-cluster analytics bot. This project has no such bot, so
`chat.py`, `/api/chat/*`, and the widget are omitted entirely. If one is added
later, port the reference's staff-only, server-side-key, server-derived-conversation-id
pattern — and note it reintroduces an in-memory job store (another single-process reason).

## ADR-004 — Single-file `App.jsx`, no router, no CSS framework
Inline styles and React tab-state (no react-router) keep the SPA dependency-light
and match the reference. Revisit (split files / add a router) only when scope
clearly demands it, and record the trigger here.

## ADR-003 — Two-layer request floor: CORS + `X-EBA-Client` header guard
Browsers from other origins are blocked by CORS; non-browser callers bypass CORS
but are blocked by the custom-header middleware. Neither is real auth (that's the
JWT) — they raise the floor against casual abuse. OAuth callback paths are exempt
because browsers don't send custom headers on cross-site redirects.

## ADR-002 — Single process / in-memory cache
The query cache is a process-local `TTLCache`; the backend runs one replica / one
uvicorn process. Simplest thing that works for an internal pilot. Scaling requires
moving the cache to Redis first — do not add replicas or `--workers` before then.

## ADR-001 — Accepted v1 auth limitations
Shared guest password; JWT in `sessionStorage` (not an httpOnly cookie);
`JWT_SECRET` doubles as the OAuth session key; no per-row authorization. All
acceptable for an internal pilot; documented so they're not silently inherited.
Revisit before any external/wider rollout.
