/**
 * Agent identity persistence.
 *
 * Uses Supabase (table `agent_identities`, see supabase/schema.sql) when
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set — required for the REST
 * API and the MCP server to see the same agents, since on Vercel they run as
 * separate processes/instances with no shared memory. Falls back to an
 * in-memory Map otherwise, which only works within a single process (fine
 * for local dev, not for production).
 */
let client = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false }
    });
} else {
    console.warn('[AgentOS Store] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — using in-memory store (single-process only, resets on restart).');
}

const memory = new Map(); // apiKey -> agent record

function rowToAgent(row) {
    return {
        agentId: row.agent_id,
        apiKey: row.api_key,
        handle: row.handle,
        objective: row.objective,
        status: row.status,
        createdAt: row.created_at,
        tasksCompleted: row.tasks_completed,
        connectedApps: row.connected_apps || [],
        lastSeen: row.last_seen
    };
}

async function insertAgent(agent) {
    if (client) {
        const { error } = await client.from('agent_identities').insert({
            agent_id: agent.agentId,
            api_key: agent.apiKey,
            handle: agent.handle,
            objective: agent.objective,
            status: agent.status,
            created_at: agent.createdAt,
            tasks_completed: agent.tasksCompleted,
            connected_apps: agent.connectedApps,
            last_seen: agent.lastSeen
        });
        if (error) throw new Error(error.message);
        return agent;
    }
    memory.set(agent.apiKey, agent);
    return agent;
}

async function getByKey(apiKey) {
    if (client) {
        const { data, error } = await client.from('agent_identities').select('*').eq('api_key', apiKey).maybeSingle();
        if (error) throw new Error(error.message);
        return data ? rowToAgent(data) : null;
    }
    return memory.get(apiKey) || null;
}

async function getById(agentId) {
    if (client) {
        const { data, error } = await client.from('agent_identities').select('*').eq('agent_id', agentId).maybeSingle();
        if (error) throw new Error(error.message);
        return data ? rowToAgent(data) : null;
    }
    for (const agent of memory.values()) {
        if (agent.agentId === agentId) return agent;
    }
    return null;
}

async function list() {
    if (client) {
        const { data, error } = await client.from('agent_identities').select('*').order('created_at', { ascending: false });
        if (error) throw new Error(error.message);
        return (data || []).map(rowToAgent);
    }
    return Array.from(memory.values());
}

async function update(apiKey, patch) {
    if (client) {
        const dbPatch = {};
        if (patch.tasksCompleted !== undefined) dbPatch.tasks_completed = patch.tasksCompleted;
        if (patch.connectedApps !== undefined) dbPatch.connected_apps = patch.connectedApps;
        if (patch.lastSeen !== undefined) dbPatch.last_seen = patch.lastSeen;
        if (patch.status !== undefined) dbPatch.status = patch.status;
        const { error } = await client.from('agent_identities').update(dbPatch).eq('api_key', apiKey);
        if (error) throw new Error(error.message);
        return getByKey(apiKey);
    }
    const agent = memory.get(apiKey);
    if (!agent) return null;
    Object.assign(agent, patch);
    return agent;
}

async function remove(agentId) {
    const agent = await getById(agentId);
    if (!agent) return false;
    if (client) {
        const { error } = await client.from('agent_identities').delete().eq('agent_id', agentId);
        if (error) throw new Error(error.message);
    } else {
        memory.delete(agent.apiKey);
    }
    return true;
}

module.exports = { insertAgent, getByKey, getById, list, update, remove };
