-- 002_oauth: owner password, OAuth 2.1 clients / codes / refresh tokens, device names.

-- Owner password (scrypt), used by the OAuth authorize page.
alter table account add column password_hash text;

-- Dynamically registered OAuth clients (RFC 7591).
create table oauth_client (
  id                         uuid primary key default gen_random_uuid(),
  name                       text not null,
  redirect_uris              text[] not null,
  secret_hash                text,                       -- null when token_endpoint_auth_method = none
  token_endpoint_auth_method text not null default 'none',
  grant_types                text[] not null default array['authorization_code','refresh_token'],
  created_at                 timestamptz not null default now()
);

-- Single-use authorization codes (10 minutes).
create table oauth_code (
  code_hash             text primary key,
  client_id             uuid not null references oauth_client(id) on delete cascade,
  redirect_uri          text not null,
  scopes                text[] not null,
  code_challenge        text not null,
  code_challenge_method text not null default 'S256',
  resource              text,
  expires_at            timestamptz not null,
  used_at               timestamptz,
  created_at            timestamptz not null default now()
);

-- Access tokens: PATs and OAuth-issued tokens share the table and the bearer lookup.
alter table access_token add column client_id uuid references oauth_client(id) on delete cascade;
alter table access_token add column kind text not null default 'pat' check (kind in ('pat', 'oauth'));

-- Refresh tokens (90 days, rotated on use).
create table oauth_refresh_token (
  id              uuid primary key default gen_random_uuid(),
  token_hash      text not null unique,
  client_id       uuid not null references oauth_client(id) on delete cascade,
  access_token_id uuid references access_token(id) on delete set null,
  scopes          text[] not null,
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index oauth_refresh_token_client_idx on oauth_refresh_token(client_id);

-- Push devices: a display name, and one row per push token.
alter table device add column name text;
create unique index device_push_token_idx on device(push_token) where push_token is not null;
