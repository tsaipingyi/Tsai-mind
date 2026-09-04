import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useProject } from '../state/project';
import { MindMap } from '../editor/MindMap';
import { OutlineView } from '../editor/Outline';
import { GanttView } from '../editor/Gantt';
import { PeopleBoard } from '../editor/PeopleBoard';
import { Sidebar } from '../editor/Sidebar';
import { PendingPanel } from '../editor/PendingPanel';
import { ChatPanel } from '../editor/ChatPanel';
import { CommandPalette, OwnerPicker, type PaletteActions } from '../editor/Popovers';
import { useEditorShortcuts } from '../editor/useShortcuts';
import { Avatar } from '../components/ui';
import { api, errorMessage } from '../api/client';
import { toast } from '../state/toast';
import { copyText } from '../lib/util';

export function ProjectEditorPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const projectId = useProject((s) => s.projectId);
  const project = useProject((s) => s.project);
  const loading = useProject((s) => s.loading);
  const error = useProject((s) => s.error);
  const load = useProject((s) => s.load);
  const unload = useProject((s) => s.unload);
  const view = useProject((s) => s.view);
  const setView = useProject((s) => s.setView);
  const contacts = useProject((s) => s.contacts);
  const ownerFilter = useProject((s) => s.ownerFilter);
  const setOwnerFilter = useProject((s) => s.setOwnerFilter);
  const search = useProject((s) => s.search);
  const setSearch = useProject((s) => s.setSearch);
  const pending = useProject((s) => s.pending);
  const batches = useProject((s) => s.batches);
  const pendingPanelOpen = useProject((s) => s.pendingPanelOpen);
  const setPendingPanel = useProject((s) => s.setPendingPanel);
  const chatOpen = useProject((s) => s.chatOpen);
  const setChatOpen = useProject((s) => s.setChatOpen);
  const slips = useProject((s) => s.slips);
  const selectedId = useProject((s) => s.selectedId);
  const select = useProject((s) => s.select);
  const renameProject = useProject((s) => s.renameProject);
  const store = useProject((s) => s.store);
  const rev = useProject((s) => s.rev);

  const [popover, setPopover] = useState<'owner' | 'palette' | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!exportOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!exportRef.current?.contains(e.target as Node)) setExportOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [exportOpen]);

  useEffect(() => {
    if (id) void load(id);
    return () => unload();
  }, [id, load, unload]);

  // ?node=… deep link
  useEffect(() => {
    const nodeId = params.get('node');
    if (nodeId && projectId === id && !loading) {
      const st = useProject.getState();
      if (st.store.live(nodeId)) {
        // expand ancestors
        const c = new Set(st.collapsed);
        for (const a of st.store.ancestors(nodeId)) c.delete(a.id);
        useProject.setState({ collapsed: c });
        select(nodeId);
      }
      params.delete('node');
      setParams(params, { replace: true });
    }
  }, [params, setParams, projectId, id, loading, select]);

  const [pname, setPname] = useState('');
  useEffect(() => setPname(project?.name ?? ''), [project?.name]);

  const copyOutline = useCallback(async () => {
    if (!projectId) return;
    try {
      const text = await api.getOutline(projectId);
      const ok = await copyText(text);
      toast(ok ? '大纲已复制到剪贴板' : '无法写入剪贴板', ok ? 'ok' : 'error');
    } catch (e) {
      toast(`复制失败：${errorMessage(e)}`, 'error');
    }
  }, [projectId]);

  const downloadOutline = useCallback(async () => {
    if (!projectId || !project) return;
    try {
      const text = await api.getOutline(projectId);
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.replace(/[\\/:*?"<>|]+/g, '_') || 'outline'}.md`;
      document.body.appendChild(a);
      a.click();
      // keep the anchor (and its download name) alive until the browser has started the download
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 2000);
    } catch (e) {
      toast(`下载失败：${errorMessage(e)}`, 'error');
    }
  }, [projectId, project]);

  const openPrint = useCallback(() => {
    if (!projectId) return;
    window.open(`/projects/${projectId}/print?print=1`, '_blank', 'noopener');
  }, [projectId]);

  const shortcutHandlers = useMemo(
    () => ({
      openOwnerPicker: () => setPopover('owner'),
      openPalette: () => setPopover('palette'),
      popoverOpen: () => popover !== null,
    }),
    [popover],
  );
  useEditorShortcuts(shortcutHandlers);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const selected = useMemo(() => (selectedId ? store.live(selectedId) : undefined), [store, rev, selectedId]);

  const paletteActions: PaletteActions = {
    setStatus: (s) => selected && useProject.getState().updateNode(selected.id, { status: s }),
    setProgress: (p) => selected && useProject.getState().updateNode(selected.id, { progress: p, ...(selected.progressMode === 'auto' && useProject.getState().derived.get(selected.id)?.hasChildren ? { progressMode: 'manual' as const } : {}) }),
    focusDate: () => useProject.getState().requestFocus('dueDate'),
    pickOwner: () => setPopover('owner'),
    addChild: () => selected && useProject.getState().createChild(selected.id),
    remove: () => {
      if (!selected || selected.parentId === null) return;
      const st = useProject.getState();
      const kids = st.store.descendants(selected.id).length;
      if (kids > 0 && !confirm(`删除「${selected.title || '（无标题）'}」及其 ${kids} 个子节点？`)) return;
      st.deleteNode(selected.id);
    },
    nudge: async () => {
      if (!selected) return;
      const text = await useProject.getState().nudge(selected.id);
      if (text) {
        const ok = await copyText(text);
        toast(`${ok ? '已复制到剪贴板：\n' : ''}${text}`, 'ok', 8000);
      }
    },
    copyOutline: () => void copyOutline(),
    canNudge: !!selected?.ownerId,
  };

  if (error)
    return (
      <div className="page">
        <div className="red">{error}</div>
        <button className="btn" style={{ marginTop: 12 }} onClick={() => id && void load(id)}>
          重试
        </button>
      </div>
    );
  if (!project || projectId !== id)
    return (
      <div className="page">
        <div className="faint">加载中…</div>
      </div>
    );

  const activeContacts = contacts.filter((c) => !c.archivedAt);
  const pendingCount = pending.length + batches.length;

  return (
    <div className="editor" data-testid="editor">
      <div className="topbar">
        <input
          className="pname"
          value={pname}
          onChange={(e) => setPname(e.target.value)}
          onBlur={() => void renameProject(pname)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label="项目名称"
        />
        <div className="segmented" role="tablist">
          <button role="tab" className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}>
            导图
          </button>
          <button role="tab" className={view === 'outline' ? 'active' : ''} onClick={() => setView('outline')}>
            大纲
          </button>
          <button role="tab" className={view === 'gantt' ? 'active' : ''} onClick={() => setView('gantt')}>
            甘特
          </button>
          <button role="tab" className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}>
            按人
          </button>
        </div>
        <div className="owner-filter" title="按负责人筛选">
          <button className={ownerFilter === null ? 'active' : ''} onClick={() => setOwnerFilter(ownerFilter === null ? undefined : null)} title="我">
            <Avatar ownerId={null} size="lg" />
          </button>
          {activeContacts.map((c) => (
            <button key={c.id} className={ownerFilter === c.id ? 'active' : ''} onClick={() => setOwnerFilter(ownerFilter === c.id ? undefined : c.id)} title={c.name}>
              <Avatar contact={c} ownerId={c.id} size="lg" />
            </button>
          ))}
        </div>
        <input className="input search" placeholder="搜索节点…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="搜索" />
        <div className="grow" />
        {slips.length > 0 && (
          <button className="slip-badge clickable" onClick={() => setView('gantt')} title="前置任务延误影响后续任务，点开甘特图查看" data-testid="slip-badge">
            {slips.length} 处延误
          </button>
        )}
        <button className="btn sm" onClick={() => void copyOutline()}>
          复制大纲
        </button>
        <div className="menu-wrap" ref={exportRef}>
          <button className={`btn sm${exportOpen ? ' active' : ''}`} onClick={() => setExportOpen(!exportOpen)} aria-haspopup="menu" aria-expanded={exportOpen}>
            导出 ▾
          </button>
          {exportOpen && (
            <div className="menu" role="menu">
              <button
                role="menuitem"
                onClick={() => {
                  setExportOpen(false);
                  void downloadOutline();
                }}
              >
                下载大纲 .md
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setExportOpen(false);
                  openPrint();
                }}
              >
                打印 / PDF
              </button>
            </div>
          )}
        </div>
        <button
          className={`btn sm${pendingPanelOpen ? ' active' : ''}`}
          onClick={() => {
            if (!pendingPanelOpen) setChatOpen(false);
            setPendingPanel(!pendingPanelOpen);
          }}
          data-testid="pending-toggle"
        >
          待确认 {pendingCount > 0 ? <span className="badge">{pendingCount}</span> : <span className="faint">0</span>}
        </button>
        <button
          className={`btn sm${chatOpen ? ' active' : ''}`}
          onClick={() => {
            if (!chatOpen) setPendingPanel(false);
            setChatOpen(!chatOpen);
          }}
          data-testid="chat-toggle"
          title="和 Claude 对话 (⌘J / Ctrl+J)"
        >
          Claude
        </button>
      </div>
      <div className="editor-body">
        <div className="editor-view">
          {view === 'map' ? <MindMap /> : view === 'outline' ? <OutlineView /> : view === 'gantt' ? <GanttView /> : <PeopleBoard />}
          {pendingPanelOpen && <PendingPanel onClose={() => setPendingPanel(false)} />}
          {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}
        </div>
        <Sidebar />
      </div>
      {popover === 'owner' && selected && (
        <OwnerPicker
          contacts={contacts}
          current={selected.ownerId}
          onPick={(oid) => {
            useProject.getState().updateNode(selected.id, { ownerId: oid });
            setPopover(null);
          }}
          onClose={() => setPopover(null)}
        />
      )}
      {popover === 'palette' && <CommandPalette actions={paletteActions} onClose={() => setPopover(null)} />}
    </div>
  );
}
