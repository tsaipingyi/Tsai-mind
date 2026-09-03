-- 001_init: Tsai Mind schema. Copied verbatim from docs/schema.sql (the source of truth),
-- plus the schema_migrations bookkeeping table used by src/migrate.ts.

create table if not exists schema_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);

-- Tsai Mind 数据库 schema（PostgreSQL 14+），单用户版
-- 配合 docs/DESIGN.md 阅读

create extension if not exists "pgcrypto";

create type node_kind     as enum ('goal', 'task', 'milestone', 'note');
create type node_status   as enum ('todo', 'in_progress', 'blocked', 'waiting', 'done');
create type rollup_mode   as enum ('auto', 'manual');
create type actor_type    as enum ('user', 'claude', 'system');
create type change_source as enum ('claude', 'batch');
create type change_status as enum ('pending', 'approved', 'rejected', 'expired');
create type batch_status  as enum ('draft', 'applied', 'discarded');

-- 只有一行：你
create table account (
  id           uuid primary key default gen_random_uuid(),
  email        text not null unique,
  name         text not null,
  timezone     text not null default 'Asia/Taipei',
  settings     jsonb not null default '{}',   -- 关键字段列表、是否要求 Claude 走确认、催办模板等
  created_at   timestamptz not null default now()
);

-- 联系人：你指派任务的人，不登录
create table contact (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  company    text,
  email      text,
  phone      text,
  avatar_url text,
  notes      text,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table project (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  root_node_id  uuid,                          -- 建好根节点后回填
  created_at    timestamptz not null default now(),
  archived_at   timestamptz
);

create table node (
  id              uuid primary key,            -- 客户端生成，支持离线创建
  project_id      uuid not null references project(id),
  parent_id       uuid references node(id),
  rank            text not null,               -- fractional index
  title           text not null default '',
  description     text not null default '',    -- Markdown
  kind            node_kind not null default 'task',
  owner_id        uuid references contact(id), -- null = 你自己
  status          node_status not null default 'todo',
  progress        smallint not null default 0 check (progress between 0 and 100),
  progress_mode   rollup_mode not null default 'auto',
  start_date      date,
  due_date        date,
  date_mode       rollup_mode not null default 'auto',
  estimate_hours  numeric(7,2),
  priority        smallint not null default 3 check (priority between 1 and 4),
  tags            text[] not null default '{}',
  last_nudged_at  timestamptz,
  version         int not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  check (start_date is null or due_date is null or start_date <= due_date)
);
create index node_project_parent_idx on node(project_id, parent_id, rank) where deleted_at is null;
create index node_owner_due_idx      on node(owner_id, due_date) where deleted_at is null;
create index node_due_idx            on node(due_date) where deleted_at is null and status <> 'done';

alter table project add constraint project_root_fk foreign key (root_node_id) references node(id);

create table dependency (
  from_node uuid not null references node(id),   -- 前置
  to_node   uuid not null references node(id),   -- 后续
  primary key (from_node, to_node),
  check (from_node <> to_node)
);

-- 节点备注，时间线式（和 description 不同：description 是说明，note 是过程记录）
create table note (
  id         uuid primary key,
  node_id    uuid not null references node(id),
  body       text not null,
  actor_type actor_type not null default 'user',
  created_at timestamptz not null default now()
);
create index note_node_idx on note(node_id, created_at desc);

-- 待确认的变更：来自 Claude 或批量操作
create table change (
  id          uuid primary key,
  node_id     uuid not null references node(id),
  field       text not null,
  old_value   jsonb,
  new_value   jsonb,
  reason      text,
  source      change_source not null,
  batch_id    uuid,                             -- 来自草案时指向 plan_batch
  status      change_status not null default 'pending',
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days'
);
create index change_pending_idx on change(node_id) where status = 'pending';
create unique index change_one_pending_per_field on change(node_id, field) where status = 'pending';

-- 草案批次：Claude 批量改动先落这里，确认后才应用
create table plan_batch (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references project(id),
  parent_id   uuid not null references node(id),
  mode        text not null check (mode in ('append', 'sync', 'replace')),
  outline     text not null,                    -- Claude 提交的原始大纲
  diff        jsonb not null,                   -- 解析后的 create / update / delete 列表
  status      batch_status not null default 'draft',
  applied_at  timestamptz,
  result      jsonb,
  created_at  timestamptz not null default now()
);
create index plan_batch_open_idx on plan_batch(project_id) where status = 'draft';

-- 操作日志：同步引擎的真相来源，客户端按 server_seq 补拉；也是撤销的依据
create table op (
  server_seq   bigserial primary key,
  project_id   uuid not null references project(id),
  op_id        uuid not null unique,            -- 客户端生成，用于去重
  client_id    text not null,                   -- web / ios / claude / server
  actor_type   actor_type not null default 'user',
  type         text not null,                   -- create_node / update_field / move_node / delete_node / apply_batch / undo ...
  payload      jsonb not null,
  inverse      jsonb,                            -- 撤销用的反向操作
  base_version int,
  undone_by    bigint references op(server_seq),
  received_at  timestamptz not null default now()
);
create index op_project_seq_idx on op(project_id, server_seq);

-- 活动流（侧栏和周摘要读这张表）
create table activity (
  id          bigserial primary key,
  project_id  uuid not null references project(id),
  node_id     uuid references node(id),
  actor_type  actor_type not null default 'user',
  kind        text not null,                    -- node_created / field_changed / moved / nudged / change_proposed / change_decided / batch_applied ...
  payload     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index activity_project_idx on activity(project_id, created_at desc);
create index activity_node_idx    on activity(node_id, created_at desc);

-- 推送
create table notification (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null,                     -- change_proposed / batch_ready / due_soon / overdue / nudge_due / dependency_slip / digest
  node_id    uuid references node(id),
  change_id  uuid references change(id),
  batch_id   uuid references plan_batch(id),
  payload    jsonb not null default '{}',
  sent_at    timestamptz,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create table device (
  id            uuid primary key default gen_random_uuid(),
  platform      text not null check (platform in ('ios', 'web')),
  push_token    text,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now()
);

-- Claude 接入用的个人访问令牌
create table access_token (
  id           uuid primary key default gen_random_uuid(),
  token_hash   text not null unique,
  label        text not null,                   -- 例如 "Claude Code on MacBook"
  scopes       text[] not null default array['read','write'],   -- read / write / decide
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

-- 查一棵子树（含自身）
create or replace function node_subtree(root uuid)
returns setof node language sql stable as $$
  with recursive t as (
    select * from node where id = root and deleted_at is null
    union all
    select n.* from node n join t on n.parent_id = t.id where n.deleted_at is null
  )
  select * from t;
$$;
