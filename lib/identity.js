/**
 * Agent identity business logic — the one place signup/signin/verify/etc.
 * are implemented. Shared by the REST API (lib/app.js), the action-style
 * bridge endpoint error-inbox's client speaks, and the MCP tools
 * (lib/mcp-tools.js), so all three surfaces stay consistent.
 */
const crypto = require('crypto');
const store = require('./store');

// Owner-level orchestrator identity. This used to resolve from a hardcoded
// literal ('999') compared directly against every incoming apiKey -- a
// skeleton key sitting in plain sight in source control (and, until
// recently, in this repo's README too), so anyone who read either file had
// full owner-level access. There is no default value now: if
// AGENTOS_MASTER_KEY isn't set, this identity simply cannot be reached by
// any key. When it is set, the comparison is constant-time so a wrong guess
// doesn't leak timing information.
const MASTER_KEY = process.env.AGENTOS_MASTER_KEY || '';
const MASTER_IDENTITY = {
    agentId: 'agent_master_orchestrator',
    handle: 'master-orchestrator',
    objective: 'Owner-level orchestrator identity',
    status: 'active',
    createdAt: '1970-01-01T00:00:00.000Z',
    tasksCompleted: 0,
    connectedApps: ['error-inbox'],
    lastSeen: null
};

function isMasterKey(candidate) {
    if (!MASTER_KEY || typeof candidate !== 'string' || !candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(MASTER_KEY);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicAgent(agent) {
    const { apiKey, ...pub } = agent;
    return pub;
}

async function signup(handle, objective) {
    if (!handle || !String(handle).trim()) {
        return { status: 'error', message: "'handle' is required." };
    }
    const agentId = `agent_${crypto.randomBytes(6).toString('hex')}`;
    const apiKey = `agk_${crypto.randomBytes(18).toString('hex')}`;
    const agent = {
        agentId,
        apiKey,
        handle: String(handle).trim(),
        objective: (objective && String(objective).trim()) || 'Autonomous agent',
        status: 'active',
        createdAt: new Date().toISOString(),
        tasksCompleted: 0,
        connectedApps: [],
        lastSeen: new Date().toISOString()
    };
    await store.insertAgent(agent);
    return { status: 'created', message: 'Agent identity provisioned.', agent };
}

async function signin(apiKey) {
    if (!apiKey) return { status: 'error', message: "'apiKey' is required." };
    if (isMasterKey(apiKey)) {
        return { status: 'authenticated', agent: MASTER_IDENTITY };
    }
    const agent = await store.getByKey(apiKey);
    if (!agent) return { status: 'error', message: 'Invalid API key.' };
    const updated = await store.update(apiKey, { lastSeen: new Date().toISOString() });
    return { status: 'authenticated', agent: publicAgent(updated || agent) };
}

async function verify(apiKey) {
    if (!apiKey) return { status: 'invalid', message: "'apiKey' is required." };
    if (isMasterKey(apiKey)) {
        return { status: 'valid', handle: MASTER_IDENTITY.handle, agentId: MASTER_IDENTITY.agentId };
    }
    const agent = await store.getByKey(apiKey);
    if (!agent || agent.status !== 'active') return { status: 'invalid' };
    return { status: 'valid', handle: agent.handle, agentId: agent.agentId };
}

async function connectApp(apiKey, appName) {
    if (!apiKey || !appName) return { status: 'error', message: "'apiKey' and 'appName' are required." };
    if (isMasterKey(apiKey)) {
        return { status: 'connected', agent: MASTER_IDENTITY };
    }
    const agent = await store.getByKey(apiKey);
    if (!agent) return { status: 'error', message: 'Invalid API key.' };
    const connectedApps = Array.from(new Set([...(agent.connectedApps || []), appName]));
    const updated = await store.update(apiKey, { connectedApps });
    return { status: 'connected', agent: publicAgent(updated || agent) };
}

async function revoke(agentId) {
    if (!agentId) return { status: 'error', message: "'agentId' is required." };
    const ok = await store.remove(agentId);
    if (!ok) return { status: 'error', message: `Agent '${agentId}' not found.` };
    return { status: 'success', message: `Agent '${agentId}' revoked.` };
}

async function list() {
    const agents = await store.list();
    return { status: 'ok', count: agents.length, agents: agents.map(publicAgent) };
}

async function platforms(apiKey) {
    if (!apiKey) return { status: 'error', message: "'apiKey' is required." };
    if (isMasterKey(apiKey)) {
        return { status: 'ok', platforms: MASTER_IDENTITY.connectedApps };
    }
    const agent = await store.getByKey(apiKey);
    if (!agent) return { status: 'error', message: 'Invalid API key.' };
    return { status: 'ok', platforms: agent.connectedApps || [] };
}

module.exports = { signup, signin, verify, connectApp, revoke, list, platforms };
