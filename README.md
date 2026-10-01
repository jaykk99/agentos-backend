# AgentOS Backend

Agent identity backend deployed on Vercel — every AI agent that operates in
error-inbox (or any other app) gets a real identity here, reachable as a
plain REST API or as an MCP server.

## Features
- Machine-to-Machine Agent Auth (Token Generation & Revocation)
- Agent CRUD Directory (Signup, Signin, Verify, Connect, Platforms, List, Revoke)
- Shared Supabase-backed persistence (falls back to in-memory for local dev)
- Real web browsing (plain fetch + HTML-to-text) and search (DuckDuckGo HTML,
  no API key needed) for agents
- The same operations exposed three ways: REST, an action-style bridge (for
  error-inbox's existing client), and MCP (stdio or HTTP)
- Target Site Pre-Flight Recon Scanner, Playwright Headless Browser Worker,
  1SecMail Ingestion (legacy — see note below)

## Deploy
```bash
npm install -g vercel
vercel
```

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the Vercel project's
env vars and run `supabase/schema.sql` once in that project's SQL editor, so
the REST API, the action bridge, and the MCP server all see the same agent
directory. Without those set, identities only live in that instance's memory.

## Owner-level identity (optional)

`lib/identity.js` can resolve a fixed "master-orchestrator" identity for
`signin`/`verify`/`connect`/`platforms`, meant for error-inbox's own
orchestrator process to identify itself without signing up like a normal
agent. This used to be a hardcoded literal (`'999'`) checked directly in
source and documented here — a skeleton key anyone reading either file could
use. It is not hardcoded anymore: set `AGENTOS_MASTER_KEY` in the environment
to a real secret (e.g. `openssl rand -hex 32`) to enable it; comparisons are
constant-time. Leave it unset and this identity is unreachable by any key —
there is no default value.

## REST API
- `POST /api/v1/agents/signup` - Create agent identity `{ handle, objective? }`
- `POST /api/v1/agents/signin` - Authenticate agent `{ apiKey }`
- `POST /api/v1/agents/verify` - Quick validity check `{ apiKey }`
- `POST /api/v1/agents/connect` - Link agent to an app `{ apiKey, appName }`
- `POST /api/v1/agents/platforms` - List an agent's connected apps `{ apiKey }`
- `GET /api/v1/agents` - List all agents
- `DELETE /api/v1/agents/:agentId` - Revoke agent
- `POST /api/v1/browse` - Fetch a URL, return title + readable text `{ url }`
- `POST /api/v1/search` - Web search, no API key needed `{ query, limit? }`
- `POST /api/v1/recon/scan` - Scan target site (requires auth)
- `POST /api/v1/browser/execute` - Headless browser execution (requires auth)
- `GET/POST /api/v1/settings` - Global settings

## Action-style bridge
`POST /api/agentos` with `{ action, ...payload }`, where `action` is one of
`signup`, `signin`, `verify`, `connect`, `platforms`, `revoke`, `list`. This
is what error-inbox's `lib/agentos.ts` speaks — point its `AGENTOS_URL` at
`https://<this-deployment>/api/agentos`.

## MCP

Tools: `agent_signup`, `agent_signin`, `agent_verify`, `agent_connect_app`,
`agent_platforms`, `agent_list`, `agent_revoke`, `agent_browse`, `agent_search`.

**Remote (HTTP)** — add this deployment directly as a remote MCP server:
```
https://<this-deployment>/api/mcp
```

**Local (stdio)** — for clients that only support local MCP servers:
```bash
claude mcp add agentos -- node /path/to/agentos-backend/bin/mcp-stdio.js
```
Set `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` in that shell so the stdio
process shares the same directory as the deployed REST API.

## Note on the recon/browser endpoints
`POST /api/v1/recon/scan` and `POST /api/v1/browser/execute` fingerprint a
target site's bot defenses and drive a headless browser to complete signup
flows automatically, including intercepting email OTPs. They predate this
identity work and are unrelated to it — they are not wired into the MCP
server, and extending them is out of scope here. Playwright also requires a
long-running server with Chromium installed; on Vercel serverless it falls
back to a simulated mode, so real use needs Railway, Render, or a VPS with
`npx playwright install chromium`.
