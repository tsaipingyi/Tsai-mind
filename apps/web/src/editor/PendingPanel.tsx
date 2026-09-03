import { useMemo, useState } from 'react';
import { useProject } from '../state/project';
import type { PlanBatch } from '../api/types';
import { FIELD_LABEL, valueLabel } from '../lib/util';

export function PendingPanel({ onClose }: { onClose: () => void }) {
  const pending = useProject((s) => s.pending);
  const batches = useProject((s) => s.batches);
  const contacts = useProject((s) => s.contacts);
  const store = useProject((s) => s.store);
  const rev = useProject((s) => s.rev);
  const decideChanges = useProject((s) => s.decideChanges);
  const select = useProject((s) => s.select);
  const [sel, setSel] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSel(n);
  };
  const allSelected = pending.length > 0 && pending.every((c) => sel.has(c.id));
  const ids = [...sel].filter((id) => pending.some((c) => c.id === id));

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const titleOf = useMemo(() => (id: string) => store.get(id)?.title ?? '（已删除的节点）', [store, rev]);

  return (
    <div className="slide-over" role="dialog" aria-label="待确认" data-testid="pending-panel">
      <div className="head">
        <span>待确认 {pending.length}</span>
        <button className="btn sm ghost" onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="body">
        {pending.length === 0 && batches.length === 0 && <div className="empty">没有等你确认的变更。</div>}
        {pending.length > 0 && (
          <label className="row" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
            <input type="checkbox" checked={allSelected} onChange={() => setSel(allSelected ? new Set() : new Set(pending.map((c) => c.id)))} />
            全选
          </label>
        )}
        {pending.map((c) => (
          <div className={`pending-card${sel.has(c.id) ? ' selected' : ''}`} key={c.id}>
            <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} style={{ marginTop: 3 }} />
            <div className="body">
              <div>
                <a
                  href="#"
                  style={{ color: 'inherit', fontWeight: 500 }}
                  onClick={(e) => {
                    e.preventDefault();
                    select(c.nodeId);
                  }}
                >
                  {titleOf(c.nodeId)}
                </a>
                <span className="faint" style={{ fontSize: 12 }}>
                  {' '}
                  · {c.source === 'claude' ? '经 Claude' : '批量操作'}
                </span>
              </div>
              <div className="diff">
                {FIELD_LABEL[c.field] ?? c.field}{' '}
                {c.field === 'delete' ? '' : `${valueLabel(c.field, c.oldValue, contacts)} → ${valueLabel(c.field, c.newValue, contacts)}`}
              </div>
              {c.reason && <div className="reason">{c.reason}</div>}
            </div>
            <div className="actions">
              <button className="btn sm primary" onClick={() => void decideChanges([c.id], 'approve')}>
                确认
              </button>
              <button className="btn sm" onClick={() => void decideChanges([c.id], 'reject')}>
                拒绝
              </button>
            </div>
          </div>
        ))}

        {batches.length > 0 && (
          <>
            <div style={{ fontWeight: 700, marginTop: 8 }}>草案 {batches.length}</div>
            {batches.map((b) => (
              <BatchCard key={b.id} batch={b} />
            ))}
          </>
        )}
      </div>
      {pending.length > 0 && (
        <div className="foot">
          <span className="muted" style={{ fontSize: 12, flex: 1 }}>
            已选 {ids.length}
          </span>
          <button className="btn sm" disabled={!ids.length} onClick={() => void decideChanges(ids, 'reject')}>
            批量拒绝
          </button>
          <button className="btn sm primary" disabled={!ids.length} onClick={() => void decideChanges(ids, 'approve')}>
            批量确认
          </button>
        </div>
      )}
    </div>
  );
}

function BatchCard({ batch }: { batch: PlanBatch }) {
  const store = useProject((s) => s.store);
  const contacts = useProject((s) => s.contacts);
  const applyBatch = useProject((s) => s.applyBatch);
  const discardBatch = useProject((s) => s.discardBatch);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const s = batch.diff.summary;
  const modeLabel = { append: '只新增', sync: '新增和修改', replace: '完全同步（会删除）' }[batch.mode] ?? batch.mode;

  const updates = batch.diff.ops.filter((o) => o.type === 'update_node');
  const moves = batch.diff.ops.filter((o) => o.type === 'move_node');
  const deletes = batch.diff.ops.filter((o) => o.type === 'delete_node');
  const parentTitle = store.get(batch.parentId)?.title ?? '?';

  return (
    <div className="batch">
      <h5>
        草案 · {modeLabel} · 放在「{parentTitle}」下
      </h5>
      <div className="summary">
        新增 {s.create} · 修改 {s.update} · 移动 {s.move} · 删除 {s.delete}
      </div>
      {batch.diff.errors.length > 0 && (
        <ul className="red">
          {batch.diff.errors.map((e, i) => (
            <li key={i}>
              第 {e.lineNo} 行：{e.message}
            </li>
          ))}
        </ul>
      )}
      {batch.diff.created.length > 0 && (
        <>
          <div className="note" style={{ marginTop: 6 }}>
            新增
          </div>
          <ul>
            {batch.diff.created.map((c) => (
              <li key={c.id}>{c.title}</li>
            ))}
          </ul>
        </>
      )}
      {updates.length > 0 && (
        <>
          <div className="note">修改</div>
          <ul>
            {updates.map((o) =>
              o.type === 'update_node' ? (
                <li key={o.opId}>
                  {store.get(o.nodeId)?.title ?? o.nodeId}：
                  {Object.entries(o.patch)
                    .map(([k, v]) => `${FIELD_LABEL[k] ?? k} → ${valueLabel(k, v, contacts)}`)
                    .join('，')}
                </li>
              ) : null,
            )}
          </ul>
        </>
      )}
      {moves.length > 0 && (
        <>
          <div className="note">移动</div>
          <ul>
            {moves.map((o) =>
              o.type === 'move_node' ? (
                <li key={o.opId}>
                  {store.get(o.nodeId)?.title ?? o.nodeId} → {store.get(o.parentId)?.title ?? '新节点'} 下
                </li>
              ) : null,
            )}
          </ul>
        </>
      )}
      {deletes.length > 0 && (
        <>
          <div className="note red">删除</div>
          <ul className="del">
            {deletes.map((o) => (o.type === 'delete_node' ? <li key={o.opId}>{store.get(o.nodeId)?.title ?? o.nodeId}</li> : null))}
          </ul>
          <label className="row" style={{ fontSize: 12 }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            我知道这会删除 {s.delete} 个节点
          </label>
        </>
      )}
      <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
        <button className="btn sm" disabled={busy} onClick={() => void discardBatch(batch.id)}>
          丢弃
        </button>
        <button
          className="btn sm primary"
          disabled={busy || (s.delete > 0 && !ack) || batch.diff.errors.length > 0}
          onClick={async () => {
            setBusy(true);
            await applyBatch(batch.id);
            setBusy(false);
          }}
        >
          应用
        </button>
      </div>
    </div>
  );
}
