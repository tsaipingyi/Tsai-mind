import { useEffect } from 'react';
import type { TNode, TreeStore } from '@tsai-mind/core';
import { useProject } from '../state/project';
import { isTypingTarget } from '../lib/util';

export function visibleOrder(store: TreeStore, collapsed: Set<string>): TNode[] {
  const out: TNode[] = [];
  const walk = (n: TNode) => {
    out.push(n);
    if (!collapsed.has(n.id)) for (const k of store.children(n.id)) walk(k);
  };
  const root = store.root();
  if (root) walk(root);
  return out;
}

export interface ShortcutHandlers {
  openOwnerPicker: () => void;
  openPalette: () => void;
  /** returns true when a popover is open (shortcuts are suppressed) */
  popoverOpen: () => boolean;
}

export function useEditorShortcuts(h: ShortcutHandlers) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useProject.getState();
      if (!st.projectId) return;
      if (h.popoverOpen()) return;
      const mod = e.metaKey || e.ctrlKey;

      if (isTypingTarget(e.target)) {
        // title inputs handle their own keys; other inputs (sidebar) only get Escape
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }

      if (mod && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        e.preventDefault();
        void st.undo();
        return;
      }

      const sel = st.selectedId ? st.store.live(st.selectedId) : undefined;
      if (!sel) {
        if (e.key === '/' ) {
          e.preventDefault();
          h.openPalette();
        }
        return;
      }
      const order = visibleOrder(st.store, st.collapsed);
      const idx = order.findIndex((n) => n.id === sel.id);

      switch (e.key) {
        case 'Tab': {
          e.preventDefault();
          st.createChild(sel.id);
          return;
        }
        case 'Enter': {
          e.preventDefault();
          if (st.editingId) return;
          st.createSibling(sel.id);
          return;
        }
        case 'Delete':
        case 'Backspace': {
          e.preventDefault();
          if (sel.parentId === null) return;
          const kids = st.store.descendants(sel.id).length;
          if (kids > 0 && !confirm(`删除「${sel.title || '（无标题）'}」及其 ${kids} 个子节点？`)) return;
          st.deleteNode(sel.id);
          return;
        }
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault();
          const dir = e.key === 'ArrowUp' ? -1 : 1;
          let target: TNode | undefined;
          if (sel.parentId) {
            const sibs = st.store.children(sel.parentId);
            const i = sibs.findIndex((s) => s.id === sel.id);
            target = sibs[i + dir];
          }
          if (!target && idx >= 0) target = order[idx + dir];
          if (target) st.select(target.id);
          return;
        }
        case 'ArrowLeft': {
          e.preventDefault();
          if (sel.parentId) st.select(sel.parentId);
          return;
        }
        case 'ArrowRight': {
          e.preventDefault();
          const kids = st.store.children(sel.id);
          if (!kids.length) return;
          if (st.collapsed.has(sel.id)) st.toggleCollapse(sel.id);
          st.select(kids[0]!.id);
          return;
        }
        case ' ': {
          e.preventDefault();
          if (st.store.children(sel.id).length) st.toggleCollapse(sel.id);
          return;
        }
        case 'F2': {
          e.preventDefault();
          st.setEditing(sel.id);
          return;
        }
        case 'Escape': {
          if (st.pendingPanelOpen) st.setPendingPanel(false);
          else if (st.editingId) st.setEditing(null);
          return;
        }
        case '@': {
          e.preventDefault();
          h.openOwnerPicker();
          return;
        }
        case '/': {
          e.preventDefault();
          h.openPalette();
          return;
        }
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [h]);
}
