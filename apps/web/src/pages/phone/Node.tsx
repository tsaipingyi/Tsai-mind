import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { daysBetween, isWaitingOnDependency } from '@tsai-mind/core';
import type { NodeStatus, TNode } from '@tsai-mind/core';
import { useProject } from '../../state/project';
import { activityActor } from '../../api/types';
import { describeActivity, useNodeActivity } from '../../editor/activity';
import { BackChevron, Chevron, Empty, MoreRow, PendingCard, PhoneBtn, PhoneStatusPill, Sheet, StatusDot } from '../../components/phone';
import { contactName, daysAgo, fmtDate, relTime, today } from '../../lib/util';
import { shareOrCopy } from '../../lib/share';

/** The four statuses on the pill row; 等待中 lives under 更多. */
const PILLS: NodeStatus[] = ['todo', 'in_progress', 'blocked', 'done'];
const PRIORITIES: { v: 1 | 2 | 3 | 4; label: string }[] = [
  { v: 1, label: '最高' },
  { v: 2, label: '高' },
  { v: 3, label: '普通' },
  { v: 4, label: '低' },
];

/**
 * 节点详情 on the phone (design/mobile-v2/Node.dc.html): path, editable title, four status pills, a card with
 * 截止 / 负责人 / 进度, the node's pending cards, 催办, and「更多」for everything else.
 * Business logic (ops, confirmation, rollup) is the same store the desktop sidebar uses.
 */
export function PhoneNodePage() {
  const { id, nodeId } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const projectId = useProject((s) => s.projectId);
  const project = useProject((s) => s.project);
  const loading = useProject((s) => s.loading);
  const error = useProject((s) => s.error);
  const load = useProject((s) => s.load);
  const store = useProject((s) => s.store);
  const rev = useProject((s) => s.rev);
  const derived = useProject((s) => s.derived);
  const contacts = useProject((s) => s.contacts);
  const pending = useProject((s) => s.pending);
  const dependencies = useProject((s) => s.dependencies);
  const slips = useProject((s) => s.slips);
  const updateNode = useProject((s) => s.updateNode);
  const decideChanges = useProject((s) => s.decideChanges);
  const nudge = useProject((s) => s.nudge);
  const select = useProject((s) => s.select);

  useEffect(() => {
    if (id && projectId !== id) void load(id);
  }, [id, projectId, load]);
  const ready = !!project && projectId === id;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const node = useMemo(() => (ready && nodeId ? store.live(nodeId) : undefined), [ready, store, rev, nodeId]);
  useEffect(() => {
    if (node) select(node.id);
  }, [node?.id, select, node]);
  const d = node ? derived.get(node.id) : undefined;

  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [hours, setHours] = useState('');
  const [tags, setTags] = useState('');
  useEffect(() => setTitle(node?.title ?? ''), [node?.id, node?.title]);
  useEffect(() => setDesc(node?.description ?? ''), [node?.id, node?.description]);
  useEffect(() => setHours(node?.estimateHours == null ? '' : String(node.estimateHours)), [node?.id, node?.estimateHours]);
  useEffect(() => setTags((node?.tags ?? []).join(', ')), [node?.id, node?.tags]);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (params.get('focus') === '1' && node && !focused.current) {
      focused.current = true;
      titleRef.current?.focus();
    }
  }, [params, node]);

  const activity = useNodeActivity(more ? projectId : null, node?.id, node?.version, node?.lastNudgedAt);

  const back = () => nav(`/projects/${id}`);

  if (error && !ready)
    return (
      <div className="ph-page">
        <Empty text={error} />
      </div>
    );
  if (!ready || loading)
    return (
      <div className="ph-page">
        <div className="ph-empty">加载中…</div>
      </div>
    );
  if (!node)
    return (
      <div className="ph-page">
        <div className="ph-title-row">
          <BackChevron onClick={back} testId="node-back" />
        </div>
        <Empty text="这个节点已被删除。" />
      </div>
    );

  const hasKids = !!d?.hasChildren;
  const progAuto = node.progressMode === 'auto';
  const datesAuto = node.dateMode === 'auto';
  const derivedDates = hasKids && datesAuto;
  const showStart = derivedDates ? d!.startDate : node.startDate;
  const showDue = derivedDates ? d!.dueDate : node.dueDate;
  const progress = d?.progress ?? node.progress;
  const status = hasKids ? d!.status : node.status;
  const t = today();
  const overdue = !!showDue && showDue < t && status !== 'done';
  const overdueDays = overdue && showDue ? daysBetween(showDue, t) : 0;
  const nodePending = pending.filter((c) => c.nodeId === node.id);
  const nudgedDays = daysAgo(node.lastNudgedAt);
  const path = store.path(node.id);
  const owner = contactName(contacts, node.ownerId);
  const isRoot = node.parentId === null;

  const predecessors = dependencies.filter((x) => x.toNode === node.id).map((x) => store.live(x.fromNode)).filter((n): n is TNode => !!n);
  const successors = dependencies.filter((x) => x.fromNode === node.id).map((x) => store.live(x.toNode)).filter((n): n is TNode => !!n);
  const waiting = status !== 'done' && isWaitingOnDependency(node.id, store, derived, dependencies);
  const slipIn = slips.filter((x) => x.toNode === node.id);
  const slipOut = slips.filter((x) => x.fromNode === node.id);
  const titleOf = (nid: string) => store.get(nid)?.title ?? '…';
  const hasDeps = predecessors.length > 0 || successors.length > 0 || slipIn.length > 0 || slipOut.length > 0;

  const commitTitle = () => {
    if (title.trim() !== node.title) updateNode(node.id, { title: title.trim() });
  };
  const commitDesc = () => {
    if (desc !== (node.description ?? '')) updateNode(node.id, { description: desc });
  };
  const commitHours = () => {
    const v = hours.trim() === '' ? null : Number(hours);
    if (v !== null && (!Number.isFinite(v) || v < 0)) {
      setHours(node.estimateHours == null ? '' : String(node.estimateHours));
      return;
    }
    if (v !== node.estimateHours) updateNode(node.id, { estimateHours: v });
  };
  const commitTags = () => {
    const list = tags
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (list.join(',') !== node.tags.join(',')) updateNode(node.id, { tags: list });
  };
  const commitProgress = (v: number) => {
    setDrag(null);
    if (v !== progress) updateNode(node.id, { progress: v });
  };
  const doNudge = async () => {
    const text = await nudge(node.id);
    if (text) await shareOrCopy(text);
  };
  const askClaude = () => nav(`/claude?projectId=${encodeURIComponent(projectId ?? '')}&prefill=${encodeURIComponent(`关于「${node.title}」：`)}&t=${Date.now()}`);
  const nudgeNote = !node.ownerId ? '负责人是你自己，不用催' : nudgedDays === null ? '还没催过' : nudgedDays === 0 ? '今天催过' : `${nudgedDays} 天前催过`;
  const shownProgress = drag ?? progress;

  return (
    <div className="ph-page ph-node" data-testid="phone-node" key={node.id}>
      <div className="ph-title-row">
        <BackChevron onClick={back} testId="node-back" />
        <div className="ph-crumb ellipsis">{path.length ? path.join(' / ') : (project?.name ?? '')}</div>
      </div>
      <input
        ref={titleRef}
        className="ph-node-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        placeholder="标题"
        aria-label="标题"
        data-testid="node-title"
      />

      <div className="ph-stack8">
        <div className="ph-pills">
          {PILLS.map((st) => (
            <PhoneStatusPill key={st} status={st} active={status === st} disabled={hasKids} onClick={hasKids ? undefined : () => updateNode(node.id, { status: st })} />
          ))}
        </div>
        {hasKids ? <div className="ph-note">状态由子节点推导</div> : status === 'waiting' ? <div className="ph-note" style={{ color: 'var(--st-waiting)' }}>等待中 · 在「更多」里改</div> : null}
      </div>

      <div className="ph-card">
        <label className={`ph-card-row${derivedDates ? ' disabled' : ''}`} data-testid="due-row">
          <span className="ph-row-label">截止</span>
          <span className={`ph-row-value mono${overdue ? ' red' : ''}`}>
            {showDue ? fmtDate(showDue) : <span className="faint">未设</span>}
            {overdue ? ` · 逾期 ${overdueDays} 天` : ''}
            {derivedDates ? <span className="ph-note"> 由子节点推导</span> : null}
          </span>
          <Chevron />
          <input type="date" className="ph-date-input" value={showDue ?? ''} disabled={derivedDates} onChange={(e) => updateNode(node.id, { dueDate: e.target.value || null })} aria-label="截止" />
        </label>
        <button type="button" className="ph-card-row" onClick={() => setOwnerOpen(true)} data-testid="owner-row">
          <span className="ph-row-label">负责人</span>
          <span className="ph-row-value ellipsis">{owner}</span>
          <Chevron />
        </button>
        <div className="ph-progress">
          <div className="ph-progress-head">
            <span>进度</span>
            <span className="mono" data-testid="progress-value">
              {shownProgress}%
            </span>
          </div>
          <input
            type="range"
            className="ph-range"
            min={0}
            max={100}
            step={5}
            value={shownProgress}
            disabled={hasKids && progAuto}
            style={{ ['--fill' as string]: `${shownProgress}%` }}
            onChange={(e) => setDrag(Number(e.target.value))}
            onPointerUp={(e) => commitProgress(Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) => commitProgress(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => commitProgress(Number((e.target as HTMLInputElement).value))}
            onBlur={(e) => drag !== null && commitProgress(Number(e.target.value))}
            aria-label="进度"
            data-testid="progress-slider"
          />
          {hasKids ? (
            <div className="ph-note">
              {progAuto ? '按子节点工时加权汇总，不能直接拖。' : '手动填写，不再跟随子节点。'}{' '}
              <button type="button" className="ph-link orange inline" onClick={() => updateNode(node.id, progAuto ? { progressMode: 'manual', progress: d!.progress } : { progressMode: 'auto' })}>
                {progAuto ? '改为手动' : '改回自动'}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {nodePending.map((c) => (
        <PendingCard key={c.id} change={c} title={node.title || '（无标题）'} contacts={contacts} onApprove={() => void decideChanges([c.id], 'approve')} onReject={() => void decideChanges([c.id], 'reject')} />
      ))}

      {!isRoot ? (
        <div className="ph-stack6">
          <PhoneBtn title="催办" height={48} onClick={() => void doNudge()} disabled={!node.ownerId} testId="nudge-btn" />
          <div className="ph-nudge-note" data-testid="nudge-note">
            {nudgeNote}
          </div>
        </div>
      ) : null}

      <div>
        <MoreRow tall top text="更多：开始日、工时、依赖、说明、记录" expanded={more} onClick={() => setMore((v) => !v)} testId="more-toggle" />
        {more ? (
          <div className="ph-more-body" data-testid="more-body">
            <div className="ph-card">
              <label className={`ph-card-row${derivedDates ? ' disabled' : ''}`} data-testid="start-row">
                <span className="ph-row-label">开始日</span>
                <span className="ph-row-value mono">
                  {showStart ? fmtDate(showStart) : <span className="faint">未设</span>}
                  {derivedDates ? <span className="ph-note"> 由子节点推导</span> : null}
                </span>
                <Chevron />
                <input type="date" className="ph-date-input" value={showStart ?? ''} disabled={derivedDates} onChange={(e) => updateNode(node.id, { startDate: e.target.value || null })} aria-label="开始日" />
              </label>
              <label className="ph-card-row" data-testid="estimate-row">
                <span className="ph-row-label">工时</span>
                <input className="ph-row-input" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} onBlur={commitHours} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} placeholder="未设" aria-label="工时" />
                <span className="ph-note">小时</span>
              </label>
              <div className="ph-card-row">
                <span className="ph-row-label">优先级</span>
                <div className="ph-prios">
                  {PRIORITIES.map((p) => (
                    <button key={p.v} type="button" className={`ph-prio${node.priority === p.v ? ' active' : ''}`} onClick={() => updateNode(node.id, { priority: p.v })} aria-pressed={node.priority === p.v}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <label className="ph-card-row last">
                <span className="ph-row-label">标签</span>
                <input className="ph-row-input" value={tags} onChange={(e) => setTags(e.target.value)} onBlur={commitTags} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} placeholder="用逗号分隔" aria-label="标签" />
              </label>
            </div>
            {hasKids ? (
              <div className="ph-note">
                {datesAuto ? '日期由子节点推导。' : '日期已锁定，不再跟随子节点。'}{' '}
                <button type="button" className="ph-link orange inline" onClick={() => updateNode(node.id, datesAuto ? { dateMode: 'manual', startDate: d!.startDate, dueDate: d!.dueDate } : { dateMode: 'auto' })}>
                  {datesAuto ? '锁定日期' : '跟随子节点'}
                </button>
              </div>
            ) : null}

            {!hasKids ? (
              <div className="ph-stack8">
                <div className="ph-h4">其他状态</div>
                <div className="ph-pills">
                  <PhoneStatusPill status="waiting" active={status === 'waiting'} grow={false} onClick={() => updateNode(node.id, { status: status === 'waiting' ? 'todo' : 'waiting' })} />
                </div>
              </div>
            ) : null}

            <div className="ph-stack8">
              <div className="ph-h4">说明</div>
              <textarea className="ph-desc" value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={commitDesc} placeholder="写点说明" aria-label="说明" data-testid="desc-input" />
            </div>

            {hasDeps ? (
              <div className="ph-stack6">
                <div className="ph-h4">依赖</div>
                {waiting ? (
                  <div className="ph-note" style={{ color: 'var(--st-waiting)' }} data-testid="dep-waiting">
                    等待中：前置任务未完成
                  </div>
                ) : null}
                {slipIn.map((x) => (
                  <div key={`in-${x.fromNode}`} className="ph-slip" data-testid={`dep-slip-${x.fromNode}`}>
                    延误 {x.days} 天 · 「{titleOf(x.fromNode)}」截止 {fmtDate(x.fromDue)}，晚于本任务开始 {fmtDate(x.toStart)}
                  </div>
                ))}
                {slipOut.map((x) => (
                  <div key={`out-${x.toNode}`} className="ph-slip">
                    拖累「{titleOf(x.toNode)}」延误 {x.days} 天
                  </div>
                ))}
                {predecessors.length > 0 ? (
                  <>
                    <div className="ph-dep-head">前置任务</div>
                    {predecessors.map((n) => (
                      <DepRow key={n.id} node={n} onClick={() => nav(`/projects/${id}/node/${n.id}`)} />
                    ))}
                  </>
                ) : null}
                {successors.length > 0 ? (
                  <>
                    <div className="ph-dep-head">后续任务</div>
                    {successors.map((n) => (
                      <DepRow key={n.id} node={n} onClick={() => nav(`/projects/${id}/node/${n.id}`)} />
                    ))}
                  </>
                ) : null}
              </div>
            ) : null}

            <div className="ph-stack6">
              <div className="ph-h4">记录</div>
              {activity.length ? (
                activity.map((a) => (
                  <div key={String(a.id)} className="ph-act">
                    <span className="ph-act-time mono">{relTime(a.createdAt)}</span>
                    <span className="ph-act-text">
                      {describeActivity(a)}
                      {activityActor(a) === 'claude' ? <span className="via"> 经 Claude</span> : null}
                    </span>
                  </div>
                ))
              ) : (
                <div className="ph-note">暂无记录</div>
              )}
            </div>

            <PhoneBtn title="问 Claude" height={48} onClick={askClaude} testId="ask-claude-node" />
          </div>
        ) : null}
      </div>

      {ownerOpen ? (
        <Sheet title="负责人" onClose={() => setOwnerOpen(false)} testId="owner-sheet">
          {[{ id: null as string | null, name: '我' }, ...contacts.filter((c) => !c.archivedAt || c.id === node.ownerId)].map((c) => (
            <button
              key={c.id ?? 'me'}
              type="button"
              className={`ph-sheet-row${node.ownerId === c.id ? ' active' : ''}`}
              onClick={() => {
                updateNode(node.id, { ownerId: c.id });
                setOwnerOpen(false);
              }}
              data-testid={`owner-${c.id ?? 'me'}`}
            >
              {c.name}
            </button>
          ))}
        </Sheet>
      ) : null}
    </div>
  );
}

function DepRow({ node: n, onClick }: { node: TNode; onClick: () => void }) {
  const derived = useProject((s) => s.derived);
  const d = derived.get(n.id);
  const status = d?.status ?? n.status;
  const due = d?.dueDate ?? n.dueDate;
  const overdue = !!due && due < today() && status !== 'done';
  return (
    <button type="button" className="ph-dep" onClick={onClick} data-testid={`dep-${n.id}`}>
      <StatusDot status={status} />
      <span className={`ph-dep-title ellipsis${status === 'done' ? ' done' : ''}`}>{n.title || '（无标题）'}</span>
      {due ? <span className={`mono ph-dep-date${overdue ? ' red' : ''}`}>{fmtDate(due)}</span> : null}
      <Chevron />
    </button>
  );
}
