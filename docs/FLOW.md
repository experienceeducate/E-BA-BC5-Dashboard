# Runtime flows

Step-by-step traces of the important paths.

## 1. Guest login → authenticated request

1. Browser loads the SPA; `App` finds no token in `sessionStorage` → renders
   `LoginScreen`.
2. User submits the guest password → `POST /api/auth/login`
   (`{Content-Type, X-EBA-Client}`, body `{password}`).
3. The `X-EBA-Client` middleware passes (header present + correct). `auth.guest_login`
   compares against `DASHBOARD_PASSWORD`; on match returns a JWT
   (`role: "guest"`, 8h expiry, HS256).
4. SPA saves the token to `sessionStorage` (`eba_token`), fetches `/api/auth/me`
   with `Authorization: Bearer <jwt>` + `X-EBA-Client`, then loads `/api/filters`.
5. Every tab's `useApi(endpoint)` sends the same two headers. A `401` triggers
   `logout()` (clear token + reload).

## 2. Staff Google SSO

1. User clicks "Sign in with Google" → `GET /api/auth/google/login` (exempt from
   the header guard). authlib redirects to Google.
2. Google redirects back to `/api/auth/google/callback` (also exempt). authlib
   exchanges the code; the backend checks `email_verified` AND
   `email endswith @experienceeducate.org`, else 403.
3. On success the backend issues a staff JWT and `RedirectResponse` to
   `FRONTEND_URL/#token=<jwt>` (token in the URL **fragment**, so it isn't logged).
4. `consumeOAuthHash()` reads the fragment, stores the token, strips the hash.

## 3. A data request (e.g. the funnel)

1. `ExecutiveSummary` calls `useApi("/api/overview/funnel?district=BUGIRI&cohort=BC5")`.
2. Middleware validates `X-EBA-Client`; `current_user` validates the JWT.
3. The router builds a WHERE clause via `build_where(districts=..., extra=[NOT_TEST_DATA, cohort])`
   — user values become BigQuery `ScalarQueryParameter`/`ArrayQueryParameter`, never
   f-strings — then calls `database.run_query(sql, params, role=user.role)`.
4. `run_query` checks the `TTLCache` keyed by `(role, sql, params)`. Miss → build the
   BigQuery client, run the parameterised job, ISO-format dates, cache, return.
5. The router reshapes rows (orders stages, computes % of previous / lost) → JSON.
6. `useApi` sets state; recharts renders. **Today**, step 4 raises a BigQuery 404
   (tables not live) → the router 500s → `useApi` sets `error` → the card shows the
   "data unavailable" state.

## 4. PII masking (personas / mobilisers / trainers)

1. Router selects rows including `name` and (for personas) `phone_number`.
2. Before serialising: `phone_number` is popped and replaced by
   `pii.youth_id(phone_number)` (HMAC pseudonym); `name` is passed through
   `pii.mask_name(user.role, name)` → full for staff, initials for guest.
3. The response never contains the raw phone/id. (Enforced by `tests/test_security.py`.)

## 5. Deploy

1. Push to `main` → `deploy.yml`. `paths-filter` decides backend/frontend changed.
2. Backend changed → `test-backend` (pytest gate) must pass → `build-backend`
   builds & pushes `eba-dashboard-server:{latest,<sha>}`, outputs the digest.
3. `deploy` job saves kubeconfig, runs `kubectl set image deployment/eba-dashboard-*
   ...@sha256:<digest>` and `rollout status`. PRs never build or deploy.
4. Editing `k8s/**` requires a manual `kubectl apply`; applying resets the image to
   `:latest`, so re-run the workflow afterward to re-pin the digest.
