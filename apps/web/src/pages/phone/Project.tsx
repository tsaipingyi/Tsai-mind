import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { TNode } from '@tsai-mind/core';
import { useProject } from '../../state/project';
import { MindMap } from '../../editor/MindMap';
import { PhoneOutline } from '../../editor/PhoneOutline';
import { BackChevron, Empty, HeaderLink } from '../../components/phone';
import { PlusIcon } from '../../components/icons';
import { fmtDate } from '../../lib/util';

type PhoneView = 'outline' | 'map';

/**
 * Project on the phone (design/mobile-v2/Project.dc.html): ‹ + title + meta + 问 Claude, a 列表 | 导图 segment
 * (列表 default), the outline rows and the orange「+」that adds a child under the selected (else root) node.
 * The store is kept loaded when leaving for the node page, so back is instant.
 */
export function PhoneProjectPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const projectId = useProject((s) => s.projectId);
  const project = useProject((s) => s.project);
  const loading = useProject((s) => s.loading);
  const error = useProject((s) => s.error);
  const load = useProject((s) => s.load);
  const store = useProject((s) => s.store);
  const rev = useProject((s) => s.rev);
  const derived = useProject((s) => s.derived);
  const slips = useProject((s) => s.slips);
  const createChild = useProject((s) => s.createChild);
  const select = useProject((s) => s.select);
  const [view, setView] = useState<PhoneView>('outline');

  useEffect(() => {
    if (id && projectId !== id) void load(id);
  }, [id, projectId, load]);
  // entering the project page starts from the root, so「+」adds a top-level node until a row is opened
  useEffect(() => {
    if (project && projectId === id) select(project.rootNodeId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, projectId, id]);

  // ?node=… deep links (desktop links, 联系人 page) go to the node page
  useEffect(() => {
    const nodeId = params.get('node');
    if (id && nodeId) nav(`/projects/${id}/node/${nodeId}`, { replace: true });
  }, [params, id, nav]);

  const ready = !!project && projectId === id;

  const meta = useMemo(() => {
    if (!ready) return '';
    const root = store.root();
    const d = root ? derived.get(root.id) : undefined;
    const parts: string[] = [];
    if (d) parts.push(`进度 ${d.progress}%`);
    const due = (n: TNode) => derived.get(n.id)?.dueDate ?? n.dueDate;
    const milestones = store
      .all()
      .filter((n) => n.kind === 'milestone' && due(n))
      .sort((a, b) => (due(a)! < due(b)! ? 1 : -1));
    const m = milestones[0];
    if (m) parts.push(`${fmtDate(due(m))} ${m.title}`);
    else if (d?.dueDate) parts.push(`截止 ${fmtDate(d.dueDate)}`);
    if (slips.length) parts.push(`${slips.length} 处延误`);
    return parts.join(' · ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, store, rev, derived, slips]);

  const open = (nodeId: string) => nav(`/projects/${id}/node/${nodeId}`);
  const back = () => nav('/projects');
  const askClaude = () => nav(`/claude?projectId=${encodeURIComponent(id ?? '')}&t=${Date.now()}`);
  const add = () => {
    const st = useProject.getState();
    const root = st.store.root();
    if (!id || !root) return;
    const parent = st.selectedId && st.store.live(st.selectedId) ? st.selectedId : root.id;
    const nid = createChild(parent);
    if (nid) nav(`/projects/${id}/node/${nid}?focus=1`);
  };

  return (
    <div className="ph-project" data-testid="phone-project">
      <div className="ph-project-head">
        <BackChevron onClick={back} testId="project-back" />
        <div className="ph-project-titles">
          <div className="ph-h2 ellipsis">{project?.name ?? '项目'}</div>
          {meta ? (
            <div className="ph-meta ellipsis" data-testid="project-meta">
              {meta}
            </div>
          ) : null}
        </div>
        <HeaderLink title="问 Claude" tone="orange" onClick={askClaude} testId="ask-claude" />
      </div>
      <div className="ph-segment" role="tablist">
        {(['outline', 'map'] as PhoneView[]).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'active' : ''} onClick={() => setView(v)} data-testid={`view-${v}`}>
            {v === 'outline' ? '列表' : '导图'}
          </button>
        ))}
      </div>
      <div className="ph-project-body">
        {error && !ready ? (
          <div style={{ padding: '0 20px' }}>
            <Empty text={error} />
            <button type="button" className="ph-link orange" onClick={() => id && void load(id)}>
              重试
            </button>
          </div>
        ) : !ready || loading ? (
          <div className="ph-empty" style={{ padding: '14px 20px' }}>
            加载中…
          </div>
        ) : view === 'outline' ? (
          <PhoneOutline onOpen={open} footer={<div className="ph-hint">点一行看详情 · 点右上角「问 Claude」拆任务</div>} />
        ) : (
          <div className="ph-map">
            <MindMap readOnly onOpen={open} />
          </div>
        )}
      </div>
      {ready ? (
        <button type="button" className="ph-fab" onClick={add} aria-label="新建节点" data-testid="add-node">
          <PlusIcon />
        </button>
      ) : null}
    </div>
  );
}
