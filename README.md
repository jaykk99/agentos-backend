# AgentOS Backend

Autonomous Headless Browser & Agent Orchestration Backend deployed on Vercel.

## Features
- Machine-to-Machine Agent Auth (Token Generation & Revocation)
- Agent CRUD Directory (Signup, Signin, Delete)
- Target Site Pre-Flight Recon Scanner
- Playwright Headless Browser Worker Engine (with graceful fallback)
- Real 1SecMail API Ingestion & Regex OTP Extraction
- Cookie & Session Token Persistence

## Deploy
```bash
npm install -g vercel
vercel
```

## API Endpoints
- `POST /api/v1/agents/signup` - Create agent identity
- `POST /api/v1/agents/signin` - Authenticate agent
- `GET /api/v1/agents` - List all agents
- `DELETE /api/v1/agents/:agentId` - Revoke agent
- `POST /api/v1/recon/scan` - Scan target site (requires auth)
- `POST /api/v1/browser/execute` - Headless browser execution (requires auth)
- `GET/POST /api/v1/settings` - Global settings

## Note
Playwright requires a long-running server with Chromium installed. On Vercel serverless,
the browser engine falls back to a simulated mode. For full browser automation, deploy
on Railway, Render, or a VPS with `npx playwright install chromium`.

## Agent API keys

`POST /api/v1/agents/signup` returns an `agk_...` key. The key is **self-describing
and HMAC-signed**, not an opaque random string looked up in process memory:

```
agk_<base64url(claims)>.<base64url(HMAC-SHA256(claims, AGENTOS_SIGNING_SECRET))>
```

Any instance can verify a key offline, which is what makes the key usable on
Vercel at all — signup and the next request routinely land on different lambda
instances, and the previous in-memory `Map` lookup meant a key came back `403
Invalid, expired, or deleted` seconds after being issued.

### Required configuration

```bash
AGENTOS_SIGNING_SECRET=<a long random string>   # e.g. openssl rand -hex 32
```

If it is unset the server falls back to a per-process secret and logs a warning;
keys then only work on the instance that issued them. Rotating the secret
invalidates every outstanding key.

### Verify a key

- `POST /api/v1/agents/signin` with `{ "apiKey": "agk_..." }`
- `GET /api/v1/agents/me` with `Authorization: Bearer agk_...`

### Revocation caveat

`DELETE /api/v1/agents/:agentId` records the revocation in memory, so it applies
to the instance that handled it and to warm instances only. Durable revocation
needs a shared store (Redis/Postgres); until then, rotate
`AGENTOS_SIGNING_SECRET` to invalidate all keys at once.
