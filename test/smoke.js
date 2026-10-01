/**
 * Smoke tests for agentos-backend. Zero dependencies: spawns the real server
 * as a child process and exercises it over HTTP.
 *
 * Run: npm test
 */
const { spawn } = require('child_process');
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
let passes = 0;

function check(name, cond, extra = '') {
    if (cond) { passes++; console.log(`  ok   ${name}`); }
    else { failures++; console.log(`  FAIL ${name} ${extra}`); }
}

async function req(port, method, p, { body, headers = {}, timeoutMs = 15000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(`http://127.0.0.1:${port}${p}`, {
            method,
            headers: { 'Content-Type': 'application/json', ...headers },
            body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
            signal: ctrl.signal,
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON */ }
        return { status: res.status, json, text, headers: res.headers };
    } finally { clearTimeout(t); }
}

function errorShape(r) {
    return r.json && r.json.status === 'error' && typeof r.json.error === 'string' &&
        typeof r.json.message === 'string' && typeof r.json.requestId === 'string' &&
        !('stack' in r.json) && !JSON.stringify(r.json).includes('at ');
}

async function startServer(port, env = {}) {
    const child = spawn('node', ['api/index.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port), ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    // wait for healthy
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        try {
            const r = await req(port, 'GET', '/api/health', { timeoutMs: 2000 });
            if (r.status === 200 && r.json && r.json.status === 'healthy') return child;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 300));
    }
    child.kill();
    throw new Error(`server on port ${port} did not become healthy in time`);
}

function stopServer(child) {
    return new Promise(resolve => {
        child.on('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 3000);
    });
}

async function main() {
    console.log('== server A: default keyless config ==');
    const A = 3101;
    const srvA = await startServer(A);

    let r = await req(A, 'GET', '/api/health');
    check('GET /api/health -> 200 healthy', r.status === 200 && r.json.status === 'healthy' && r.json.version === '1.1.0', `got ${r.status}`);

    r = await req(A, 'GET', '/api/status');
    check('GET /api/status -> 200 with honest capabilities',
        r.status === 200 && typeof r.json.capabilities.realBrowserAutomation === 'boolean' &&
        r.json.capabilities.realBrowserAutomation === (r.json.capabilities.playwrightModule && r.json.capabilities.browserBinaryDownloaded) &&
        r.json.security.adminGateConfigured === false &&
        typeof r.json.counts.agents === 'number' && r.json.security.rateLimits.auth === '30/600s',
        `got ${r.status}`);

    r = await req(A, 'GET', '/dashboard');
    check('GET /dashboard -> 200 HTML dashboard', r.status === 200 && r.text.includes('AgentOS') && r.text.includes('try-it') || (r.status === 200 && r.text.includes('Try-it console')), `got ${r.status}`);

    r = await req(A, 'GET', '/');
    check('GET / -> JSON index links dashboard', r.status === 200 && r.json.dashboard === '/dashboard');

    r = await req(A, 'POST', '/api/v1/agents/signup', { body: {} });
    check('POST signup missing handle -> 400 structured error', r.status === 400 && errorShape(r), `got ${r.status}`);

    r = await req(A, 'POST', '/api/v1/agents/signup', { body: { handle: 'x'.repeat(100) } });
    check('POST signup 100-char handle -> 400', r.status === 400 && errorShape(r), `got ${r.status}`);

    r = await req(A, 'POST', '/api/v1/agents/signup', { body: 'not-json{' });
    check('POST signup invalid JSON -> 400 no stack', r.status === 400 && errorShape(r), `got ${r.status}`);

    r = await req(A, 'POST', '/api/v1/agents/signup', { body: { handle: 'smoke-agent', objective: 'smoke test' } });
    const key = r.json && r.json.agent && r.json.agent.apiKey;
    const agentId = r.json && r.json.agent && r.json.agent.agentId;
    check('POST signup valid -> 201 with agk_ key + expiry',
        r.status === 201 && typeof key === 'string' && key.startsWith('agk_') && !!r.json.agent.expiresAt, `got ${r.status}`);

    r = await req(A, 'POST', '/api/v1/agents/signin', { body: { apiKey: key } });
    check('POST signin good key -> 200', r.status === 200 && r.json.agent.handle === 'smoke-agent', `got ${r.status}`);

    r = await req(A, 'POST', '/api/v1/agents/signin', { body: { apiKey: 'agk_nope' } });
    check('POST signin bad key -> 401', r.status === 401 && errorShape(r), `got ${r.status}`);

    r = await req(A, 'POST', '/api/v1/recon/scan', { body: { targetUrl: 'https://example.com' } });
    check('POST recon without auth -> 401', r.status === 401 && errorShape(r), `got ${r.status}`);

    const authH = { Authorization: `Bearer ${key}` };
    r = await req(A, 'POST', '/api/v1/recon/scan', { body: { targetUrl: 'http://127.0.0.1:9/x' }, headers: authH });
    check('POST recon loopback URL blocked (SSRF) -> 400', r.status === 400 && /private|loopback/i.test(r.json.message), `got ${r.status} ${r.text.slice(0, 120)}`);

    r = await req(A, 'POST', '/api/v1/recon/scan', { body: { targetUrl: 'ftp://example.com/x' }, headers: authH });
    check('POST recon ftp:// rejected -> 400', r.status === 400 && errorShape(r), `got ${r.status}`);

    r = await req(A, 'POST', '/api/v1/recon/scan', { body: { targetUrl: 'not a url' }, headers: authH });
    check('POST recon garbage URL -> 400', r.status === 400 && errorShape(r), `got ${r.status}`);

    r = await req(A, 'POST', '/api/v1/browser/execute', { body: { targetUrl: 'http://10.0.0.1/' }, headers: authH });
    check('POST browser/execute private IP blocked -> 400', r.status === 400 && errorShape(r), `got ${r.status}`);

    r = await req(A, 'GET', '/api/v1/agents');
    check('GET /agents keyless default -> 200 (open)', r.status === 200 && r.json.count >= 1, `got ${r.status}`);

    r = await req(A, 'POST', '/api/v1/settings', { body: { pollIntervalMs: 'abc' } });
    check('POST settings bad pollIntervalMs -> 400', r.status === 400 && errorShape(r), `got ${r.status}`);
    r = await req(A, 'POST', '/api/v1/settings', { body: { pollIntervalMs: 10 } });
    check('POST settings out-of-range pollIntervalMs -> 400', r.status === 400, `got ${r.status}`);
    r = await req(A, 'POST', '/api/v1/settings', { body: { pollIntervalMs: 7000 } });
    check('POST settings valid -> 200', r.status === 200 && r.json.settings.pollIntervalMs === 7000, `got ${r.status}`);
    await req(A, 'POST', '/api/v1/settings', { body: { pollIntervalMs: 5000 } }); // restore

    r = await req(A, 'POST', '/api/v1/agents/signup', { body: 'x'.repeat(200 * 1024) });
    check('POST 200kb body -> 413 payload too large', r.status === 413 && errorShape(r), `got ${r.status}`);

    r = await req(A, 'GET', '/no-such-route');
    check('GET unknown route -> 404 structured', r.status === 404 && errorShape(r), `got ${r.status}`);

    r = await req(A, 'DELETE', `/api/v1/agents/${agentId}`);
    check('DELETE agent -> 200 revoked', r.status === 200 && r.json.status === 'success', `got ${r.status}`);
    r = await req(A, 'POST', '/api/v1/agents/signin', { body: { apiKey: key } });
    check('signin after revoke -> 401', r.status === 401, `got ${r.status}`);
    r = await req(A, 'DELETE', '/api/v1/agents/agent_zzzzzzzzzzzz');
    check('DELETE malformed agent id -> 400', r.status === 400 && errorShape(r), `got ${r.status}`);

    await stopServer(srvA);

    console.log('== server B: ADMIN_KEY gating ==');
    const B = 3102;
    const srvB = await startServer(B, { ADMIN_KEY: 'test-admin-key' });
    r = await req(B, 'GET', '/api/v1/agents');
    check('GET /agents no key -> 403 when ADMIN_KEY set', r.status === 403 && errorShape(r), `got ${r.status}`);
    r = await req(B, 'GET', '/api/v1/agents', { headers: { Authorization: 'Bearer wrong' } });
    check('GET /agents wrong key -> 403', r.status === 403, `got ${r.status}`);
    r = await req(B, 'GET', '/api/v1/agents', { headers: { Authorization: 'Bearer test-admin-key' } });
    check('GET /agents correct Bearer key -> 200', r.status === 200 && r.json.status === 'success', `got ${r.status}`);
    r = await req(B, 'GET', '/api/v1/agents', { headers: { 'x-admin-key': 'test-admin-key' } });
    check('GET /agents x-admin-key header -> 200', r.status === 200, `got ${r.status}`);
    r = await req(B, 'GET', '/api/status');
    check('/api/status reports adminGateConfigured=true', r.json.security.adminGateConfigured === true);
    await stopServer(srvB);

    console.log('== server C: auth rate limiting ==');
    const C = 3103;
    const srvC = await startServer(C, { AUTH_RATE_MAX: '3', AUTH_RATE_WINDOW_MS: '60000' });
    const statuses = [];
    for (let i = 0; i < 5; i++) {
        const rr = await req(C, 'POST', '/api/v1/agents/signup', { body: { handle: `rl-${i}` } });
        statuses.push(rr.status);
        if (i === 4) {
            check('auth rate limit headers present', rr.headers.get('x-ratelimit-limit') === '3', `got ${rr.headers.get('x-ratelimit-limit')}`);
        }
    }
    check('auth bucket trips 429 after 3 signups', statuses.slice(0, 3).every(s => s === 201) && statuses[3] === 429 && statuses[4] === 429, `got [${statuses}]`);
    await stopServer(srvC);

    console.log('== server D: key expiry ==');
    const D = 3104;
    const srvD = await startServer(D, { AGENT_KEY_TTL_DAYS: '0' });
    r = await req(D, 'POST', '/api/v1/agents/signup', { body: { handle: 'short-lived' } });
    const shortKey = r.json.agent.apiKey;
    check('signup with TTL=0 -> 201', r.status === 201, `got ${r.status}`);
    r = await req(D, 'POST', '/api/v1/agents/signin', { body: { apiKey: shortKey } });
    check('signin with expired key -> 401 expired', r.status === 401 && /expired/i.test(r.json.message), `got ${r.status} ${r.text.slice(0, 100)}`);
    await stopServer(srvD);

    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
}

main().catch(err => { console.error('TEST HARNESS ERROR:', err); process.exit(2); });
