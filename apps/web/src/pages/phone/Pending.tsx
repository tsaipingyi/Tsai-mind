import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Contact } from '@tsai-mind/core';
import { api, errorMessage } from '../../api/client';
import type { PendingChange } from '../../api/types';
import { useProject } from '../../state/project';
import { toast } from '../../state/toast';
import { BatchCard } from '../../editor/PendingPanel';
import { BackChevron, Empty, PendingCard } from '../../components/phone';

/**
 * Full-screen 待确认 list on the phone (opened from「还有 n 项待确认 ›」): every pending change across
 * projects as the same card as 今天, plus any draft batches of the currently loaded project.
 */
export function PhonePendingPage() {
  const nav = useNavigate();
  const [rows, setRows] = useState<PendingChange[] | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const batches = useProject((s) => s.batches);
  const projectLoaded = useProject((s) => s.projectId);

  const load = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([api.pendingChanges(), api.listContacts().catch(() => [] as Contact[])]);
      setRows(p.filter((x) => x.status === 'pending'));
      setContacts(c);
    } catch (e) {
      toast(errorMessage(e), 'error');
      setRows([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (c: PendingChange, decision: 'approve' | 'reject') => {
    setBusy((b) => new Set(b).add(c.id));
    try {
      if (decision === 'approve') await api.approveChange(c.id);
      else await api.rejectChange(c.id);
      toast(decision === 'approve' ? '已确认' : '已拒绝', 'ok');
      setRows((r) => (r ?? []).filter((x) => x.id !== c.id));
      // keep the editor store in step when this project is open
      const st = useProject.getState();
      if (st.projectId === c.projectId) void st.reload();
    } catch (e) {
      toast(`操作失败：${errorMessage(e)}`, 'error');
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(c.id);
        return n;
      });
    }
  };

  const decideAll = async (decision: 'approve' | 'reject') => {
    const ids = (rows ?? []).map((c) => c.id);
    if (!ids.length) return;
    try {
      await api.batchChanges(ids.map((id) => ({ id, decision })));
      toast(decision === 'approve' ? `已确认 ${ids.length} 项` : `已拒绝 ${ids.length} 项`, 'ok');
      setRows([]);
      const st = useProject.getState();
      if (st.projectId) void st.reload();
    } catch (e) {
      toast(`操作失败：${errorMessage(e)}`, 'error');
    }
  };

  const back = () => (window.history.length > 1 ? nav(-1) : nav('/'));

  return (
    <div className="ph-page ph-pending-page" data-testid="phone-pending">
      <div className="ph-title-row">
        <BackChevron onClick={back} testId="pending-back" />
        <h1 className="ph-h2" style={{ flex: 1 }}>
          待确认{rows ? ` · ${rows.length}` : ''}
        </h1>
        {rows && rows.length > 1 ? (
          <button type="button" className="ph-link orange" onClick={() => void decideAll('approve')}>
            全部确认
          </button>
        ) : null}
      </div>
      {!rows ? <div className="ph-empty">加载中…</div> : null}
      {rows && !rows.length && !batches.length ? <Empty text="没有等你确认的变更。" /> : null}
      {rows?.map((c) => (
        <div key={c.id} className="ph-stack8">
          <div className="ph-card-project">{c.projectName}</div>
          <PendingCard
            change={c}
            title={c.nodeTitle}
            contacts={contacts}
            busy={busy.has(c.id)}
            onApprove={() => void decide(c, 'approve')}
            onReject={() => void decide(c, 'reject')}
            onOpen={() => nav(`/projects/${c.projectId}/node/${c.nodeId}`)}
          />
        </div>
      ))}
      {batches.length > 0 && projectLoaded ? (
        <div className="ph-stack8">
          <div className="ph-card-project">草案 · {batches.length}</div>
          {batches.map((b) => (
            <BatchCard key={b.id} batch={b} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
