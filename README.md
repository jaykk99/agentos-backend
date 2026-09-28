# AgentOS Backend

Autonomous headless-browser + agent orchestration backend: provision agent
identities (`agk_...` keys), scan targets with a pre-flight recon pass, pull
OTP codes from real 1SecMail inboxes, and run Playwright signup flows.

Runs **keyless out of the box** — no API keys required for any endpoint.
Browser automation uses the `playwright` optional dependency when installed;
without it, `/api/v1/browser/execute` returns an honest placeholder session
(`simulated: true`) instead of fabricated results.

## Run it

```bash
npm install
node lib/app.js        # PORT env var, default 3000
```

Deploy on Vercel: `api/[...slug].js` and `api/index.js` both export the same
Express app (`vercel.json` rewrites `/` and `/health` to it).

## Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| POST | `/api/v1/agents/signup` | — | Provision an agent identity. Body: `{ handle, objective? }`. Returns `agentId` + one-time `agk_...` key. |
| POST | `/api/v1/agents/signin` | — | Verify a key. Body: `{ apiKey }`. |
| GET | `/api/v1/agents` | admin* | List registered agents (handles only, keys never listed). |
| DELETE | `/api/v1/agents/:agentId` | admin* | Revoke an agent. |
| POST | `/api/v1/recon/scan` | agent | Pre-flight scan of a target URL: status, WAF detection (Cloudflare/Akamai), CAPTCHA assessment. Body: `{ targetUrl }`. |
| POST | `/api/v1/browser/execute` | agent | Full flow: provision a real 1SecMail mailbox, drive a headless Chromium signup, poll the inbox for the OTP, submit it, persist the session. Body: `{ targetUrl, selectors? }`. |
| GET/POST | `/api/v1/settings` | admin* | Poll tuning (`pollIntervalMs`, `pollMaxRetries`, `autoSubmitOtp`, `proxyUrl`, `userAgent`). |
| GET | `/health` | — | Liveness + counts. |

Agent auth: `Authorization: Bearer <agk_...>`.

\* **Admin endpoints are open by default** (keyless-first). Set `ADMIN_KEY` in
the environment (see `.env.example`) to require
`Authorization: Bearer <ADMIN_KEY>` (or `x-admin-key:`) on them.

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
