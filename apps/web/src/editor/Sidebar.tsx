import { useEffect, useMemo, useRef, useState } from 'react';
import { NODE_KINDS, NODE_STATUSES, dependencyWouldCycle, isWaitingOnDependency } from '@tsai-mind/core';
import type { NodeKind, NodeStatus } from '@tsai-mind/core';
import { useProject } from '../state/project';
import { api } from '../api/client';
import { activityActor, type Activity } from '../api/types';
import { StatusPill } from '../components/ui';
import { FIELD_LABEL, KIND_LABEL, STATUS_LABEL, copyText, fmtDate, relTime, valueLabel } from '../lib/util';
import { toast } from '../state/toast';

const activityCache = new Map<string, Activity[]>();

export function Sidebar() {
  const projectId = useProject((s) => s.projectId);
  const store = useProject((s) => s.store);
  const rev = useProject((s) => s.rev);
  const derived = useProject((s) => s.derived);
  const selectedId = useProject((s) => s.selectedId);
  const contacts = useProject((s) => s.contacts);
  const pending = useProject((s) => s.pending);
  const updateNode = useProject((s) => s.updateNode);
  const decideChanges = useProject((s) => s.decideChanges);
  const nudge = useProject((s) => s.nudge);
  const focusRequest = useProject((s) => s.focusRequest);
  const dependencies = useProject((s) => s.dependencies);
  const addDependency = useProject((s) => s.addDependency);
  const removeDependency = useProject((s) => s.removeDependency);
  const [depQuery, setDepQuery] = useState('');
  const [depBusy, setDepBusy] = useState(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const node = useMemo(() => (selectedId ? store.live(selectedId) : undefined), [store, rev, selectedId]);
  const d = node ? derived.get(node.id) : undefined;

  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [tags, setTags] = useState('');
  const [est, setEst] = useState('');
  useEffect(() => {
    setTitle(node?.title ?? '');
    setDesc(node?.description ?? '');
    setTags(node?.tags.join(', ') ?? '');
    setEst(node?.estimateHours != null ? String(node.estimateHours) : '');
  }, [node?.id, node?.title, node?.description, node?.tags, node?.estimateHours]);

  const dueRef = useRef<HTMLInputElement>(null);
  const startRef = useRef<HTMLInputElement>(null);
  const progRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focusRequest) return;
    const map = { dueDate: dueRef, startDate: startRef, progress: progRef, title: titleRef };
    const el = map[focusRequest.field].current;
    if (el) {
      el.focus();
      if ('showPicker' in el && focusRequest.field !== 'title' && focusRequest.field !== 'progress') {
        try {
          (el as HTMLInputElement).showPicker();
        } catch {
          /* ignore */
        }
      }
    }
  }, [focusRequest]);

  // activity for this node
  const [activity, setActivity] = useState<Activity[]>([]);
  useEffect(() => {
    if (!projectId || !node) return;
    let cancelled = false;
    const nodeId = node.id;
    const apply = (all: Activity[]) => {
      if (cancelled) return;
      setActivity(all.filter((a) => a.nodeId === nodeId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 10));
    };
    const cached = activityCache.get(projectId);
    if (cached) apply(cached);
    api
      .getActivity(projectId)
      .then((all) => {
        activityCache.set(projectId, all);
        apply(all);
      })
      .catch(() => {
        if (!cached) apply([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, node?.id, node?.version, node?.lastNudgedAt]);

  if (!node) {
    return (
      <aside className="sidebar" data-testid="sidebar">
        <div className="empty-side">
          点一个节点查看详情
          <div className="shortcuts-help" style={{ marginTop: 16, textAlign: 'left' }}>
            <div>
              <kbd>Tab</kbd> 加子节点 · <kbd>Enter</kbd> 加兄弟节点
            </div>
            <div>
              <kbd>Delete</kbd> 删除 · <kbd>空格</kbd> 展开/收起
            </div>
            <div>
              <kbd>@</kbd> 指派负责人 · <kbd>/</kbd> 命令面板
            </div>
            <div>
              <kbd>F2</kbd> 或双击改标题 · <kbd>⌘Z</kbd> 撤销
            </div>
          </div>
        </div>
      </aside>
    );
  }

  const hasKids = !!d?.hasChildren;
  const isRoot = node.parentId === null;
  const nodePending = pending.filter((c) => c.nodeId === node.id);
  const kidStart = d?.hasChildren ? childRange(node.id).start : null;
  const kidDue = d?.hasChildren ? childRange(node.id).due : null;

  function childRange(id: string) {
    let start: string | null = null;
    let due: string | null = null;
    for (const k of store.children(id)) {
      const kd = derived.get(k.id);
      if (k.kind === 'note') continue;
      if (kd?.startDate && (!start || kd.startDate < start)) start = kd.startDate;
      if (kd?.dueDate && (!due || kd.dueDate > due)) due = kd.dueDate;
    }
    return { start, due };
  }

  const commitTitle = () => {
    if (title.trim() !== node.title) updateNode(node.id, { title: title.trim() });
  };
  const commitDesc = () => {
    if (desc !== node.description) updateNode(node.id, { description: desc });
  };
  const commitTags = () => {
    const list = tags
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    updateNode(node.id, { tags: list });
  };
  const commitEst = () => {
    const v = est.trim() === '' ? null : Number(est);
    if (v !== null && (!Number.isFinite(v) || v < 0)) {
      setEst(node.estimateHours != null ? String(node.estimateHours) : '');
      return;
    }
    updateNode(node.id, { estimateHours: v });
  };

  const doNudge = async () => {
    const text = await nudge(node.id);
    if (!text) return;
    const copied = await copyText(text);
    toast(`${copied ? '已复制到剪贴板：\n' : ''}${text}`, 'ok', 8000);
  };

  const predecessors = dependencies.filter((x) => x.toNode === node.id).map((x) => ({ dep: x, node: store.get(x.fromNode) }));
  const successors = dependencies.filter((x) => x.fromNode === node.id).map((x) => ({ dep: x, node: store.get(x.toNode) }));
  const waiting = isWaitingOnDependency(node.id, store, derived, dependencies);
  const depCandidates = (() => {
    const q = depQuery.trim().toLowerCase();
    if (!q) return [];
    const have = new Set(predecessors.map((p) => p.dep.fromNode));
    return store
      .all()
      .filter((n) => n.id !== node.id && n.parentId !== null && n.kind !== 'note' && !have.has(n.id) && n.title.toLowerCase().includes(q))
      .slice(0, 8)
      .map((n) => ({ node: n, cycle: dependencyWouldCycle(dependencies, n.id, node.id) || store.isDescendant(n.id, node.id) || store.isDescendant(node.id, n.id) }));
  })();
  const pickPredecessor = async (fromId: string) => {
    setDepBusy(true);
    const ok = await addDependency(fromId, node.id);
    setDepBusy(false);
    if (ok) setDepQuery('');
  };

  const datesAuto = node.dateMode === 'auto';
  const progAuto = node.progressMode === 'auto';
  const showStart = hasKids && datesAuto ? d!.startDate : node.startDate;
  const showDue = hasKids && datesAuto ? d!.dueDate : node.dueDate;

  return (
    <aside className="sidebar" data-testid="sidebar" key={node.id}>
      <div className="crumb">{store.path(node.id).join(' / ') || '根节点'}</div>
      <input
        ref={titleRef}
        className="title-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        placeholder="标题"
        aria-label="标题"
      />

      <section>
        <div className="grid2">
          <label className="field" style={{ margin: 0 }}>
            <span>类型</span>
            <select className="select" value={node.kind} onChange={(e) => updateNode(node.id, { kind: e.target.value as NodeKind })}>
              {NODE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>负责人</span>
            <select
              className="select"
              value={node.ownerId ?? ''}
              onChange={(e) => updateNode(node.id, { ownerId: e.target.value === '' ? null : e.target.value })}
            >
              <option value="">我</option>
              {contacts
                .filter((c) => !c.archivedAt || c.id === node.ownerId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
      </section>

      <section>
        <h4>
          状态
          {hasKids && <span className="note">由子节点推导</span>}
        </h4>
        <div className="pills">
          {NODE_STATUSES.map((s: NodeStatus) =>
            hasKids ? (
              <StatusPill key={s} status={s} active={d!.status === s} />
            ) : (
              <StatusPill key={s} status={s} active={node.status === s} onClick={() => updateNode(node.id, { status: s })} />
            ),
          )}
        </div>
      </section>

      <section>
        <h4>
          进度 <span className="mono">{d?.progress ?? node.progress}%</span>
        </h4>
        <input
          ref={progRef}
          type="range"
          min={0}
          max={100}
          step={5}
          value={d?.progress ?? node.progress}
          disabled={hasKids && progAuto}
          onChange={(e) => updateNode(node.id, { progress: Number(e.target.value) })}
          aria-label="进度"
        />
        {hasKids && (
          <div className="row between">
            <span className="note">{progAuto ? '按子节点工时加权汇总' : '手动填写'}</span>
            <button className="lock" onClick={() => updateNode(node.id, progAuto ? { progressMode: 'manual', progress: d!.progress } : { progressMode: 'auto' })}>
              {progAuto ? '改为手动' : '改回自动'}
            </button>
          </div>
        )}
      </section>

      <section>
        <h4>
          日期
          {hasKids && (
            <button
              className="lock"
              title={datesAuto ? '锁定日期（不再跟随子节点）' : '解锁（跟随子节点）'}
              onClick={() =>
                updateNode(node.id, datesAuto ? { dateMode: 'manual', startDate: d!.startDate, dueDate: d!.dueDate } : { dateMode: 'auto' })
              }
            >
              {datesAuto ? '🔓 跟随子节点' : '🔒 已锁定'}
            </button>
          )}
        </h4>
        <div className="grid2">
          <label className="field" style={{ margin: 0 }}>
            <span>开始</span>
            <input
              ref={startRef}
              className="input mono"
              type="date"
              value={showStart ?? ''}
              disabled={hasKids && datesAuto}
              onChange={(e) => updateNode(node.id, { startDate: e.target.value || null })}
            />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>截止</span>
            <input
              ref={dueRef}
              className="input mono"
              type="date"
              value={showDue ?? ''}
              disabled={hasKids && datesAuto}
              onChange={(e) => updateNode(node.id, { dueDate: e.target.value || null })}
            />
          </label>
        </div>
        {hasKids && !datesAuto && (kidStart || kidDue) && (
          <div className="note" style={{ marginTop: 4 }}>
            子节点范围 {fmtDate(kidStart) || '—'} 到 {fmtDate(kidDue) || '—'}
            {kidDue && node.dueDate && kidDue > node.dueDate && <span className="red"> · 子节点超出截止日</span>}
          </div>
        )}
      </section>

      <section>
        <div className="grid2">
          <label className="field" style={{ margin: 0 }}>
            <span>预估工时</span>
            <input
              className="input mono"
              type="number"
              min={0}
              step={0.5}
              value={est}
              onChange={(e) => setEst(e.target.value)}
              onBlur={commitEst}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              placeholder="小时"
            />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>优先级</span>
            <select className="select" value={node.priority} onChange={(e) => updateNode(node.id, { priority: Number(e.target.value) as 1 | 2 | 3 | 4 })}>
              <option value={1}>P1 最高</option>
              <option value={2}>P2</option>
              <option value={3}>P3</option>
              <option value={4}>P4 最低</option>
            </select>
          </label>
        </div>
      </section>

      {!isRoot && (
        <section data-testid="deps">
          <h4>
            依赖
            {waiting && (
              <span className="note red" data-testid="waiting">
                等待中：前置任务未完成
              </span>
            )}
          </h4>
          <div className="dep-list">
            {predecessors.length === 0 && <div className="note">没有前置任务</div>}
            {predecessors.map(({ dep, node: p }) => {
              const pd = p ? derived.get(p.id) : undefined;
              const pdone = pd?.status === 'done';
              return (
                <div className="dep-item" key={dep.fromNode} data-from={dep.fromNode}>
                  <span className={`dep-dot st-${pd?.status ?? 'todo'}`} />
                  <span className="dep-title" title={p?.title}>
                    {p?.title ?? '（已删除）'}
                  </span>
                  <span className="note mono">{pd?.dueDate ? fmtDate(pd.dueDate) : ''}</span>
                  {!pdone && p && <span className="note">未完成</span>}
                  <button className="lock" title="移除前置" disabled={depBusy} onClick={() => void removeDependency(dep.fromNode, node.id)} aria-label={`移除前置 ${p?.title ?? ''}`}>
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          <div className="dep-add">
            <input
              className="input"
              placeholder="添加前置：输入标题搜索…"
              value={depQuery}
              onChange={(e) => setDepQuery(e.target.value)}
              aria-label="添加前置"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const first = depCandidates.find((c) => !c.cycle);
                  if (first) void pickPredecessor(first.node.id);
                } else if (e.key === 'Escape') setDepQuery('');
              }}
            />
            {depQuery.trim() && (
              <div className="dep-options" role="listbox">
                {depCandidates.length === 0 && <div className="note" style={{ padding: '4px 8px' }}>没有匹配的节点</div>}
                {depCandidates.map((c) => (
                  <button
                    key={c.node.id}
                    role="option"
                    className="dep-option"
                    disabled={c.cycle || depBusy}
                    title={c.cycle ? '会形成循环依赖' : store.path(c.node.id).join(' / ')}
                    onClick={() => void pickPredecessor(c.node.id)}
                  >
                    <span className="dep-title">{c.node.title}</span>
                    <span className="note">{c.cycle ? '会形成循环' : store.path(c.node.id).slice(1).join(' / ')}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {successors.length > 0 && (
            <div className="note" style={{ marginTop: 6 }}>
              后续任务：{successors.map(({ node: sN }) => sN?.title ?? '（已删除）').join('、')}
            </div>
          )}
        </section>
      )}

      <section>
        <label className="field" style={{ margin: 0 }}>
          <span>标签（逗号分隔）</span>
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} onBlur={commitTags} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        </label>
      </section>

      <section>
        <label className="field" style={{ margin: 0 }}>
          <span>描述（Markdown）</span>
          <textarea className="textarea" value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={commitDesc} />
        </label>
      </section>

      {!isRoot && node.ownerId && (
        <section>
          <div className="row between">
            <button className="btn" onClick={() => void doNudge()}>
              催办
            </button>
            <span className="note">{node.lastNudgedAt ? `上次催办 ${relTime(node.lastNudgedAt)}` : '还没催过'}</span>
          </div>
        </section>
      )}

      {nodePending.length > 0 && (
        <section>
          <h4>待确认 {nodePending.length}</h4>
          <div className="stack">
            {nodePending.map((c) => (
              <div className="pending-card" key={c.id} style={{ padding: '8px 10px' }}>
                <div className="body">
                  <div className="diff">
                    {FIELD_LABEL[c.field] ?? c.field}{' '}
                    {c.field === 'delete' ? '' : `${valueLabel(c.field, c.oldValue, contacts)} → ${valueLabel(c.field, c.newValue, contacts)}`}
                  </div>
                  {c.reason && <div className="reason">{c.reason}</div>}
                  <div className="reason">{c.source === 'claude' ? '经 Claude' : '批量操作'}</div>
                </div>
                <div className="actions" style={{ flexDirection: 'column' }}>
                  <button className="btn sm primary" onClick={() => void decideChanges([c.id], 'approve')}>
                    确认
                  </button>
                  <button className="btn sm" onClick={() => void decideChanges([c.id], 'reject')}>
                    拒绝
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h4>最近活动</h4>
        {activity.length ? (
          <div className="activity">
            {activity.map((a) => (
              <div className="item" key={a.id}>
                <span className="when" title={a.createdAt}>
                  {relTime(a.createdAt)}
                </span>
                <span>
                  {describeActivity(a)}
                  {activityActor(a) === 'claude' && <span className="via">经 Claude</span>}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="note">暂无活动记录</div>
        )}
      </section>
    </aside>
  );
}

function fieldChange(k: string, v: unknown): string {
  const label = FIELD_LABEL[k] ?? k;
  if (k === 'status') return `${label} → ${STATUS_LABEL[v as NodeStatus] ?? String(v)}`;
  if (k === 'progress') return `${label} → ${String(v)}%`;
  if (k === 'title') return `改标题为「${String(v)}」`;
  if (k === 'description') return '改了描述';
  if (k === 'dueDate' || k === 'startDate') return `${label} → ${v ? fmtDate(String(v)) : '空'}`;
  if (k === 'lastNudgedAt') return '催办';
  return `改了${label}`;
}

function describeActivity(a: Activity): string {
  const p = a.payload ?? {};
  const kind = a.kind;
  switch (kind) {
    case 'node_created':
    case 'create_node':
      return '创建了节点';
    case 'deleted':
    case 'delete_node':
      return typeof p.count === 'number' && p.count > 1 ? `删除了节点（含 ${p.count - 1} 个子节点）` : '删除了节点';
    case 'restored':
    case 'restore_node':
      return '恢复了节点';
    case 'moved':
    case 'move_node':
      return '移动了节点';
    case 'nudged':
    case 'nudge':
      return '催办';
    case 'undone':
      return '撤销了一步操作';
    case 'note_added':
    case 'note':
      return `备注：${String(p.body ?? '')}`;
    case 'change_proposed':
      return `提议改${FIELD_LABEL[String(p.field)] ?? String(p.field)}${p.to !== undefined ? ` → ${fieldValue(String(p.field), p.to)}` : ''}`;
    case 'change_decided':
      return p.decision === 'approve' || p.decision === 'approved' ? '确认了变更' : p.decision ? '拒绝了变更' : '处理了变更';
    case 'batch_applied':
      return '应用了草案';
    case 'dependency_added':
      return '添加了前置任务';
    case 'dependency_removed':
      return '移除了前置任务';
    case 'field_changed':
    case 'update_node':
    case 'update': {
      const fields = p.fields as Record<string, { from: unknown; to: unknown }> | undefined;
      if (fields) return Object.entries(fields).map(([k, v]) => fieldChange(k, v?.to)).join('，');
      const patch = (p.patch ?? p) as Record<string, unknown>;
      const keys = Object.keys(patch).filter((k) => k in FIELD_LABEL);
      return keys.length ? keys.map((k) => fieldChange(k, patch[k])).join('，') : '更新了节点';
    }
    default:
      return typeof p.message === 'string' ? p.message : kind;
  }
}

function fieldValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '空';
  if (field === 'status') return STATUS_LABEL[v as NodeStatus] ?? String(v);
  if (field === 'dueDate' || field === 'startDate') return fmtDate(String(v));
  return String(v);
}
