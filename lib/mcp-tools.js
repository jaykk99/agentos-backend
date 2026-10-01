/**
 * MCP tool definitions for AgentOS identity — the same operations the REST
 * API exposes, wired up for MCP clients (Claude Code, other agents). One
 * factory so both the stdio entrypoint (bin/mcp-stdio.js) and the HTTP
 * transport (lib/app.js's /api/mcp route) register identical tools.
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const identity = require('./identity');
const browse = require('./browse');

function json(result) {
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function createAgentOsServer() {
    const server = new McpServer({ name: 'agentos', version: '1.0.0' });

    server.registerTool(
        'agent_signup',
        {
            title: 'Create an AgentOS identity',
            description: "Provision a new agent identity and API key (agk_...). The key is returned only in this response — callers must store it.",
            inputSchema: {
                handle: z.string().describe('Short human-readable name for the agent'),
                objective: z.string().optional().describe('What this agent is for')
            }
        },
        async ({ handle, objective }) => json(await identity.signup(handle, objective))
    );

    server.registerTool(
        'agent_signin',
        {
            title: 'Sign in with an AgentOS API key',
            description: 'Authenticate an existing agent identity with its API key.',
            inputSchema: { apiKey: z.string().describe("agk_... API key from agent_signup.") }
        },
        async ({ apiKey }) => json(await identity.signin(apiKey))
    );

    server.registerTool(
        'agent_verify',
        {
            title: 'Verify an AgentOS API key',
            description: 'Quick validity check for an API key — use for gating access without a full sign-in.',
            inputSchema: { apiKey: z.string() }
        },
        async ({ apiKey }) => json(await identity.verify(apiKey))
    );

    server.registerTool(
        'agent_connect_app',
        {
            title: 'Connect an agent to an app',
            description: 'Link an agent identity to a named app/platform it is allowed to operate in.',
            inputSchema: { apiKey: z.string(), appName: z.string() }
        },
        async ({ apiKey, appName }) => json(await identity.connectApp(apiKey, appName))
    );

    server.registerTool(
        'agent_platforms',
        {
            title: "List an agent's connected apps",
            description: 'Ask AgentOS which apps/platforms this API key is connected to.',
            inputSchema: { apiKey: z.string() }
        },
        async ({ apiKey }) => json(await identity.platforms(apiKey))
    );

    server.registerTool(
        'agent_list',
        {
            title: 'List all registered agents',
            description: 'Return the full agent directory (no API keys included).',
            inputSchema: {}
        },
        async () => json(await identity.list())
    );

    server.registerTool(
        'agent_revoke',
        {
            title: 'Revoke an agent identity',
            description: "Delete an agent by its agentId. Its API key stops working immediately.",
            inputSchema: { agentId: z.string() }
        },
        async ({ agentId }) => {
            try {
                const { handle } = core.deleteAgent(agentId);
                return json({ status: 'success', message: `Agent '${handle}' (${agentId}) successfully deleted.` });
            } catch (error) {
                return json(await identity.revoke(agentId));
            }
        }
    );

    server.registerTool(
        'agent_browse',
        {
            title: 'Fetch a web page',
            description: 'Real HTTP GET of a URL — returns its title and readable text (HTML stripped of scripts/styles/nav). No JS execution, no headless browser. Fails honestly on bad status/timeout rather than inventing content.',
            inputSchema: { url: z.string().describe('Full URL to fetch, including https://') }
        },
        async ({ url }) => json(await browse.browseUrl(url))
    );

    server.registerTool(
        'agent_search',
        {
            title: 'Search the web',
            description: 'Real web search (DuckDuckGo HTML, no API key required) — returns real result titles, URLs, and snippets.',
            inputSchema: {
                query: z.string(),
                limit: z.number().int().min(1).max(20).optional().describe('Max results, default 8')
            }
        },
        async ({ query, limit }) => json(await browse.searchWeb(query, limit))
    );

    return server;
}

module.exports = { createAgentOsServer };
