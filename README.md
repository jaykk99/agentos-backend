# AgentOS Backend

Autonomous agent identity + real browser/email automation, served as a standard **MCP server** and REST bridge.

## 🔌 MCP Endpoint (redirect)

The AgentOS MCP server lives on the error-inbox deployment:

```
https://error-inbox.vercel.app/api/mcp
```

Standard **MCP Streamable HTTP** (JSON-RPC 2.0, protocol `2025-03-26`). Per-call auth via the `apiKey` argument — a real `agk_...` agent key, or the universal master code `999` (authenticates as `monico-orchestrator`).

Point any MCP client (Claude, Cursor, Monico Agent, etc.) at the URL above.

## Tools (15)

| Tool | What it does (all REAL, no simulation) |
|---|---|
| `agentos_signup` | Create a persistent agent identity — returns `agentId` + one-time `agk_` key |
| `agentos_signin` | Authenticate with an `agk_` key or master code `999` |
| `agentos_verify` | Lightweight key validity check |
| `agentos_platforms` | List which platforms an agent's key can talk to |
| `agentos_connect_app` | Register a platform so agk_ keys work across it |
| `agentos_recon` | Live pre-flight scan of a target URL — WAF detection (Cloudflare/Akamai), CAPTCHA assessment, form parsing |
| `agentos_mailbox` | Provision a **real** Guerrilla Mail inbox |
| `agentos_poll_otp` | Poll that inbox for OTP/verification codes |
| `agentos_onboarding` | Full no-browser onboarding: recon → real mailbox → real HTTP form POST → session persisted |
| `agentos_browser_run` | REAL headless Chromium (serverless) signup run — honest failure on CAPTCHAs, no evasion |
| `agentos_browser_screenshot` | Navigate + full-page screenshot proof |
| `agentos_browser_signin` | Sign in to any site with real credentials (handles Google-style two-step flows) |
| `agentos_browser_signup` | Sign up on any site (caller credentials or auto-provisioned mailbox) |
| `agentos_sessions` | List persisted automation sessions |
| `agentos_settings` | Per-agent persistent key/value settings |

## Architecture

- **Identity DB of record**: central AgentOS Base44 backend (AgentIdentity, AutomationSession, AgentosSetting entities) — identities survive restarts.
- **MCP server**: `app/api/mcp/route.ts` on error-inbox (this repo's original Express app was superseded).
- **REST bridge**: `POST /api/agentos` with `{ action, apiKey }` — actions: signup, signin, verify, connect, platforms, recon, mailbox, poll-otp, onboarding, sessions, settings, browser (`signin`/`signup`), revoke/list/sync-registry (admin, CRON_SECRET, or master key).
- **Browser runtime**: real serverless Chromium (`playwright-core` + `@sparticuz/chromium-min`).

## Honest-failure design

Sites that challenge automation (CAPTCHA, Cloudflare interstitials, JS-only challenges) are reported as-is — no solving, no anti-bot evasion, by design. Everything else is real: real mailboxes, real form posts, real sessions, real screenshots.

## Deploy
```bash
npm install -g vercel
vercel
```
