# AgentOS Backend

Agent identity backend deployed on Vercel — every AI agent that operates in
error-inbox (or any other app) gets a real identity here, reachable as a
plain REST API or as an MCP server.

## Features
- Machine-to-Machine Agent Auth (Token Generation & Revocation)
- Agent CRUD Directory (Signup, Signin, Verify, Connect, Platforms, List, Revoke)
- Shared Supabase-backed persistence (falls back to in-memory for local dev)
- The same identity operations exposed three ways: REST, an action-style
  bridge (for error-inbox's existing client), and MCP (stdio or HTTP)
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

## REST API
- `POST /api/v1/agents/signup` - Create agent identity `{ handle, objective? }`
- `POST /api/v1/agents/signin` - Authenticate agent `{ apiKey }`
- `POST /api/v1/agents/verify` - Quick validity check `{ apiKey }`
- `POST /api/v1/agents/connect` - Link agent to an app `{ apiKey, appName }`
- `POST /api/v1/agents/platforms` - List an agent's connected apps `{ apiKey }`
- `GET /api/v1/agents` - List all agents
- `DELETE /api/v1/agents/:agentId` - Revoke agent
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
`agent_platforms`, `agent_list`, `agent_revoke`.

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
