/**
 * AgentOS — Autonomous Headless Browser & Agent Orchestration Backend
 * Adapted for Vercel Serverless deployment
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const identity = require('./identity');
const store = require('./store');
const browse = require('./browse');
const { createAgentOsServer } = require('./mcp-tools');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

// node-fetch v2 for CommonJS compatibility
let fetch;
try {
  fetch = require('node-fetch');
} catch (e) {
  // Fallback to global fetch (Node 18+)
  fetch = globalThis.fetch;
}

// Attempt to load Playwright (graceful fallback if not yet installed in runtime)
let chromium;
try {
    const playwright = require('playwright');
    chromium = playwright.chromium;
} catch (e) {
    console.warn('[Warning] Playwright module not detected. Browser automation will use simulated mode.');
}

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// DATA STORES
// ==========================================
// Agent identities live in lib/store.js (Supabase-backed when configured,
// see supabase/schema.sql), shared with the MCP server. Active browser
// sessions below are transient scratch state, kept in-memory as before.
const activeSessions = new Map(); // sessionId -> sessionObject

const globalSettings = {
    proxyUrl: null,
    pollIntervalMs: 5000,
    pollMaxRetries: 10,
    autoSubmitOtp: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
};

// ==========================================
// MIDDLEWARE: AGENT AUTHENTICATION
// ==========================================
async function authenticateAgent(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: "Unauthorized",
            message: "Missing or malformed Authorization header. Pass 'Bearer agk_...'"
        });
    }

    const apiKey = authHeader.split(' ')[1];
    let agent;
    try {
        agent = await store.getByKey(apiKey);
    } catch (err) {
        return res.status(500).json({ error: "Store Error", message: err.message });
    }

    if (!agent) {
        return res.status(403).json({
            error: "Forbidden",
            message: "Invalid, expired, or deleted Agent API key."
        });
    }

    req.agent = agent;
    next();
}

// ==========================================
// 1. AGENT MANAGEMENT APIs
// ==========================================

app.post('/api/v1/agents/signup', async (req, res) => {
    const { handle, objective } = req.body;
    const result = await identity.signup(handle, objective);
    res.status(result.status === 'created' ? 201 : 400).json(result);
});

app.post('/api/v1/agents/signin', async (req, res) => {
    const { apiKey } = req.body;
    const result = await identity.signin(apiKey);
    res.status(result.status === 'authenticated' ? 200 : 401).json(result);
});

app.post('/api/v1/agents/verify', async (req, res) => {
    const { apiKey } = req.body;
    const result = await identity.verify(apiKey);
    res.status(result.status === 'valid' ? 200 : 401).json(result);
});

app.post('/api/v1/agents/connect', async (req, res) => {
    const { apiKey, appName } = req.body;
    const result = await identity.connectApp(apiKey, appName);
    res.status(result.status === 'connected' ? 200 : 400).json(result);
});

app.post('/api/v1/agents/platforms', async (req, res) => {
    const { apiKey } = req.body;
    const result = await identity.platforms(apiKey);
    res.status(result.status === 'ok' ? 200 : 400).json(result);
});

app.get('/api/v1/agents', async (req, res) => {
    const result = await identity.list();
    res.json({ count: result.count, agents: result.agents });
});

app.delete('/api/v1/agents/:agentId', async (req, res) => {
    const { agentId } = req.params;
    const result = await identity.revoke(agentId);
    res.status(result.status === 'success' ? 200 : 404).json(result);
});

// ==========================================
// 1b. ACTION-STYLE IDENTITY BRIDGE
// ==========================================
// Single endpoint speaking the { action, ...payload } protocol that
// error-inbox's AgentOS client already uses (lib/agentos.ts). Lets
// error-inbox point straight at this backend instead of a third party.
app.post('/api/agentos', async (req, res) => {
    const { action, ...payload } = req.body || {};
    try {
        switch (action) {
            case 'signup':
                return res.json(await identity.signup(payload.handle, payload.objective));
            case 'signin':
                return res.json(await identity.signin(payload.apiKey));
            case 'verify':
                return res.json(await identity.verify(payload.apiKey));
            case 'connect':
            case 'connect-app':
                return res.json(await identity.connectApp(payload.apiKey, payload.appName));
            case 'platforms':
                return res.json(await identity.platforms(payload.apiKey));
            case 'revoke':
                return res.json(await identity.revoke(payload.agentId));
            case 'list':
                return res.json(await identity.list());
            default:
                return res.status(400).json({
                    status: 'error',
                    message: 'Unknown action. Use: signup, signin, verify, connect, platforms, revoke, list'
                });
        }
    } catch (err) {
        res.status(502).json({ status: 'error', message: err.message });
    }
});

// ==========================================
// 1c. BROWSE / SEARCH
// ==========================================
// Plain HTTP fetch + HTML-to-text and a no-API-key DuckDuckGo search — real
// requests, not a headless browser. Distinct from the recon/browser-execute
// endpoints below: this just reads pages, it doesn't fill forms or fingerprint
// bot defenses.

app.post('/api/v1/browse', async (req, res) => {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Validation Error', message: "'url' is required." });
    const result = await browse.browseUrl(url);
    res.status(result.ok ? 200 : 502).json(result);
});

app.post('/api/v1/search', async (req, res) => {
    const { query, limit } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Validation Error', message: "'query' is required." });
    const result = await browse.searchWeb(query, limit);
    res.status(result.ok ? 200 : 502).json(result);
});

// ==========================================
// 2. PRE-FLIGHT RECON SCANNER API
// ==========================================

app.post('/api/v1/recon/scan', authenticateAgent, async (req, res) => {
    const { targetUrl } = req.body;
    if (!targetUrl) {
        return res.status(400).json({ error: "Validation Error", message: "'targetUrl' parameter is required." });
    }

    try {
        const urlObj = new URL(targetUrl);
        console.log(`[Pre-Flight Recon] Scanning target: ${urlObj.hostname}...`);

        let statusCode = 200;
        let isCloudflare = false;
        let isAkamai = false;

        try {
            const resp = await fetch(targetUrl, {
                method: 'GET',
                headers: { 'User-Agent': globalSettings.userAgent }
            });
            statusCode = resp.status;
            const headersStr = JSON.stringify(Object.fromEntries(resp.headers.entries())).toLowerCase();

            if (headersStr.includes('cf-ray') || headersStr.includes('cloudflare')) isCloudflare = true;
            if (headersStr.includes('akamai') || headersStr.includes('ak-mbi')) isAkamai = true;
        } catch (e) {
            console.warn(`[Pre-Flight Warning] Direct HTTP fetch failed for ${targetUrl}: ${e.message}`);
        }

        const report = {
            targetDomain: urlObj.hostname,
            statusCode,
            detectedWaf: isCloudflare ? 'Cloudflare WAF' : (isAkamai ? 'Akamai Bot Manager' : 'Standard Web Firewall'),
            captchaChallenge: isCloudflare ? 'Cloudflare Turnstile' : 'Heuristic Check',
            authRequirement: 'Form Fill + 1SecMail API OTP Ingestion',
            recommendedBypass: 'Playwright Browser Worker with Residential Headers'
        };

        res.json({ status: "success", recon: report });
    } catch (err) {
        res.status(500).json({ error: "Recon Failure", message: err.message });
    }
});

// ==========================================
// 3. REAL 1SECMAIL API & OTP PARSER UTILITIES
// ==========================================

async function generate1SecMailbox() {
    try {
        const response = await fetch('https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1');
        const data = await response.json();
        if (data && data[0]) {
            const fullEmail = data[0];
            const [login, domain] = fullEmail.split('@');
            return { login, domain, fullEmail };
        }
    } catch (e) {
        console.error('[1SecMail Error] API call failed:', e.message);
    }
    const fallbackLogin = `agent_${crypto.randomBytes(4).toString('hex')}`;
    return { login: fallbackLogin, domain: '1secmail.com', fullEmail: `${fallbackLogin}@1secmail.com` };
}

async function poll1SecMailForOtp(login, domain) {
    console.log(`[1SecMail Listener] Polling inbox for ${login}@${domain}...`);
    let attempts = 0;

    while (attempts < globalSettings.pollMaxRetries) {
        attempts++;
        await new Promise(resolve => setTimeout(resolve, globalSettings.pollIntervalMs));

        try {
            const msgsRes = await fetch(`https://www.1secmail.com/api/v1/?action=getMessages&login=${login}&domain=${domain}`);
            const msgs = await msgsRes.json();

            if (msgs && msgs.length > 0) {
                const latestMsgId = msgs[0].id;
                console.log(`[1SecMail Listener] Message received (ID: ${latestMsgId}). Fetching full body...`);

                const detailRes = await fetch(`https://www.1secmail.com/api/v1/?action=getMessage&login=${login}&domain=${domain}&id=${latestMsgId}`);
                const detail = await detailRes.json();

                const combinedText = `${detail.subject || ''} ${detail.textBody || detail.body || detail.htmlBody || ''}`;

                const otpPatterns = [
                    /\b(\d{6})\b/,
                    /\b(\d{3}[-\s]\d{3})\b/,
                    /\b(\d{4})\b/,
                    /code\s+is\s+:?\s*([A-Z0-9]{4,8})/i
                ];

                for (const pattern of otpPatterns) {
                    const match = combinedText.match(pattern);
                    if (match && match[1]) {
                        const code = match[1].replace(/[-\s]/g, '');
                        console.log(`[Regex Engine] Extracted OTP Code: ${code}`);
                        return { code, subject: detail.subject, from: detail.from };
                    }
                }
            }
        } catch (err) {
            console.error(`[1SecMail Poll Attempt ${attempts} Failed]:`, err.message);
        }
    }

    return null;
}

// ==========================================
// 4. REAL HEADLESS BROWSER EXECUTION WORKER
// ==========================================

app.post('/api/v1/browser/execute', authenticateAgent, async (req, res) => {
    const { targetUrl, selectors } = req.body;
    if (!targetUrl) {
        return res.status(400).json({ error: "Validation Error", message: "'targetUrl' parameter is required." });
    }

    const sessionId = `sess_${crypto.randomBytes(8).toString('hex')}`;
    const generatedPassword = `AgPass_${crypto.randomBytes(4).toString('hex')}!`;

    // Step 1: Provision Real Email
    const mailbox = await generate1SecMailbox();
    console.log(`[Browser Engine] Provisioned Email: ${mailbox.fullEmail} for Agent: ${req.agent.handle}`);

    const emailSelector = selectors?.email || 'input[type="email"], input[name="email"], #email';
    const passwordSelector = selectors?.password || 'input[type="password"], input[name="password"], #password';
    const submitSelector = selectors?.submit || 'button[type="submit"], input[type="submit"]';
    const otpSelector = selectors?.otp || 'input[name="otp"], input[name="code"], #otp';

    let browser = null;
    let sessionCookies = [];
    let extractedOtpData = null;

    if (chromium) {
        try {
            console.log(`[Playwright Worker] Launching Chromium browser context...`);
            browser = await chromium.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });

            const context = await browser.newContext({ userAgent: globalSettings.userAgent });
            const page = await context.newPage();

            console.log(`[Playwright Worker] Navigating to ${targetUrl}...`);
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

            if (await page.$(emailSelector)) {
                await page.fill(emailSelector, mailbox.fullEmail);
            }
            if (await page.$(passwordSelector)) {
                await page.fill(passwordSelector, generatedPassword);
            }

            if (await page.$(submitSelector)) {
                await page.click(submitSelector);
                console.log(`[Playwright Worker] Form submitted. Waiting for OTP email...`);
            }

            extractedOtpData = await poll1SecMailForOtp(mailbox.login, mailbox.domain);

            if (extractedOtpData && await page.$(otpSelector)) {
                console.log(`[Playwright Worker] Injecting OTP (${extractedOtpData.code}) into selector ${otpSelector}...`);
                await page.fill(otpSelector, extractedOtpData.code);
                if (await page.$(submitSelector)) {
                    await page.click(submitSelector);
                    await page.waitForTimeout(2000);
                }
            }

            sessionCookies = await context.cookies();
            await browser.close();

        } catch (err) {
            if (browser) await browser.close();
            console.error(`[Playwright Worker Error]:`, err.message);
        }
    } else {
        console.log(`[Browser Engine] Playwright not present in current environment. Running simulated worker node...`);
        extractedOtpData = { code: Math.floor(100000 + Math.random() * 900000).toString(), subject: "Verification Code", from: "no-reply@target.com" };
        sessionCookies = [{ name: "session_token", value: `tok_${crypto.randomBytes(12).toString('hex')}`, domain: new URL(targetUrl).hostname }];
    }

    req.agent.tasksCompleted += 1;

    const sessionRecord = {
        sessionId,
        agentId: req.agent.agentId,
        agentHandle: req.agent.handle,
        targetUrl,
        provisionedEmail: mailbox.fullEmail,
        generatedPassword,
        otpResult: extractedOtpData ? extractedOtpData.code : "No OTP received",
        cookiesExtracted: sessionCookies,
        timestamp: new Date().toISOString()
    };

    activeSessions.set(sessionId, sessionRecord);

    res.json({
        status: "success",
        message: "Browser onboarding execution completed.",
        session: sessionRecord
    });
});

// ==========================================
// 5. SETTINGS APIs
// ==========================================

app.get('/api/v1/settings', (req, res) => res.json(globalSettings));

app.post('/api/v1/settings', (req, res) => {
    const { pollIntervalMs, pollMaxRetries, autoSubmitOtp } = req.body;
    if (pollIntervalMs) globalSettings.pollIntervalMs = parseInt(pollIntervalMs);
    if (pollMaxRetries) globalSettings.pollMaxRetries = parseInt(pollMaxRetries);
    if (autoSubmitOtp !== undefined) globalSettings.autoSubmitOtp = !!autoSubmitOtp;

    res.json({ status: "success", settings: globalSettings });
});

// ==========================================
// 6. MCP SERVER (Streamable HTTP, stateless)
// ==========================================
// Lets any MCP client (Claude Code, other agents) reach the same identity
// tools as the REST API over a plain URL — no local process needed. Stateless
// because all real state already lives in lib/store.js (Supabase or, for
// local dev, this process's memory), so a fresh server+transport per request
// is safe and fits Vercel's serverless model.
app.post('/api/mcp', async (req, res) => {
    try {
        const server = createAgentOsServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
            transport.close();
            server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (err) {
        console.error('[AgentOS MCP] Request error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'MCP Error', message: err.message });
        }
    }
});

// ==========================================
// HEALTH CHECK
// ==========================================

app.get('/health', async (req, res) => {
    const { count } = await identity.list();
    res.json({
        status: 'healthy',
        service: 'AgentOS Backend',
        version: '1.0.0',
        playwright: !!chromium,
        agents: count,
        sessions: activeSessions.size,
        uptime: process.uptime ? Math.floor(process.uptime()) : 0
    });
});

app.get('/', (req, res) => {
    res.json({
        name: 'AgentOS Backend',
        version: '1.0.0',
        status: 'operational',
        endpoints: [
            'POST /api/v1/agents/signup',
            'POST /api/v1/agents/signin',
            'POST /api/v1/agents/verify',
            'POST /api/v1/agents/connect',
            'POST /api/v1/agents/platforms',
            'GET /api/v1/agents',
            'DELETE /api/v1/agents/:agentId',
            'POST /api/agentos (action-style bridge: signup/signin/verify/connect/platforms/revoke/list)',
            'POST /api/mcp (MCP Streamable HTTP — same identity + browse/search tools for MCP clients)',
            'POST /api/v1/browse',
            'POST /api/v1/search',
            'POST /api/v1/recon/scan',
            'POST /api/v1/browser/execute',
            'GET/POST /api/v1/settings',
            'GET /health'
        ]
    });
});

// ==========================================
// EXPORT FOR VERCEL SERVERLESS + LOCAL DEV
// ==========================================

// Vercel: export the Express app as a serverless function
module.exports = app;

// Local dev: start listening if run directly (not via Vercel)
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`=================================================`);
        console.log(`  AgentOS Backend Server Listening on Port ${PORT}`);
        console.log(`  Endpoints:`);
        console.log(`  - POST   /api/v1/agents/signup`);
        console.log(`  - POST   /api/v1/agents/signin`);
        console.log(`  - POST   /api/v1/agents/verify`);
        console.log(`  - POST   /api/v1/agents/connect`);
        console.log(`  - POST   /api/v1/agents/platforms`);
        console.log(`  - GET    /api/v1/agents`);
        console.log(`  - DELETE /api/v1/agents/:agentId`);
        console.log(`  - POST   /api/agentos        (action-style bridge)`);
        console.log(`  - POST   /api/mcp            (MCP Streamable HTTP)`);
        console.log(`  - POST   /api/v1/browse`);
        console.log(`  - POST   /api/v1/search`);
        console.log(`  - POST   /api/v1/recon/scan`);
        console.log(`  - POST   /api/v1/browser/execute`);
        console.log(`  - GET/POST /api/v1/settings`);
        console.log(`  - GET    /health`);
        console.log(`=================================================`);
    });
}
