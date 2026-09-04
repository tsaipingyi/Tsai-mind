-- 003_assistant: in-app Claude assistant conversations.

create table assistant_session (
  id         uuid primary key default gen_random_uuid(),
  title      text,
  project_id uuid references project(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index assistant_session_updated_idx on assistant_session(updated_at desc);

-- One row per turn. `content` holds the Anthropic content blocks verbatim (text / tool_use / tool_result /
-- thinking) so a conversation can be replayed to the API; `text` is the rendered text for listings.
create table assistant_message (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references assistant_session(id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  content    jsonb not null default '[]',
  text       text not null default '',
  created_at timestamptz not null default now()
);
create index assistant_message_session_idx on assistant_message(session_id, created_at);
