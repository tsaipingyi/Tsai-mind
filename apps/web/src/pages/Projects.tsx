import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import type { ProjectRow } from '../api/types';
import { Dialog } from '../components/ui';
import { toast } from '../state/toast';
import { OUTLINE_PLACEHOLDER } from '../lib/util';

export function ProjectsPage() {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();

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
                <td style={{ fontWeight: 500 }}>{p.name}</td>
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
        <NewProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            nav(`/projects/${id}`);
          }}
        />
      )}
    </div>
  );
}

function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
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
    <Dialog title="新建项目" onClose={onClose} width={620}>
      <form onSubmit={submit}>
        <label className="field">
          <span>名称</span>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="官网改版" />
        </label>
        <label className="field">
          <span>大纲（可选，留空则从一个根节点开始）</span>
          <textarea
            className="textarea mono"
            style={{ minHeight: 220, fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
            value={outline}
            onChange={(e) => setOutline(e.target.value)}
            placeholder={OUTLINE_PLACEHOLDER}
          />
        </label>
        <div className="foot">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
