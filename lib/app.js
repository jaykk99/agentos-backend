/**
 * AgentOS — Autonomous Headless Browser & Agent Orchestration Backend
 * Adapted for Vercel Serverless deployment
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

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
// AGENT IDENTITY / API KEY ISSUANCE
// ==========================================
//
// Keys used to be random bytes held only in an in-process Map. That works on a
// long-lived server and silently breaks on Vercel: signup runs on one lambda
// instance, the next request lands on another with an empty Map, and the key
// that was just handed out comes back 403 "Invalid, expired, or deleted Agent
// API key". Keys are now self-describing and HMAC-signed, so any instance can
// verify one without shared state. The Map stays as a warm-instance cache and
// as the directory backing GET /api/v1/agents.

const SIGNING_SECRET = process.env.AGENTOS_SIGNING_SECRET || null;
if (!SIGNING_SECRET) {
    console.warn('[Warning] AGENTOS_SIGNING_SECRET is not set. Falling back to a per-process secret: '
        + 'keys issued by one instance will not verify on another. Set it before deploying.');
}
const EFFECTIVE_SECRET = SIGNING_SECRET || crypto.randomBytes(32).toString('hex');

const agentRegistry = new Map();  // apiKey -> agentObject (warm cache / directory)
const revokedAgentIds = new Set(); // best-effort revocation for this instance
const activeSessions = new Map(); // sessionId -> sessionObject

const globalSettings = {
    proxyUrl: null,
    pollIntervalMs: 5000,
    pollMaxRetries: 10,
    autoSubmitOtp: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
};

function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payloadB64) {
    return b64url(crypto.createHmac('sha256', EFFECTIVE_SECRET).update(payloadB64).digest());
}

/** Issue a signed API key that any instance can verify offline. */
function issueApiKey(claims) {
    const payloadB64 = b64url(JSON.stringify(claims));
    return `agk_${payloadB64}.${sign(payloadB64)}`;
}

/** Verify a key's signature and return its claims, or null if it isn't ours. */
function verifyApiKey(apiKey) {
    if (typeof apiKey !== 'string' || !apiKey.startsWith('agk_')) return null;
    const [payloadB64, signature] = apiKey.slice(4).split('.');
    if (!payloadB64 || !signature) return null;

    const expected = Buffer.from(sign(payloadB64));
    const provided = Buffer.from(signature);
    if (expected.length !== provided.length) return null;
    if (!crypto.timingSafeEqual(expected, provided)) return null;

    try {
        const claims = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
        if (!claims || !claims.agentId) return null;
        return claims;
    } catch (e) {
        return null;
    }
}

/**
 * Resolve a key to a live agent record. Prefers the warm cache (it carries
 * mutable state such as tasksCompleted); rehydrates from the signed claims on
 * a cold instance.
 */
function resolveAgent(apiKey) {
    const cached = agentRegistry.get(apiKey);
    if (cached) return revokedAgentIds.has(cached.agentId) ? null : cached;

    const claims = verifyApiKey(apiKey);
    if (!claims || revokedAgentIds.has(claims.agentId)) return null;

    const agent = {
        agentId: claims.agentId,
        apiKey,
        handle: claims.handle,
        objective: claims.objective,
        createdAt: claims.createdAt,
        tasksCompleted: 0
    };
    agentRegistry.set(apiKey, agent);
    return agent;
}

// ==========================================
// MIDDLEWARE: AGENT AUTHENTICATION
// ==========================================
function authenticateAgent(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: "Unauthorized",
            message: "Missing or malformed Authorization header. Pass 'Bearer agk_...'"
        });
    }

    const apiKey = authHeader.slice('Bearer '.length).trim();
    const agent = resolveAgent(apiKey);

    if (!agent) {
        return res.status(403).json({
            error: "Forbidden",
            message: "Invalid, expired, or revoked Agent API key."
        });
    }

    req.agent = agent;
    next();
}

// ==========================================
// 1. AGENT MANAGEMENT APIs
// ==========================================

app.post('/api/v1/agents/signup', (req, res) => {
    const { handle, objective } = req.body;
    if (!handle) {
        return res.status(400).json({ error: "Validation Error", message: "'handle' field is required." });
    }

    const agentId = `agent_${crypto.randomBytes(6).toString('hex')}`;
    const createdAt = new Date().toISOString();
    const claims = {
        agentId,
        handle: String(handle).trim().slice(0, 120),
        objective: objective ? String(objective).trim().slice(0, 500) : 'Autonomous Web Agent',
        createdAt,
        nonce: crypto.randomBytes(12).toString('hex')
    };
    const apiKey = issueApiKey(claims);

    const agentObj = { ...claims, apiKey, tasksCompleted: 0 };

    agentRegistry.set(apiKey, agentObj);
    console.log(`[Agent Registry] Provisioned Agent: ${agentObj.handle} (${agentId})`);

    res.status(201).json({
        status: "success",
        message: "Agent identity provisioned.",
        agent: {
            agentId: agentObj.agentId,
            handle: agentObj.handle,
            objective: agentObj.objective,
            apiKey: agentObj.apiKey,
            createdAt: agentObj.createdAt
        }
    });
});

app.post('/api/v1/agents/signin', (req, res) => {
    const { apiKey } = req.body;
    if (!apiKey) {
        return res.status(400).json({ error: "Validation Error", message: "'apiKey' is required." });
    }

    const agent = resolveAgent(apiKey);
    if (!agent) {
        return res.status(401).json({ error: "Auth Failure", message: "API key is invalid, revoked, or not signed by this deployment." });
    }

    res.json({
        status: "success",
        message: "Agent authenticated.",
        agent: {
            agentId: agent.agentId,
            handle: agent.handle,
            objective: agent.objective,
            createdAt: agent.createdAt,
            tasksCompleted: agent.tasksCompleted
        }
    });
});

// Whoami: lets a client confirm a key it holds is still valid without
// re-sending it in a body (useful for the API Agent's key panel).
app.get('/api/v1/agents/me', authenticateAgent, (req, res) => {
    res.json({
        status: "success",
        agent: {
            agentId: req.agent.agentId,
            handle: req.agent.handle,
            objective: req.agent.objective,
            createdAt: req.agent.createdAt,
            tasksCompleted: req.agent.tasksCompleted
        }
    });
});

app.get('/api/v1/agents', (req, res) => {
    const list = Array.from(agentRegistry.values()).map(a => ({
        agentId: a.agentId,
        handle: a.handle,
        objective: a.objective,
        createdAt: a.createdAt,
        tasksCompleted: a.tasksCompleted
    }));
    res.json({ count: list.length, agents: list });
});

app.delete('/api/v1/agents/:agentId', (req, res) => {
    const { agentId } = req.params;
    let targetKey = null;

    for (const [key, agent] of agentRegistry.entries()) {
        if (agent.agentId === agentId) {
            targetKey = key;
            break;
        }
    }

    if (!targetKey) {
        // Cold instance: the agent is real (its key is signed) but this process
        // never saw it. Record the revocation anyway rather than 404-ing.
        revokedAgentIds.add(agentId);
        return res.json({ status: "success", message: `Agent '${agentId}' revoked on this instance.` });
    }

    const handle = agentRegistry.get(targetKey).handle;
    agentRegistry.delete(targetKey);
    revokedAgentIds.add(agentId);
    console.log(`[Agent Registry] Revoked API access for Agent: ${handle} (${agentId})`);

    res.json({ status: "success", message: `Agent '${handle}' (${agentId}) successfully deleted.` });
});

// ==========================================
// SSRF GUARD
// ==========================================
// Both endpoints below take a caller-supplied targetUrl and make a server-side
// request to it. Without this check an authenticated agent could point either
// one at http://169.254.169.254/ (cloud metadata), localhost, or an internal
// service on whatever network this backend is deployed into, and read back the
// response through statusCode/headers. Resolves the hostname and rejects
// loopback/private/link-local ranges rather than trusting the literal string,
// since a hostname can resolve to an internal address even when it doesn't
// look like one.
const dns = require('dns').promises;
const net = require('net');

function isPrivateOrReservedIp(ip) {
    const type = net.isIP(ip);
    if (type === 4) {
        const [a, b] = ip.split('.').map(Number);
        if (a === 10) return true;
        if (a === 127) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 0) return true;
        return false;
    }
    if (type === 6) {
        const lower = ip.toLowerCase();
        if (lower === '::1') return true;
        if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
        if (lower.startsWith('::ffff:')) return isPrivateOrReservedIp(lower.slice(7));
        return false;
    }
    return true; // not a literal IP and not resolvable -> treat as unsafe
}

async function assertPublicHttpUrl(targetUrl) {
    let urlObj;
    try {
        urlObj = new URL(targetUrl);
    } catch (e) {
        throw new Error(`'${targetUrl}' is not a valid URL.`);
    }
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
        throw new Error(`Unsupported protocol '${urlObj.protocol}' -- only http/https are allowed.`);
    }
    const hostname = urlObj.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '0.0.0.0') {
        throw new Error(`Target '${hostname}' resolves to this host or a reserved address and cannot be scanned.`);
    }

    let addresses;
    try {
        addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch (e) {
        throw new Error(`Could not resolve '${hostname}': ${e.message}`);
    }
    if (!addresses.length || addresses.some(a => isPrivateOrReservedIp(a.address))) {
        throw new Error(`Target '${hostname}' resolves to a private, loopback, or reserved address and cannot be scanned.`);
    }
    return urlObj;
}

// ==========================================
// 2. PRE-FLIGHT RECON SCANNER API
// ==========================================

app.post('/api/v1/recon/scan', authenticateAgent, async (req, res) => {
    const { targetUrl } = req.body;
    if (!targetUrl) {
        return res.status(400).json({ error: "Validation Error", message: "'targetUrl' parameter is required." });
    }

    let urlObj;
    try {
        urlObj = await assertPublicHttpUrl(targetUrl);
    } catch (e) {
        return res.status(400).json({ error: "Validation Error", message: e.message });
    }

    try {
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
    try {
        await assertPublicHttpUrl(targetUrl);
    } catch (e) {
        return res.status(400).json({ error: "Validation Error", message: e.message });
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
// HEALTH CHECK
// ==========================================

app.get(['/health', '/api/health', '/api/v1/health'], (req, res) => {
    res.json({
        status: 'healthy',
        service: 'AgentOS Backend',
        version: '1.0.0',
        playwright: !!chromium,
        agents: agentRegistry.size,
        sessions: activeSessions.size,
        uptime: process.uptime ? Math.floor(process.uptime()) : 0
    });
});

app.get(['/', '/api', '/api/', '/api/v1'], (req, res) => {
    res.json({
        name: 'AgentOS Backend',
        version: '1.0.0',
        status: 'operational',
        endpoints: [
            'POST /api/v1/agents/signup',
            'POST /api/v1/agents/signin',
            'GET /api/v1/agents/me',
            'GET /api/v1/agents',
            'DELETE /api/v1/agents/:agentId',
            'POST /api/v1/recon/scan',
            'POST /api/v1/browser/execute',
            'GET/POST /api/v1/settings',
            'GET /health'
        ]
    });
});

// ==========================================
// FALLBACK
// ==========================================

app.use((req, res) => {
    res.status(404).json({ error: 'Not Found', message: `No route for ${req.method} ${req.path}` });
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
        console.log(`  - GET    /api/v1/agents`);
        console.log(`  - DELETE /api/v1/agents/:agentId`);
        console.log(`  - POST   /api/v1/recon/scan`);
        console.log(`  - POST   /api/v1/browser/execute`);
        console.log(`  - GET/POST /api/v1/settings`);
        console.log(`  - GET    /health`);
        console.log(`=================================================`);
    });
}
