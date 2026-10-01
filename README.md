# AgentOS Backend

Autonomous headless-browser + agent orchestration backend: provision agent
identities (`agk_...` keys), scan targets with a pre-flight recon pass, pull
OTP codes from real 1SecMail inboxes, and run Playwright signup flows.

Runs **keyless out of the box** — no API keys required for any endpoint.
Browser automation needs the `playwright` optional dependency **plus**
`npx playwright install chromium`; without a usable browser,
`/api/v1/browser/execute` returns an honest placeholder session
(`simulated: true`) instead of fabricated results.

## Run it

```bash
npm install
npm start            # PORT env var, default 3000
npm test             # 33-check smoke suite (spawns real servers)
```

Open **http://localhost:3000/dashboard** for the web UI: live service stats,
an endpoint explorer, and a try-it console (provision keys, call recon,
inspect responses).

Deploy on Vercel: `api/[...slug].js` and `api/index.js` both export the same
Express app (`vercel.json` rewrites `/`, `/health`, and `/dashboard` to it).

## Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| POST | `/api/v1/agents/signup` | — (rate-limited) | Provision an agent identity. Body: `{ handle, objective? }`. Returns `agentId` + one-time `agk_...` key + `expiresAt`. |
| POST | `/api/v1/agents/signin` | — (rate-limited) | Verify a key. Body: `{ apiKey }`. |
| GET | `/api/v1/agents` | admin* | List registered agents (handles only, keys never listed). |
| DELETE | `/api/v1/agents/:agentId` | admin* | Revoke an agent. |
| POST | `/api/v1/recon/scan` | agent | Pre-flight scan of a target URL: status, WAF detection (Cloudflare/Akamai), CAPTCHA assessment. Body: `{ targetUrl }`. SSRF-guarded (no private/loopback targets). |
| POST | `/api/v1/browser/execute` | agent | Full flow: provision a real 1SecMail mailbox, drive a headless Chromium signup, poll the inbox for the OTP, submit it, persist the session. Body: `{ targetUrl, selectors? }`. |
| GET/POST | `/api/v1/settings` | admin* | Poll tuning (`pollIntervalMs`, `pollMaxRetries`, `autoSubmitOtp`, `proxyUrl`, `userAgent`) — all range/type validated. |
| GET | `/api/status` | — | Honest capability report: real-browser available?, admin gate on?, rate limits, counts, memory, recent issues. |
| GET | `/health` | — | Liveness + counts. |
| GET | `/dashboard` | — | Web UI: status, endpoint explorer, try-it console. |

Agent auth: `Authorization: Bearer <agk_...>`.

\* **Admin endpoints are open by default** (keyless-first). Set `ADMIN_KEY` in
the environment (see `.env.example`) to require
`Authorization: Bearer <ADMIN_KEY>` (or `x-admin-key: <ADMIN_KEY>`) on them.
The comparison is constant-time.

## Security notes

- **Rate limiting** (per IP, in-process, no extra deps): 300 req/60s globally,
  30 req/10min on the credential-bearing `/agents/signup` + `/agents/signin`,
  120 req/60s on admin routes. All tunable via env (see `.env.example`).
- **Agent keys expire**: `AGENT_KEY_TTL_DAYS` (default 90). Expired keys get
  401 and are pruned. Registry is capped at `MAX_AGENTS` (default 10000).
- **SSRF guard**: `targetUrl` must be http/https, ≤2048 chars, not a
  private/loopback literal IP, and must not DNS-resolve to one. Recon fetches
  time out after `RECON_TIMEOUT_MS` (default 10s).
- **Validation**: handles 1–64 chars, objectives ≤280 chars, settings fields
  range-checked, JSON bodies capped at 100kb (413 beyond).
- **Errors are structured** — `{ status: "error", error, message, requestId }` —
  and never leak stacks. Every response carries `X-Request-Id`.
- Logs are JSON lines on stdout (method/path/status/ms per request); the last
  few warn/error events are surfaced sanitized via `/api/status`.

## Design notes

- State is in-memory: agent registry and sessions reset on redeploy/restart.
  Treat this as an ephemeral worker, not a database.
- Sites that challenge automation (CAPTCHA, Cloudflare interstitials,
  JS-only challenges) are reported as-is — no solving, no anti-bot evasion,
  by design. Everything else is real: real mailboxes, real form posts,
  real sessions.
- Nothing here requires a third-party API key. 1SecMail's public API is
  free and keyless; set `ADMIN_KEY` only if you want the admin gate.

## Deploy

```bash
npm install -g vercel
vercel
```
