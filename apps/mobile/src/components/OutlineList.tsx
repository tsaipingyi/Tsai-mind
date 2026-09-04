import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Derived, TNode, TreeStore } from '@tsai-mind/core';
import { C, FONT, MONO, PAGE_PAD } from '../theme';
import { fmtDate, today } from '../lib/util';
import { PendingDot, StatusDot } from './ui';
import { SwipeRow } from './SwipeRow';

interface Row {
  node: TNode;
  depth: number;
  hasKids: boolean;
}

/**
 * Project outline (Project.dc.html): 52px rows, ▾ caret for parents (11px ink3, 14 wide), 8px status dot,
 * title 16 (600 for parents, ink3 when done), orange pending dot, mono 13 date (red when overdue and not done).
 * Indent 18px per level from a 20px base. Swipe left = 标记完成.
 *
 * TODO(reorder): long-press drag among siblings (move_node) needs a draggable list; not cheap with FlatList +
 * gesture-handler alone, so it is left out for now.
 */
export function OutlineList({
  store,
  derived,
  pendingNodeIds,
  rev,
  onSelect,
  onDone,
  footer,
}: {
  store: TreeStore;
  derived: Map<string, Derived>;
  pendingNodeIds: Set<string>;
  rev: number;
  onSelect: (id: string) => void;
  onDone?: (id: string) => void;
  footer?: React.ReactElement;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const t = today();
  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (n: TNode, depth: number) => {
      const kids = store.children(n.id);
      out.push({ node: n, depth, hasKids: kids.length > 0 });
      if (!collapsed.has(n.id)) for (const k of kids) walk(k, depth + 1);
    };
    const root = store.root();
    // the root is the project itself (its name is in the header); list its children
    if (root) for (const k of store.children(root.id)) walk(k, 0);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, rev, collapsed]);

  const toggle = (id: string) => {
    const c = new Set(collapsed);
    if (c.has(id)) c.delete(id);
    else c.add(id);
    setCollapsed(c);
  };

  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.node.id}
      ListFooterComponent={footer}
      renderItem={({ item }) => {
        const n = item.node;
        const d = derived.get(n.id);
        const status = d?.status ?? n.status;
        const due = d?.dueDate ?? n.dueDate;
        const done = status === 'done';
        const overdue = !!due && due < t && !done;
        const body = (
          <Pressable onPress={() => onSelect(n.id)} style={({ pressed }) => [s.row, { paddingLeft: PAGE_PAD + item.depth * 18 }, pressed && { backgroundColor: C.paper2 }]} testID={`outline-${n.id}`}>
            <Pressable onPress={() => toggle(n.id)} hitSlop={10} disabled={!item.hasKids} style={s.caret} accessibilityLabel={item.hasKids ? (collapsed.has(n.id) ? '展开' : '收起') : undefined}>
              <Text style={s.caretText}>{item.hasKids ? (collapsed.has(n.id) ? '▸' : '▾') : ''}</Text>
            </Pressable>
            <StatusDot status={status} />
            <Text style={[s.title, item.hasKids && { fontWeight: '600' }, done && { color: C.ink3 }]} numberOfLines={1}>
              {n.kind === 'milestone' ? '◆ ' : ''}
              {n.title || '（无标题）'}
            </Text>
            {pendingNodeIds.has(n.id) && <PendingDot />}
            {due ? <Text style={[s.date, overdue && { color: C.red }]}>{fmtDate(due)}</Text> : null}
          </Pressable>
        );
        if (!onDone || done) return body;
        return (
          <SwipeRow onLeft={() => onDone(n.id)} leftLabel="标记完成" leftColor={C.green}>
            {body}
          </SwipeRow>
        );
      }}
    />
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 52, paddingRight: PAGE_PAD, borderBottomWidth: 1, borderColor: C.line, backgroundColor: C.paper },
  caret: { width: 14 },
  caretText: { fontSize: 11, color: C.ink3 },
  title: { flexGrow: 1, flexShrink: 1, fontSize: FONT.input, color: C.ink },
  date: { fontFamily: MONO, fontSize: FONT.small, color: C.ink2 },
});
