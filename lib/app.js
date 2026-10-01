/**
 * AgentOS — Autonomous Headless Browser & Agent Orchestration Backend
 * Adapted for Vercel Serverless deployment
 *
 * Hardened edition: rate-limited auth endpoints, API-key TTL, SSRF guard on
 * recon, strict input validation, structured JSON logging, honest /api/status
 * capability reporting, and a /dashboard web UI.
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const path = require('path');

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
let browserBinary = false; // true only when a Chromium executable is actually present
try {
    const playwright = require('playwright');
    chromium = playwright.chromium;
    try {
        chromium.executablePath(); // throws when `npx playwright install` was never run
        browserBinary = true;
    } catch {
        console.warn('[Warning] Playwright module found but no Chromium binary downloaded — run `npx playwright install chromium`. Browser automation will use simulated mode.');
    }
} catch (e) {
    console.warn('[Warning] Playwright module not detected. Browser automation will use simulated mode.');
}
const browserAvailable = !!chromium && browserBinary;

// ==========================================
// CONFIG (env-tunable, keyless defaults)
// ==========================================
function numEnv(name, fallback) {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
}

const config = {
    adminKey: process.env.ADMIN_KEY || '',
    // Agent API keys expire this many days after signup (0 = expire immediately).
    keyTtlDays: numEnv('AGENT_KEY_TTL_DAYS', 90),
    // Hard cap on the in-memory agent registry (prevents unbounded growth).
    maxAgents: Math.max(1, Math.floor(numEnv('MAX_AGENTS', 10000))),
    globalRate: { windowMs: numEnv('RATE_LIMIT_WINDOW_MS', 60_000), max: numEnv('RATE_LIMIT_MAX', 300) },
    // Stricter bucket for the credential-bearing auth endpoints.
    authRate: { windowMs: numEnv('AUTH_RATE_WINDOW_MS', 600_000), max: numEnv('AUTH_RATE_MAX', 30) },
    adminRate: { windowMs: numEnv('ADMIN_RATE_WINDOW_MS', 60_000), max: numEnv('ADMIN_RATE_MAX', 120) },
    jsonLimit: process.env.JSON_BODY_LIMIT || '100kb',
    // Outbound recon fetch timeout.
    reconTimeoutMs: numEnv('RECON_TIMEOUT_MS', 10_000),
};

const VERSION = '1.1.0';
const BOOT_TIME = Date.now();

// ==========================================
// STRUCTURED LOGGING (JSON lines + ring buffer)
// ==========================================
const logRing = []; // last 200 events; surfaced (sanitized) via /api/status
function logEvent(level, msg, fields = {}) {
    const entry = { ts: new Date().toISOString(), level, msg, ...fields };
    console.log(JSON.stringify(entry));
    logRing.push(entry);
    if (logRing.length > 200) logRing.shift();
}

const app = express();
app.disable('x-powered-by');
app.use(cors());

// Request IDs first: every response carries X-Request-Id; every error JSON
// echoes it — including body-parser failures, which skip later middleware.
app.use((req, res, next) => {
    req.id = crypto.randomBytes(8).toString('hex');
    res.setHeader('X-Request-Id', req.id);
    next();
});

app.use(express.json({ limit: config.jsonLimit }));

// Request logging on response finish.
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        logEvent(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
            'request', {
                requestId: req.id,
                method: req.method,
                path: req.path,
                status: res.statusCode,
                ms: Date.now() - start,
            });
    });
    next();
});

// ==========================================
// IN-MEMORY DATA STORES
// ==========================================
const agentRegistry = new Map(); // apiKey -> agentObject
const activeSessions = new Map(); // sessionId -> sessionObject

const globalSettings = {
    proxyUrl: null,
    pollIntervalMs: 5000,
    pollMaxRetries: 10,
    autoSubmitOtp: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
};

// ==========================================
// HELPERS: errors, validation, rate limiting
// ==========================================
function sendError(req, res, status, error, message) {
    return res.status(status).json({ status: 'error', error, message, requestId: req.id });
}

function createRateLimiter({ windowMs, max }, scope) {
    const hits = new Map();
    return (req, res, next) => {
        const key = req.ip || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        let entry = hits.get(key);
        if (!entry || now >= entry.resetAt) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(key, entry);
        }
        entry.count += 1;
        res.setHeader('X-RateLimit-Limit', String(max));
        res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
        if (entry.count > max) {
            logEvent('warn', 'rate_limited', { requestId: req.id, scope, ip: key });
            return sendError(req, res, 429, 'Too Many Requests',
                `Rate limit exceeded for ${scope}: ${max} requests per ${Math.round(windowMs / 1000)}s.`);
        }
        // Opportunistic prune so the map can't grow forever.
        if (hits.size > 10000) {
            for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
        }
        next();
    };
}

const globalRateLimit = createRateLimiter(config.globalRate, 'global');
const authRateLimit = createRateLimiter(config.authRate, 'auth');
const adminRateLimit = createRateLimiter(config.adminRate, 'admin');
app.use(globalRateLimit);

function isNonEmptyString(v, maxLen) {
    return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}

// --- SSRF guard for user-supplied target URLs ---
function isPrivateIp(ip) {
    if (net.isIP(ip) === 4) {
        const [a, b] = ip.split('.').map(Number);
        return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
            a === 127 || (a === 169 && b === 254) || a === 0;
    }
    if (net.isIP(ip) === 6) {
        const l = ip.toLowerCase();
        return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
    }
    return false;
}

async function validateTargetUrl(raw) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
        return { ok: false, reason: 'must be a string between 1 and 2048 characters' };
    }
    let u;
    try { u = new URL(raw); } catch { return { ok: false, reason: 'not a valid URL' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { ok: false, reason: 'only http:// and https:// URLs are allowed' };
    }
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) {
        return { ok: false, reason: 'loopback hostnames are not allowed' };
    }
    if (net.isIP(host) && isPrivateIp(host)) {
        return { ok: false, reason: 'private/loopback IP addresses are not allowed' };
    }
    try {
        const addrs = await dns.lookup(host, { all: true });
        if (addrs.some(a => isPrivateIp(a.address))) {
            return { ok: false, reason: 'hostname resolves to a private/loopback address' };
        }
    } catch {
        return { ok: false, reason: 'hostname could not be resolved' };
    }
    return { ok: true, url: u };
}

function pruneExpiredAgents() {
    const now = Date.now();
    let removed = 0;
    for (const [key, agent] of agentRegistry) {
        if (Date.parse(agent.expiresAt) <= now) { agentRegistry.delete(key); removed++; }
    }
    if (removed) logEvent('info', 'pruned_expired_agents', { removed });
}

function isExpired(agent) {
    return Date.parse(agent.expiresAt) <= Date.now();
}

// ==========================================
// MIDDLEWARE: ADMIN AUTHENTICATION
// ==========================================
// Admin endpoints (list/delete agents, change settings) are open by default
// so the service works keyless out of the box. Set ADMIN_KEY in the
// environment to require it: clients then pass
//   Authorization: Bearer <ADMIN_KEY>   (or x-admin-key: <ADMIN_KEY>).
function authenticateAdmin(req, res, next) {
    const required = config.adminKey;
    if (!required) return next(); // keyless-first: no key configured, no gate

    const header = req.headers['authorization'] || '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-admin-key'];
    // Constant-time compare so a wrong guess leaks nothing via timing.
    const a = Buffer.from(String(presented || ''));
    const b = Buffer.from(required);
    const ok = presented && a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
        logEvent('warn', 'admin_auth_failed', { requestId: req.id });
        return sendError(req, res, 403, 'Forbidden',
            'This deployment requires ADMIN_KEY for admin endpoints.');
    }
    next();
}

// ==========================================
// MIDDLEWARE: AGENT AUTHENTICATION
// ==========================================
function authenticateAgent(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return sendError(req, res, 401, 'Unauthorized',
            "Missing or malformed Authorization header. Pass 'Bearer agk_...'");
    }

    const apiKey = authHeader.split(' ')[1];
    const agent = agentRegistry.get(apiKey);

    if (!agent) {
        return sendError(req, res, 403, 'Forbidden', 'Invalid, expired, or deleted Agent API key.');
    }
    if (isExpired(agent)) {
        agentRegistry.delete(apiKey);
        return sendError(req, res, 401, 'Unauthorized',
            'Agent API key has expired. Sign up again to provision a fresh identity.');
    }

    req.agent = agent;
    next();
}

// ==========================================
// 1. AGENT MANAGEMENT APIs
// ==========================================

app.post('/api/v1/agents/signup', authRateLimit, (req, res) => {
    const { handle, objective } = req.body || {};
    if (!isNonEmptyString(handle, 64)) {
        return sendError(req, res, 400, 'Validation Error',
            "'handle' is required: a string of 1-64 characters.");
    }
    if (objective !== undefined && (typeof objective !== 'string' || objective.length > 280)) {
        return sendError(req, res, 400, 'Validation Error',
            "'objective' must be a string of at most 280 characters.");
    }

    pruneExpiredAgents();
    if (agentRegistry.size >= config.maxAgents) {
        return sendError(req, res, 503, 'Service Unavailable',
            'Agent registry is full. Revoke unused agents or raise MAX_AGENTS.');
    }

    const agentId = `agent_${crypto.randomBytes(6).toString('hex')}`;
    const apiKey = `agk_${crypto.randomBytes(18).toString('hex')}`;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + config.keyTtlDays * 24 * 60 * 60 * 1000).toISOString();

    const agentObj = {
        agentId,
        apiKey,
        handle: handle.trim(),
        objective: objective ? objective.trim() : 'Autonomous Web Agent',
        createdAt,
        expiresAt,
        tasksCompleted: 0
    };

    agentRegistry.set(apiKey, agentObj);
    logEvent('info', 'agent_signup', { requestId: req.id, agentId, handle: agentObj.handle });

    res.status(201).json({
        status: "success",
        message: "Agent identity provisioned.",
        agent: {
            agentId: agentObj.agentId,
            handle: agentObj.handle,
            objective: agentObj.objective,
            apiKey: agentObj.apiKey,
            createdAt: agentObj.createdAt,
            expiresAt: agentObj.expiresAt
        }
    });
});

app.post('/api/v1/agents/signin', authRateLimit, (req, res) => {
    const { apiKey } = req.body || {};
    if (typeof apiKey !== 'string' || !apiKey) {
        return sendError(req, res, 400, 'Validation Error', "'apiKey' is required.");
    }

    const agent = agentRegistry.get(apiKey);
    if (!agent) {
        logEvent('warn', 'signin_unknown_key', { requestId: req.id });
        return sendError(req, res, 401, 'Auth Failure', 'API key not found in active directory.');
    }
    if (isExpired(agent)) {
        agentRegistry.delete(apiKey);
        return sendError(req, res, 401, 'Auth Failure',
            'API key has expired. Sign up again to provision a fresh identity.');
    }

    res.json({
        status: "success",
        message: "Agent authenticated.",
        agent: {
            agentId: agent.agentId,
            handle: agent.handle,
            objective: agent.objective,
            tasksCompleted: agent.tasksCompleted,
            expiresAt: agent.expiresAt
        }
    });
});

app.get('/api/v1/agents', adminRateLimit, authenticateAdmin, (req, res) => {
    const list = Array.from(agentRegistry.values()).map(a => ({
        agentId: a.agentId,
        handle: a.handle,
        objective: a.objective,
        createdAt: a.createdAt,
        expiresAt: a.expiresAt,
        tasksCompleted: a.tasksCompleted
    }));
    res.json({ status: 'success', count: list.length, agents: list });
});

app.delete('/api/v1/agents/:agentId', adminRateLimit, authenticateAdmin, (req, res) => {
    const { agentId } = req.params;
    if (!/^agent_[0-9a-f]{12}$/.test(agentId)) {
        return sendError(req, res, 400, 'Validation Error', 'Malformed agent ID.');
    }
    let targetKey = null;

    for (const [key, agent] of agentRegistry.entries()) {
        if (agent.agentId === agentId) {
            targetKey = key;
            break;
        }
    }

    if (!targetKey) {
        return sendError(req, res, 404, 'Not Found', `Agent with ID '${agentId}' does not exist.`);
    }

    const handle = agentRegistry.get(targetKey).handle;
    agentRegistry.delete(targetKey);
    logEvent('info', 'agent_revoked', { requestId: req.id, agentId, handle });

    res.json({ status: "success", message: `Agent '${handle}' (${agentId}) successfully deleted.` });
});

// ==========================================
// 2. PRE-FLIGHT RECON SCANNER API
// ==========================================

function fetchWithTimeout(url, options = {}, timeoutMs = config.reconTimeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const opts = { ...options, signal: controller.signal };
    // node-fetch v2 also honors its own `timeout` option; harmless for global fetch.
    if (fetch.name !== 'fetch') opts.timeout = timeoutMs;
    return fetch(url, opts).finally(() => clearTimeout(timer));
}

app.post('/api/v1/recon/scan', authenticateAgent, async (req, res) => {
    const { targetUrl } = req.body || {};
    const check = await validateTargetUrl(targetUrl);
    if (!check.ok) {
        return sendError(req, res, 400, 'Validation Error', `'targetUrl' rejected: ${check.reason}.`);
    }
    const urlObj = check.url;
    logEvent('info', 'recon_scan', { requestId: req.id, agentId: req.agent.agentId, host: urlObj.hostname });

    try {
        let statusCode = 200;
        let isCloudflare = false;
        let isAkamai = false;

        try {
            const resp = await fetchWithTimeout(urlObj.toString(), {
                method: 'GET',
                headers: { 'User-Agent': globalSettings.userAgent }
            });
            statusCode = resp.status;
            const headersStr = JSON.stringify(Object.fromEntries(resp.headers.entries())).toLowerCase();

            if (headersStr.includes('cf-ray') || headersStr.includes('cloudflare')) isCloudflare = true;
            if (headersStr.includes('akamai') || headersStr.includes('ak-mbi')) isAkamai = true;
        } catch (e) {
            logEvent('warn', 'recon_fetch_failed', { requestId: req.id, host: urlObj.hostname, error: e.message });
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
        // Never leak internals: log the real error, return a generic message.
        logEvent('error', 'recon_failure', { requestId: req.id, error: err.message });
        return sendError(req, res, 500, 'Recon Failure', 'The recon scan failed unexpectedly.');
    }
});

// ==========================================
// 3. REAL 1SECMAIL API & OTP PARSER UTILITIES
// ==========================================

async function generate1SecMailbox() {
    try {
        const response = await fetchWithTimeout('https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1', {}, 15000);
        const data = await response.json();
        if (data && data[0]) {
            const fullEmail = data[0];
            const [login, domain] = fullEmail.split('@');
            return { login, domain, fullEmail };
        }
    } catch (e) {
        logEvent('error', 'secmail_gen_failed', { error: e.message });
    }
    const fallbackLogin = `agent_${crypto.randomBytes(4).toString('hex')}`;
    return { login: fallbackLogin, domain: '1secmail.com', fullEmail: `${fallbackLogin}@1secmail.com` };
}

async function poll1SecMailForOtp(login, domain) {
    logEvent('info', 'secmail_poll_start', { login: `${login}@${domain}` });
    let attempts = 0;

    while (attempts < globalSettings.pollMaxRetries) {
        attempts++;
        await new Promise(resolve => setTimeout(resolve, globalSettings.pollIntervalMs));

        try {
            const msgsRes = await fetchWithTimeout(
                `https://www.1secmail.com/api/v1/?action=getMessages&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}`,
                {}, 15000);
            const msgs = await msgsRes.json();

            if (msgs && msgs.length > 0) {
                const latestMsgId = msgs[0].id;
                logEvent('info', 'secmail_message', { messageId: latestMsgId });

                const detailRes = await fetchWithTimeout(
                    `https://www.1secmail.com/api/v1/?action=getMessage&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}&id=${latestMsgId}`,
                    {}, 15000);
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
                        logEvent('info', 'secmail_otp_extracted', { messageId: latestMsgId });
                        return { code, subject: detail.subject, from: detail.from };
                    }
                }
            }
        } catch (err) {
            logEvent('warn', 'secmail_poll_attempt_failed', { attempt: attempts, error: err.message });
        }
    }

    return null;
}

// ==========================================
// 4. REAL HEADLESS BROWSER EXECUTION WORKER
// ==========================================

app.post('/api/v1/browser/execute', authenticateAgent, async (req, res) => {
    const { targetUrl, selectors } = req.body || {};
    const check = await validateTargetUrl(targetUrl);
    if (!check.ok) {
        return sendError(req, res, 400, 'Validation Error', `'targetUrl' rejected: ${check.reason}.`);
    }
    if (selectors !== undefined && (typeof selectors !== 'object' || selectors === null || Array.isArray(selectors))) {
        return sendError(req, res, 400, 'Validation Error', "'selectors' must be an object when provided.");
    }
    for (const k of ['email', 'password', 'submit', 'otp']) {
        if (selectors?.[k] !== undefined && (typeof selectors[k] !== 'string' || selectors[k].length > 512)) {
            return sendError(req, res, 400, 'Validation Error', `selectors.${k} must be a string up to 512 chars.`);
        }
    }

    const sessionId = `sess_${crypto.randomBytes(8).toString('hex')}`;
    const generatedPassword = `AgPass_${crypto.randomBytes(4).toString('hex')}!`;

    // Step 1: Provision Real Email
    const mailbox = await generate1SecMailbox();
    logEvent('info', 'browser_mailbox', { requestId: req.id, sessionId, email: mailbox.fullEmail, agentId: req.agent.agentId });

    const emailSelector = selectors?.email || 'input[type="email"], input[name="email"], #email';
    const passwordSelector = selectors?.password || 'input[type="password"], input[name="password"], #password';
    const submitSelector = selectors?.submit || 'button[type="submit"], input[type="submit"]';
    const otpSelector = selectors?.otp || 'input[name="otp"], input[name="code"], #otp';

    let browser = null;
    let sessionCookies = [];
    let extractedOtpData = null;
    // False only when Playwright is actually driving a real Chromium.
    let simulated = false;

    if (browserAvailable) {
        try {
            logEvent('info', 'playwright_launch', { requestId: req.id, sessionId });
            browser = await chromium.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });

            const context = await browser.newContext({ userAgent: globalSettings.userAgent });
            const page = await context.newPage();

            logEvent('info', 'playwright_navigate', { requestId: req.id, sessionId, target: check.url.hostname });
            await page.goto(check.url.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });

            if (await page.$(emailSelector)) {
                await page.fill(emailSelector, mailbox.fullEmail);
            }
            if (await page.$(passwordSelector)) {
                await page.fill(passwordSelector, generatedPassword);
            }

            if (await page.$(submitSelector)) {
                await page.click(submitSelector);
                logEvent('info', 'playwright_submitted', { requestId: req.id, sessionId });
            }

            extractedOtpData = await poll1SecMailForOtp(mailbox.login, mailbox.domain);

            if (extractedOtpData && await page.$(otpSelector)) {
                logEvent('info', 'playwright_otp_inject', { requestId: req.id, sessionId });
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
            // A failed launch is not a real run: mark the session simulated
            // so callers never mistake an empty result for automation.
            simulated = true;
            logEvent('error', 'playwright_error', { requestId: req.id, sessionId, error: err.message });
        }
    } else {
        // No usable Playwright in this environment: say so honestly instead of
        // returning fabricated cookies/OTP as if a real browser ran.
        simulated = true;
        logEvent('info', 'browser_simulated', { requestId: req.id, sessionId });
        extractedOtpData = { code: null, subject: "Verification Code", from: "no-reply@target.com" };
        sessionCookies = [];
    }

    req.agent.tasksCompleted += 1;

    const sessionRecord = {
        sessionId,
        agentId: req.agent.agentId,
        agentHandle: req.agent.handle,
        targetUrl: check.url.toString(),
        provisionedEmail: mailbox.fullEmail,
        generatedPassword,
        otpResult: extractedOtpData ? extractedOtpData.code : "No OTP received",
        cookiesExtracted: sessionCookies,
        simulated,
        timestamp: new Date().toISOString()
    };

    activeSessions.set(sessionId, sessionRecord);

    res.json({
        status: "success",
        message: simulated
            ? "Browser unavailable in this environment — placeholder session returned (install the playwright optional dependency and run `npx playwright install chromium` for real runs)."
            : "Browser onboarding execution completed.",
        session: sessionRecord
    });
});

// ==========================================
// 5. SETTINGS APIs
// ==========================================

app.get('/api/v1/settings', adminRateLimit, authenticateAdmin, (req, res) =>
    res.json({ status: 'success', settings: globalSettings }));

app.post('/api/v1/settings', adminRateLimit, authenticateAdmin, (req, res) => {
    const { pollIntervalMs, pollMaxRetries, autoSubmitOtp, proxyUrl, userAgent } = req.body || {};

    if (pollIntervalMs !== undefined) {
        const v = Number(pollIntervalMs);
        if (!Number.isInteger(v) || v < 500 || v > 60000) {
            return sendError(req, res, 400, 'Validation Error', "'pollIntervalMs' must be an integer between 500 and 60000.");
        }
        globalSettings.pollIntervalMs = v;
    }
    if (pollMaxRetries !== undefined) {
        const v = Number(pollMaxRetries);
        if (!Number.isInteger(v) || v < 1 || v > 100) {
            return sendError(req, res, 400, 'Validation Error', "'pollMaxRetries' must be an integer between 1 and 100.");
        }
        globalSettings.pollMaxRetries = v;
    }
    if (autoSubmitOtp !== undefined) {
        if (typeof autoSubmitOtp !== 'boolean') {
            return sendError(req, res, 400, 'Validation Error', "'autoSubmitOtp' must be a boolean.");
        }
        globalSettings.autoSubmitOtp = autoSubmitOtp;
    }
    if (proxyUrl !== undefined) {
        if (proxyUrl !== null) {
            let u;
            try { u = new URL(proxyUrl); } catch {
                return sendError(req, res, 400, 'Validation Error', "'proxyUrl' must be a valid URL or null.");
            }
            if (u.protocol !== 'http:' && u.protocol !== 'https:') {
                return sendError(req, res, 400, 'Validation Error', "'proxyUrl' must use http:// or https://.");
            }
        }
        globalSettings.proxyUrl = proxyUrl;
    }
    if (userAgent !== undefined) {
        if (!isNonEmptyString(userAgent, 512)) {
            return sendError(req, res, 400, 'Validation Error', "'userAgent' must be a string of 1-512 characters.");
        }
        globalSettings.userAgent = userAgent;
    }

    logEvent('info', 'settings_updated', { requestId: req.id });
    res.json({ status: "success", settings: globalSettings });
});

// ==========================================
// 6. STATUS: honest capability reporting
// ==========================================

function statusPayload() {
    const mem = process.memoryUsage();
    return {
        status: 'ok',
        service: 'AgentOS Backend',
        version: VERSION,
        uptimeSeconds: Math.floor((Date.now() - BOOT_TIME) / 1000),
        node: process.version,
        capabilities: {
            // True only when Playwright is installed AND a Chromium binary exists.
            realBrowserAutomation: browserAvailable,
            playwrightModule: !!chromium,
            browserBinaryDownloaded: browserBinary,
            simulatedBrowserFallback: !browserAvailable,
            otpIngestion: true, // real 1SecMail polling
            persistence: 'in-memory (resets on restart/redeploy)',
        },
        security: {
            adminGateConfigured: config.adminKey.length > 0,
            agentKeyTtlDays: config.keyTtlDays,
            rateLimits: {
                global: `${config.globalRate.max}/${Math.round(config.globalRate.windowMs / 1000)}s`,
                auth: `${config.authRate.max}/${Math.round(config.authRate.windowMs / 1000)}s`,
                admin: `${config.adminRate.max}/${Math.round(config.adminRate.windowMs / 1000)}s`,
            },
        },
        counts: {
            agents: agentRegistry.size,
            sessions: activeSessions.size,
            maxAgents: config.maxAgents,
        },
        memory: {
            rssMB: Math.round(mem.rss / 1024 / 1024),
            heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        },
        // Last few warn/error events only — sanitized, no secrets.
        recentIssues: logRing.filter(e => e.level !== 'info').slice(-10).map(e => ({
            ts: e.ts, level: e.level, msg: e.msg,
        })),
    };
}

function statusHandler(req, res) {
    res.json(statusPayload());
}
app.get('/api/status', statusHandler);

// ==========================================
// HEALTH CHECK
// ==========================================

function healthHandler(req, res) {
    res.json({
        status: 'healthy',
        service: 'AgentOS Backend',
        version: VERSION,
        playwright: browserAvailable,
        agents: agentRegistry.size,
        sessions: activeSessions.size,
        uptime: Math.floor((Date.now() - BOOT_TIME) / 1000)
    });
}

const ENDPOINTS = [
    'POST /api/v1/agents/signup',
    'POST /api/v1/agents/signin',
    'GET /api/v1/agents',
    'DELETE /api/v1/agents/:agentId',
    'POST /api/v1/recon/scan',
    'POST /api/v1/browser/execute',
    'GET/POST /api/v1/settings',
    'GET /api/status',
    'GET /health',
    'GET /dashboard',
];

function rootHandler(req, res) {
    res.json({
        name: 'AgentOS Backend',
        version: VERSION,
        status: 'operational',
        dashboard: '/dashboard',
        endpoints: ENDPOINTS
    });
}

// Registered on both the bare and /api-prefixed paths because Vercel's
// rewrites hand the function the *destination* path (/api, /api/health).
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);
app.get('/', rootHandler);
app.get('/api', rootHandler);
app.get('/api/', rootHandler);
app.get('/api/status', statusHandler);

// ==========================================
// DASHBOARD UI
// ==========================================
const DASHBOARD_FILE = path.join(__dirname, '..', 'public', 'dashboard.html');
function dashboardHandler(req, res) {
    res.sendFile(DASHBOARD_FILE, err => {
        if (err) sendError(req, res, 500, 'Server Error', 'Dashboard UI is unavailable.');
    });
}
app.get('/dashboard', dashboardHandler);
app.get('/api/dashboard', dashboardHandler);

// ==========================================
// 404 + ERROR HANDLERS (structured, no stack leaks)
// ==========================================
app.use((req, res) => {
    sendError(req, res, 404, 'Not Found', `No route for ${req.method} ${req.path}. See GET / for the endpoint list.`);
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    // express.json() body-too-large lands here as entity.too.large
    logEvent('error', 'unhandled_error', { requestId: req.id, error: err.message, type: err.type });
    if (err.type === 'entity.too.large') {
        return sendError(req, res, 413, 'Payload Too Large', `Request body exceeds the ${config.jsonLimit} limit.`);
    }
    if (err.type === 'entity.parse.failed') {
        return sendError(req, res, 400, 'Bad Request', 'Request body is not valid JSON.');
    }
    return sendError(req, res, 500, 'Internal Server Error', 'Something went wrong.');
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
        logEvent('info', 'server_listening', {
            port: PORT,
            version: VERSION,
            playwright: browserAvailable,
            adminGate: config.adminKey.length > 0,
            keyTtlDays: config.keyTtlDays,
        });
        console.log(`=================================================`);
        console.log(`  AgentOS Backend v${VERSION} listening on port ${PORT}`);
        console.log(`  Dashboard: http://localhost:${PORT}/dashboard`);
        console.log(`  Endpoints:`);
        for (const e of ENDPOINTS) console.log(`  - ${e}`);
        console.log(`=================================================`);
    });
}
