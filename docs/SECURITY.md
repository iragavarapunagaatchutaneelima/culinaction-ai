# Security

## Authentication and sessions

- **Real Mode**: username + password (scrypt, 16-byte salt). The first account can only be created while no real users exist; further users are added by an outlet owner.
- Sessions: 32-byte random token in an `HttpOnly; SameSite=Strict` cookie (`ca_session`); only its SHA-256 hash is stored. `Secure` is added when `COOKIE_SECURE=1` (always on in the Vercel entry point).
- **Demo Mode** uses a separate cookie (`ca_demo`) selected per request by the `X-CulinAction-Mode: demo` header (or `?mode=demo` on GET downloads). A demo cookie can only resolve to a demo user, and a real cookie only to a real user — the server checks the user's `is_demo` flag on every request.
- Demo users cannot sign in with a password, create real outlets, manage team members or delete outlets (`requireRealUser`). Demo sessions expire after 24 hours; expired demo users and their outlets are purged; at most 300 demo sandboxes exist at once.
- Sign-in throttle: 5 failures per username per 5 minutes (in memory — per server instance; weaker on serverless, see limitations).

## Authorisation and isolation

- Every outlet-scoped route runs `outletAccess`: the user must be a member of the outlet, otherwise **404** (no information about other outlets is revealed).
- Roles are enforced on the server for every mutating route (`requireRole`): staff can record use, waste, outcomes and order events and complete tasks; managers maintain records and plans; approvals follow the outlet's `managers_can_approve` rule.
- Demo outlets are flagged `is_illustrative = 1` and owned only by a demo user. Demo reset deletes only outlets that are illustrative **and** owned by that demo user. Scenario triggers require both a demo session and an illustrative outlet.
- Tested: cross-outlet access (404), staff restrictions (403), demo/real separation, reset isolation, demo users blocked from real-only actions.

## Request handling

- **CSRF**: `SameSite=Strict` cookies plus a required custom header (`X-CulinAction: 1`) on every non-GET request. CORS is not enabled, so cross-site scripts cannot add the header.
- **Validation**: every request body is validated with Zod; unit conversions are checked; dates/times validated; numeric ranges bounded.
- **SQL injection**: all queries use bound parameters. Dynamic `IN (…)` lists are built from server-side integer ids only.
- **XSS**: React escapes all output; no `dangerouslySetInnerHTML`.
- **Limits**: JSON bodies ≤ 1.5 MB; CSV imports ≤ 1 MB, ≤ 5 000 sales rows / 3 000 order rows.
- **CSV exports** prefix cells starting with `= + - @ tab CR` with `'` (formula-injection protection).
- **Errors**: unexpected errors return a generic message; stack traces are logged on the server only.
- Headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`; API responses are `Cache-Control: no-store`; the service worker never caches `/api/`.

## Secrets

- Secrets come only from environment variables (`ANTHROPIC_API_KEY`, `TURSO_AUTH_TOKEN`). `.env` is git-ignored; `.env.example` has empty placeholders.
- The AI key is used only on the server; the provider uses an explicit base URL so an unrelated `ANTHROPIC_BASE_URL` is never picked up. Keys are never stored in the database or sent to the browser.
- Before each push the staged files were scanned for key/token patterns (`sk-ant-`, `gho_`, `ghp_`, JWTs) and for `.env`, database files and build output.

## Audit

Every create/update/delete, plan transition, task completion, order event, AI explanation request and demo scenario trigger writes an `audit_events` row (who, what, when, details).

## Known limitations

- Single-region deployment; no password reset by email; no 2FA.
- The in-memory sign-in throttle and demo cap are per server instance (on Vercel, per warm function instance).
- No automated dependency-vulnerability scanning beyond `npm install`'s audit summary (0 vulnerabilities reported at time of writing).
