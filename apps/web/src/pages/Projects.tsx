import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import type { ProjectRow } from '../api/types';
import { Dialog } from '../components/ui';
import { HeaderLink, LargeTitle, Sheet } from '../components/phone';
import { toast } from '../state/toast';
import { OUTLINE_PLACEHOLDER } from '../lib/util';
import { useIsPhone } from '../lib/useIsPhone';

export function ProjectsPage() {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();
  const phone = useIsPhone();

  const load = useCallback(async () => {
    try {
      setRows(await api.listProjects());
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const active = (rows ?? []).filter((r) => !r.archivedAt);
  const onCreated = (id: string) => {
    setCreating(false);
    nav(`/projects/${id}`);
  };

  if (phone) {
    return (
      <div className="ph-page ph-projects" data-testid="phone-projects">
        <LargeTitle title="项目" right={<HeaderLink title="新建" tone="orange" onClick={() => setCreating(true)} testId="new-project" />} />
        {err && <div className="red ph-small">{err}</div>}
        {rows && !active.length && <div className="ph-empty">还没有项目。点右上角「新建」，空白开始或贴一段大纲。</div>}
        {active.length > 0 && (
          <div className="ph-project-list">
            {active.map((p) => {
              const parts: string[] = [];
              if (p.overdueCount) parts.push(`${p.overdueCount} 项逾期`);
              if (p.pendingCount) parts.push(`${p.pendingCount} 待确认`);
              if (p.slipCount) parts.push(`${p.slipCount} 处延误`);
              return (
                <button key={p.id} type="button" className="ph-project-row" onClick={() => nav(`/projects/${p.id}`)} data-testid={`project-${p.id}`}>
                  <span className="ph-project-name ellipsis">{p.name}</span>
                  <span className={`ph-project-sub${p.overdueCount ? ' red' : ''}`}>{parts.length ? parts.join(' · ') : '没有逾期'}</span>
                </button>
              );
            })}
          </div>
        )}
        {creating && (
          <Sheet full title="新建项目" onClose={() => setCreating(false)} testId="new-project-sheet">
            <NewProjectForm phone onClose={() => setCreating(false)} onCreated={onCreated} />
          </Sheet>
        )}
      </div>
    );
  }

  return (
    <div className="page narrow">
      <div className="row between" style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0 }}>项目</h1>
        <button className="btn primary" onClick={() => setCreating(true)}>
          新建项目
        </button>
      </div>
      {err && <div className="red">{err}</div>}
      {rows && !active.length && <div className="empty">还没有项目。点「新建项目」，空白开始或贴一段大纲。</div>}
      {active.length > 0 && (
        <table className="projects-table">
          <thead>
            <tr>
              <th>名称</th>
              <th style={{ textAlign: 'right' }}>逾期</th>
              <th style={{ textAlign: 'right' }}>待确认</th>
              <th style={{ textAlign: 'right' }}>创建于</th>
            </tr>
          </thead>
          <tbody>
            {active.map((p) => (
              <tr key={p.id} className="link" onClick={() => nav(`/projects/${p.id}`)}>
                <td style={{ fontWeight: 500 }}>
                  {p.name}
                  {(p.slipCount ?? 0) > 0 && (
                    <span className="slip-badge" title="有前置任务延误影响后续任务">
                      {p.slipCount} 处延误
                    </span>
                  )}
                </td>
                <td className={`num${p.overdueCount ? ' red' : ' faint'}`}>{p.overdueCount}</td>
                <td className="num" style={{ color: p.pendingCount ? 'var(--orange-deep)' : 'var(--ink-3)' }}>
                  {p.pendingCount}
                </td>
                <td className="num faint">{p.createdAt.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && (
        <Dialog title="新建项目" onClose={() => setCreating(false)} width={620}>
          <NewProjectForm onClose={() => setCreating(false)} onCreated={onCreated} />
        </Dialog>
      )}
    </div>
  );
}

/** The 新建项目 form (name + optional outline); the desktop wraps it in a Dialog, the phone in a full-screen Sheet. */
function NewProjectForm({ onClose, onCreated, phone }: { onClose: () => void; onCreated: (id: string) => void; phone?: boolean }) {
  const [name, setName] = useState('');
  const [outline, setOutline] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const body: { name: string; outline?: string } = { name: name.trim() };
      if (outline.trim()) body.outline = outline;
      const r = await api.createProject(body);
      if (r.warnings?.length) toast(`大纲有 ${r.warnings.length} 处问题：\n` + r.warnings.map((w) => `第 ${w.lineNo} 行：${w.message}`).join('\n'), 'error', 10000);
      else toast('项目已创建', 'ok');
      onCreated(r.project.id);
    } catch (e2) {
      toast(`创建失败：${errorMessage(e2)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className={phone ? 'ph-form' : undefined}>
      <label className="field">
        <span>名称</span>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="官网改版" />
      </label>
      <label className="field">
        <span>大纲（可选，留空则从一个根节点开始）</span>
        <textarea
          className="textarea mono"
          style={{ minHeight: phone ? 260 : 220, fontFamily: 'var(--font-mono)', fontSize: phone ? 13 : 12.5 }}
          value={outline}
          onChange={(e) => setOutline(e.target.value)}
          placeholder={OUTLINE_PLACEHOLDER}
        />
      </label>
      <div className="foot">
        {!phone && (
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
        )}
        <button type="submit" className={phone ? 'ph-btn primary grow' : 'btn primary'} disabled={busy || !name.trim()} data-testid="create-project">
          {busy ? '创建中…' : '创建'}
        </button>
      </div>
    </form>
  );
}
