-- Tsai Mind 数据库 schema（PostgreSQL 14+）
-- 配合 docs/DESIGN.md 阅读

create extension if not exists "pgcrypto";

create type member_role   as enum ('admin', 'manager', 'member', 'viewer');
create type node_kind     as enum ('goal', 'task', 'milestone', 'note');
create type node_status   as enum ('todo', 'in_progress', 'blocked', 'review', 'done');
create type rollup_mode   as enum ('auto', 'manual');
create type assign_role   as enum ('owner', 'contributor', 'reviewer');
create type change_status as enum ('pending', 'approved', 'rejected', 'withdrawn');
create type dep_type      as enum ('finish_to_start');

create table workspace (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table member (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspace(id),
  email        text not null,
  name         text not null,
  avatar_url   text,
  role         member_role not null default 'member',
  created_at   timestamptz not null default now(),
  unique (workspace_id, email)
);

create table project (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspace(id),
  name          text not null,
  root_node_id  uuid,                       -- 建好根节点后回填
  -- 哪些字段的修改需要负责人确认
  guarded_fields text[] not null default array['owner_id','due_date','start_date','status_done','delete'],
  remind_days_before int not null default 1,
  created_by    uuid not null references member(id),
  created_at    timestamptz not null default now(),
  archived_at   timestamptz
);

create table project_member (
  project_id uuid not null references project(id),
  member_id  uuid not null references member(id),
  role       member_role not null default 'member',
  primary key (project_id, member_id)
);

create table node (
  id              uuid primary key,          -- 客户端生成，支持离线创建
  project_id      uuid not null references project(id),
  parent_id       uuid references node(id),
  rank            text not null,             -- fractional index，兄弟间排序
  title           text not null default '',
  description_yjs bytea,                     -- Yjs 文档快照
  kind            node_kind not null default 'task',
  owner_id        uuid references member(id),
  status          node_status not null default 'todo',
  progress        smallint not null default 0 check (progress between 0 and 100),
  progress_mode   rollup_mode not null default 'auto',
  start_date      date,
  due_date        date,
  date_mode       rollup_mode not null default 'auto',
  estimate_hours  numeric(7,2),
  priority        smallint not null default 3 check (priority between 1 and 4),
  tags            text[] not null default '{}',
  version         int not null default 1,
  created_by      uuid not null references member(id),
  updated_by      uuid not null references member(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  check (start_date is null or due_date is null or start_date <= due_date)
);
create index node_project_parent_idx on node(project_id, parent_id, rank) where deleted_at is null;
create index node_owner_due_idx      on node(owner_id, due_date) where deleted_at is null;

alter table project add constraint project_root_fk foreign key (root_node_id) references node(id);

create table assignment (
  id          uuid primary key default gen_random_uuid(),
  node_id     uuid not null references node(id),
  member_id   uuid not null references member(id),
  role        assign_role not null,
  accepted_at timestamptz,                   -- owner 需要接受，其他角色建时直接填
  created_by  uuid not null references member(id),
  created_at  timestamptz not null default now(),
  unique (node_id, member_id)
);
-- 一个节点只能有一个 owner
create unique index assignment_single_owner on assignment(node_id) where role = 'owner';

create table dependency (
  from_node uuid not null references node(id),   -- 前置
  to_node   uuid not null references node(id),   -- 后续
  type      dep_type not null default 'finish_to_start',
  primary key (from_node, to_node),
  check (from_node <> to_node)
);

create table change (
  id            uuid primary key,
  node_id       uuid not null references node(id),
  field         text not null,
  old_value     jsonb,
  new_value     jsonb,
  reason        text,
  proposed_by   uuid not null references member(id),
  proposed_at   timestamptz not null default now(),
  status        change_status not null default 'pending',
  decided_by    uuid references member(id),
  decided_at    timestamptz,
  decision_note text
);
create index change_pending_idx on change(node_id) where status = 'pending';

create table comment (
  id         uuid primary key,
  node_id    uuid not null references node(id),
  author_id  uuid not null references member(id),
  body       text not null,
  created_at timestamptz not null default now(),
  edited_at  timestamptz
);

-- 操作日志：同步引擎的真相来源，客户端按 server_seq 补拉
create table op (
  server_seq   bigserial primary key,
  project_id   uuid not null references project(id),
  op_id        uuid not null unique,        -- 客户端生成，用于去重
  client_id    text not null,
  actor_id     uuid not null references member(id),
  type         text not null,               -- create_node / update_field / move_node / delete_node / propose_change / decide_change ...
  payload      jsonb not null,
  base_version int,
  received_at  timestamptz not null default now()
);
create index op_project_seq_idx on op(project_id, server_seq);

-- 通知
create table notification (
  id         uuid primary key default gen_random_uuid(),
  member_id  uuid not null references member(id),
  kind       text not null,                 -- assigned / change_proposed / change_decided / due_soon / overdue / digest
  node_id    uuid references node(id),
  change_id  uuid references change(id),
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index notification_unread_idx on notification(member_id, created_at desc) where read_at is null;

-- 查一棵子树（含自身）
-- select * from node_subtree('<node id>');
create or replace function node_subtree(root uuid)
returns setof node language sql stable as $$
  with recursive t as (
    select * from node where id = root and deleted_at is null
    union all
    select n.* from node n join t on n.parent_id = t.id where n.deleted_at is null
  )
  select * from t;
$$;

-- ---------------------------------------------------------------------------
-- Claude 接入相关（见 docs/mcp-tools.md）
-- ---------------------------------------------------------------------------

create type actor_type as enum ('user', 'agent', 'system');

-- op / comment / notification 记录操作来源：用户直接操作、经 Claude、系统自动
alter table op      add column actor_type actor_type not null default 'user';
alter table comment add column actor_type actor_type not null default 'user';

-- 活动流（导图侧栏和周会摘要读这张表）
create table activity (
  id          bigserial primary key,
  project_id  uuid not null references project(id),
  node_id     uuid references node(id),
  actor_id    uuid not null references member(id),
  actor_type  actor_type not null default 'user',
  kind        text not null,          -- node_created / field_changed / moved / assigned / change_proposed / change_decided / plan_applied ...
  payload     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index activity_project_idx on activity(project_id, created_at desc);
create index activity_node_idx    on activity(node_id, created_at desc);

-- OAuth 客户端（claude.ai / Claude Code 动态注册产生）
create table oauth_client (
  id            text primary key,     -- client_id
  name          text not null,
  redirect_uris text[] not null,
  created_at    timestamptz not null default now()
);

-- 访问令牌：OAuth 授权得到的，或用户手动生成的个人访问令牌
create table access_token (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references member(id),
  client_id   text references oauth_client(id),   -- null 表示个人访问令牌
  token_hash  text not null unique,
  scopes      text[] not null,                    -- read / write / decide
  label       text,                               -- 用户给 PAT 起的名字
  expires_at  timestamptz,
  last_used_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index access_token_member_idx on access_token(member_id) where revoked_at is null;

-- 草案批次：Claude 批量改动先落这里，用户确认后才应用
create type plan_batch_status as enum ('draft', 'applied', 'discarded');

create table plan_batch (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references project(id),
  parent_id   uuid not null references node(id),
  mode        text not null check (mode in ('append', 'sync', 'replace')),
  outline     text not null,          -- Claude 提交的原始大纲
  diff        jsonb not null,         -- 解析后的 create / update / delete 列表
  created_by  uuid not null references member(id),
  actor_type  actor_type not null default 'agent',
  status      plan_batch_status not null default 'draft',
  applied_at  timestamptz,
  result      jsonb,                  -- 应用结果：直接生效的、变成提案的、失败的
  created_at  timestamptz not null default now()
);
create index plan_batch_open_idx on plan_batch(project_id) where status = 'draft';
