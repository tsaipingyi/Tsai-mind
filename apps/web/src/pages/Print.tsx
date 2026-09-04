import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { TreeStore, computeCriticalPath, computeRollup, findDependencySlips } from '@tsai-mind/core';
import type { Contact, TNode } from '@tsai-mind/core';
import { api, errorMessage } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { GanttPrintSvg } from '../editor/GanttChart';
import { buildRows, buildScale } from '../editor/ganttLayout';
import { STATUS_LABEL, fmtDate, fmtRange, today } from '../lib/util';

export function PrintPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState<ProjectDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api.getProject(id).then(setData).catch((e) => setErr(errorMessage(e)));
  }, [id]);

  useEffect(() => {
    document.title = data ? `${data.project.name} · Tsai Mind` : 'Tsai Mind';
  }, [data]);

  const model = useMemo(() => {
    if (!data) return null;
    const store = new TreeStore(data.nodes);
    const derived = computeRollup(store);
    const deps = data.dependencies ?? [];
    const criticalPath = data.criticalPath ?? computeCriticalPath(store, derived);
    const slips = data.slips ?? findDependencySlips(store, derived, deps).map((x) => ({ fromNode: x.from.id, toNode: x.to.id, fromDue: x.fromDue, toStart: x.toStart, days: x.days }));
    const rows = buildRows(store, derived, new Set(), criticalPath);
    const scale = buildScale(rows, 'week', today(), { minDays: 28 });
    return { store, derived, deps, slips, rows, scale };
  }, [data]);

  // auto print when opened from the export menu
  useEffect(() => {
    if (!model || params.get('print') !== '1') return;
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, [model, params]);

  if (err) return <div className="print-page red">{err}</div>;
  if (!data || !model) return <div className="print-page faint">加载中…</div>;

  const contacts = data.contacts;
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const root = model.store.root();

  return (
    <div className="print-page" data-testid="print">
      <div className="print-actions no-print">
        <button className="btn primary" onClick={() => window.print()}>
          打印 / 另存为 PDF
        </button>
        <button className="btn" onClick={() => window.close()}>
          关闭
        </button>
      </div>
      <header className="print-head">
        <h1>{data.project.name}</h1>
        <div className="print-meta mono">
          {today()} · {model.rows.length} 个节点
          {model.slips.length > 0 && <span className="red"> · {model.slips.length} 处延误</span>}
        </div>
      </header>
      <section>
        <h2>大纲</h2>
        {root && <OutlineList node={root} store={model.store} derived={model.derived} byId={byId} />}
      </section>
      <section className="print-gantt">
        <h2>甘特图</h2>
        <GanttPrintSvg rows={model.rows} scale={model.scale} deps={model.deps} slips={model.slips} contacts={contacts} />
      </section>
    </div>
  );
}

function OutlineList({ node, store, derived, byId }: { node: TNode; store: TreeStore; derived: ReturnType<typeof computeRollup>; byId: Map<string, Contact> }) {
  const d = derived.get(node.id);
  const status = d?.status ?? node.status;
  const owner = node.ownerId === null ? '我' : (byId.get(node.ownerId)?.name ?? '?');
  const kids = store.children(node.id);
  return (
    <ul className="print-outline">
      <li>
        <span className="t">
          {node.kind === 'milestone' ? '◆ ' : ''}
          {node.title}
        </span>
        <span className="m">
          {node.parentId !== null && <span>@{owner}</span>}
          <span className="mono">{fmtRange(d?.startDate ?? node.startDate, d?.dueDate ?? node.dueDate) || (node.dueDate ? fmtDate(node.dueDate) : '')}</span>
          <span className={`pill st-${status}`}>{STATUS_LABEL[status]}</span>
          {(d?.progress ?? node.progress) > 0 && <span className="mono">{d?.progress ?? node.progress}%</span>}
        </span>
        {kids.map((k) => (
          <OutlineList key={k.id} node={k} store={store} derived={derived} byId={byId} />
        ))}
      </li>
    </ul>
  );
}
