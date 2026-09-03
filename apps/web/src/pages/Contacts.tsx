import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Contact } from '@tsai-mind/core';
import { api, errorMessage } from '../api/client';
import type { ContactNodeEntry } from '../api/types';
import { Avatar, Dialog, ProgressRing, StatusPill } from '../components/ui';
import { toast } from '../state/toast';
import { fmtRange, today } from '../lib/util';
import { isOverdue } from '@tsai-mind/core';

type Draft = { name: string; company: string; email: string; phone: string; notes: string };
const emptyDraft: Draft = { name: '', company: '', email: '', phone: '', notes: '' };

export function ContactsPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ contact: Contact | null } | null>(null);

  const load = useCallback(async () => {
    try {
      setContacts(await api.listContacts());
      setErr(null);
    } catch (e) {
      setErr(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const list = (contacts ?? []).filter((c) => !c.archivedAt);
  const selected = id ? list.find((c) => c.id === id) ?? null : null;

  return (
    <div className="page narrow">
      <div className="row between" style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0 }}>联系人</h1>
        <button className="btn primary" onClick={() => setEditing({ contact: null })}>
          添加联系人
        </button>
      </div>
      {err && <div className="red">{err}</div>}
      {contacts && !list.length && <div className="empty">还没有联系人。添加你指派任务的人：同事、外包、供应商。</div>}
      {list.length > 0 && (
        <div className="list">
          {list.map((c) => (
            <div
              key={c.id}
              className="list-item link"
              onClick={() => nav(`/contacts/${c.id}`)}
              style={c.id === id ? { background: 'var(--orange-soft)' } : undefined}
            >
              <Avatar contact={c} ownerId={c.id} size="lg" />
              <div className="title">
                <span style={{ fontWeight: 500 }}>{c.name}</span>
                {c.company && <span className="muted"> · {c.company}</span>}
              </div>
              <span className="muted" style={{ fontSize: 12 }}>
                {[c.email, c.phone].filter(Boolean).join(' · ')}
              </span>
              <button
                className="btn sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing({ contact: c });
                }}
              >
                编辑
              </button>
            </div>
          ))}
        </div>
      )}

      {selected && <ContactNodes contact={selected} />}

      {editing && (
        <ContactDialog
          contact={editing.contact}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
          onDeleted={() => {
            setEditing(null);
            void load();
            if (editing.contact && editing.contact.id === id) nav('/contacts');
          }}
        />
      )}
    </div>
  );
}

function ContactNodes({ contact }: { contact: Contact }) {
  const [entries, setEntries] = useState<ContactNodeEntry[] | null>(null);
  const nav = useNavigate();
  useEffect(() => {
    setEntries(null);
    api
      .contactNodes(contact.id)
      .then(setEntries)
      .catch((e) => toast(errorMessage(e), 'error'));
  }, [contact.id]);

  const groups = new Map<string, { name: string; items: ContactNodeEntry[] }>();
  for (const e of entries ?? []) {
    const g = groups.get(e.projectId) ?? { name: e.projectName, items: [] };
    g.items.push(e);
    groups.set(e.projectId, g);
  }
  const t = today();

  return (
    <div style={{ marginTop: 32 }}>
      <h2 style={{ marginTop: 0 }}>
        {contact.name} 名下的任务 <span className="count">{entries?.length ?? ''}</span>
      </h2>
      {contact.notes && <div className="muted" style={{ fontSize: 13, marginBottom: 8, whiteSpace: 'pre-wrap' }}>{contact.notes}</div>}
      {entries && !entries.length && <div className="empty">还没有指派给 {contact.name} 的任务。</div>}
      {[...groups.entries()].map(([pid, g]) => (
        <div key={pid} style={{ marginBottom: 16 }}>
          <div className="muted" style={{ fontSize: 12, fontWeight: 500, margin: '8px 0 4px' }}>
            {g.name}
          </div>
          <div className="list">
            {g.items.map((e) => {
              const overdue = isOverdue(e.derived, t);
              return (
                <div key={e.node.id} className="list-item link" onClick={() => nav(`/projects/${pid}?node=${e.node.id}`)}>
                  <ProgressRing progress={e.derived.progress} status={e.derived.status} />
                  <div className="title">
                    {e.node.title}
                    {e.path.length > 1 && <div className="path">{e.path.slice(1).join(' / ')}</div>}
                  </div>
                  <StatusPill status={e.derived.status} />
                  <span className={`date${overdue ? ' overdue' : ''}`}>{fmtRange(e.derived.startDate, e.derived.dueDate)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function ContactDialog({
  contact,
  onClose,
  onSaved,
  onDeleted,
}: {
  contact: Contact | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [d, setD] = useState<Draft>(
    contact
      ? { name: contact.name, company: contact.company ?? '', email: contact.email ?? '', phone: contact.phone ?? '', notes: contact.notes ?? '' }
      : emptyDraft,
  );
  const [busy, setBusy] = useState(false);
  const upd = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!d.name.trim()) return;
    setBusy(true);
    const body = {
      name: d.name.trim(),
      company: d.company.trim() || null,
      email: d.email.trim() || null,
      phone: d.phone.trim() || null,
      notes: d.notes.trim() || null,
    };
    try {
      if (contact) await api.patchContact(contact.id, body);
      else await api.createContact(body);
      toast('已保存', 'ok');
      onSaved();
    } catch (e2) {
      toast(`保存失败：${errorMessage(e2)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!contact || !confirm(`删除联系人「${contact.name}」？他名下的任务会变成由你负责。`)) return;
    try {
      await api.deleteContact(contact.id);
      toast('已删除');
      onDeleted();
    } catch (e2) {
      toast(`删除失败：${errorMessage(e2)}`, 'error');
    }
  };

  return (
    <Dialog title={contact ? '编辑联系人' : '添加联系人'} onClose={onClose}>
      <form onSubmit={submit}>
        <label className="field">
          <span>姓名</span>
          <input className="input" autoFocus value={d.name} onChange={upd('name')} />
        </label>
        <label className="field">
          <span>公司</span>
          <input className="input" value={d.company} onChange={upd('company')} />
        </label>
        <div className="row" style={{ gap: 12 }}>
          <label className="field" style={{ flex: 1 }}>
            <span>邮箱</span>
            <input className="input" type="email" value={d.email} onChange={upd('email')} />
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>电话</span>
            <input className="input" value={d.phone} onChange={upd('phone')} />
          </label>
        </div>
        <label className="field">
          <span>备注</span>
          <textarea className="textarea" value={d.notes} onChange={upd('notes')} />
        </label>
        <div className="foot" style={{ justifyContent: contact ? 'space-between' : 'flex-end' }}>
          {contact && (
            <button type="button" className="btn danger" onClick={() => void remove()}>
              删除
            </button>
          )}
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn primary" disabled={busy || !d.name.trim()}>
              保存
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
