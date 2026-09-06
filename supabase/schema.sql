-- AgentOS identity store. Optional: without SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
-- set, lib/store.js falls back to an in-memory store (single process only).
-- With them set, run this once in the Supabase SQL editor so the REST API and
-- the MCP server share the same agent directory.

create table if not exists agent_identities (
  agent_id text primary key,
  api_key text unique not null,
  handle text not null,
  objective text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  tasks_completed integer not null default 0,
  connected_apps text[] not null default '{}',
  last_seen timestamptz
);

create index if not exists agent_identities_api_key_idx on agent_identities (api_key);

alter table agent_identities enable row level security;

-- Accessed only via the Supabase service-role key from server-side code
-- (lib/store.js) — no anon/client access, so no additional policies needed.
