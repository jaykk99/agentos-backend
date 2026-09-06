#!/usr/bin/env node
/**
 * Local/stdio entrypoint — run this to add AgentOS as an MCP server to
 * Claude Code, Claude Desktop, or any other MCP client:
 *
 *   claude mcp add agentos -- node /path/to/agentos-backend/bin/mcp-stdio.js
 *
 * Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment so this
 * process sees the same agent directory as the deployed REST API. Without
 * them it falls back to an in-memory store scoped to this process only.
 */
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createAgentOsServer } = require('../lib/mcp-tools.js');

async function main() {
    const server = createAgentOsServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error('[AgentOS MCP] Fatal error:', err);
    process.exit(1);
});
