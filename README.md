# E!BA Dashboard

Executive dashboard for Educate!'s **E!BA** recruitment funnel
(Bootcamp 5, Busoga region, Uganda). Two containers over BigQuery:

- **Backend** — FastAPI (Python 3.14), BigQuery via service account, JWT auth
  (Google SSO for staff + shared password for guests), a custom `X-EBA-Client`
  header guard, a 5-minute query cache, and server-side PII masking.
- **Frontend** — React 19 + Vite SPA (recharts), served by nginx. Single-file
  `App.jsx`, inline styles, no router.

> **Status:** the BC5 BigQuery feed is **not live yet**. The backend is fully
> scaffolded with placeholder table constants + real, parameterised query shapes
> (`app/core/tables.py`, `app/routers/*`). Until the `gold_eba` / `silver_eba`
> tables exist, `/api/*` data endpoints return a BigQuery 404 and the UI shows
> graceful empty/error states — by design. The original static prototype is kept
> at `reference/prototype-index.html` as the data + visual spec.

## Local development (Windows / PowerShell)

Two terminals. `uvicorn --reload` is unstable on Windows — run without it and
restart manually.

```powershell
# Terminal 1 — backend
cd backend; python -m venv venv; venv\Scripts\Activate.ps1
pip install -r requirements.txt -r requirements-dev.txt
copy .env.example .env   # then fill DASHBOARD_PASSWORD, JWT_SECRET, EBA_ID_SALT
uvicorn app.main:app --port 8000

# Terminal 2 — frontend
cd frontend; npm install
"VITE_API_URL=http://localhost:8000" | Out-File -Encoding ascii .env.local
npm run dev
```

Smoke test: `curl http://localhost:8000/health`, open `http://localhost:3000`,
backend docs at `http://localhost:8000/docs`. Generate secrets with
`python -c "import secrets; print(secrets.token_hex(32))"`.

> **Env-file footgun:** Vite prefers `.env.local` over `.env`. Do **not** create
> `frontend/.env` — a stale one has previously made local dev silently hit prod.

Run the backend tests (no live BigQuery needed — `run_query` is mocked):

```powershell
cd backend; venv\Scripts\Activate.ps1; pytest --cov=app
```

## Required backend env (`backend/.env`)

| Var | Required | Notes |
|---|---|---|
| `JWT_SECRET` | ✅ | HS256 signing key; also the OAuth session key |
| `DASHBOARD_PASSWORD` | ✅ | shared guest password |
| `EBA_ID_SALT` | ✅ | HMAC salt for youth pseudonyms — guard like `JWT_SECRET` |
| `EBA_CLIENT_TOKEN` | | client-header token (default `eba-dashboard-v1`) |
| `BQ_PROJECT_ID` / `BQ_DATASET` / `BQ_TABLE` | | default to `educate-data-warehouse-test` / `gold_eba` / `eba_recruitment_funnel` |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | | path to SA JSON (BigQuery) |
| `GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI` | | Google SSO; optional locally (guest works without) |
| `OAUTH_ALLOWED_DOMAIN` | | default `experienceeducate.org` |
| `FRONTEND_URL` | | OAuth callback redirect target |

## Metric definitions

See `docs/metrics.yaml` for the funnel stages and conversion-rate definitions
(eligibility / mobilisation / acquisition / activation / retention), plus the
60% female target and the activation/retention targets.

## Architecture & deployment

See `docs/ARCHITECTURE.md` (structure, API surface), `docs/DECISION.md` (why),
`docs/CONTEXT.md` (state & quirks), `docs/FLOW.md` (runtime traces), and
`CLAUDE.md` (conventions). Deploys to DigitalOcean Kubernetes via digest-pinned
GitHub Actions; k8s manifests under `k8s/**` are applied manually.
