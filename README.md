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
