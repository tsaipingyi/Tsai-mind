import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Contact, Derived, TNode, TreeStore } from '@tsai-mind/core';
import { C, FONT, MONO } from '../theme';
import { contactName, fmtDate, today } from '../lib/util';
import { StatusDot } from './ui';

interface Row {
  node: TNode;
  depth: number;
  hasKids: boolean;
}

export function OutlineList({
  store,
  derived,
  contacts,
  pendingNodeIds,
  criticalIds,
  rev,
  onSelect,
  header,
}: {
  store: TreeStore;
  derived: Map<string, Derived>;
  contacts: Contact[];
  pendingNodeIds: Set<string>;
  /** nodes on the critical path get a small orange ◆ after the title */
  criticalIds?: Set<string>;
  rev: number;
  onSelect: (id: string) => void;
  header?: React.ReactElement;
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
    if (root) walk(root, 0);
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
      ListHeaderComponent={header}
      renderItem={({ item }) => {
        const n = item.node;
        const d = derived.get(n.id);
        const status = d?.status ?? n.status;
        const due = d?.dueDate ?? n.dueDate;
        const overdue = !!due && due < t && status !== 'done';
        return (
          <Pressable onPress={() => onSelect(n.id)} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.paper2 }]} testID={`outline-${n.id}`}>
            <View style={{ width: item.depth * 18 }} />
            <Pressable onPress={() => toggle(n.id)} hitSlop={8} disabled={!item.hasKids} style={s.disclosure}>
              <Text style={{ color: item.hasKids ? C.ink2 : 'transparent', fontSize: 11 }}>{collapsed.has(n.id) ? '▶' : '▼'}</Text>
            </Pressable>
            <StatusDot status={status} />
            <Text style={[s.title, status === 'done' && { color: C.ink3 }, n.kind === 'milestone' && { fontWeight: '600' }]} numberOfLines={1}>
              {n.kind === 'milestone' ? '◆ ' : ''}
              {n.title || '（无标题）'}
            </Text>
            {criticalIds?.has(n.id) ? (
              <Text style={s.critical} accessibilityLabel="关键路径" testID={`critical-${n.id}`}>
                ◆
              </Text>
            ) : null}
            {pendingNodeIds.has(n.id) && <View style={s.pendingDot} />}
            {n.ownerId ? <Text style={s.owner}>{contactName(contacts, n.ownerId)}</Text> : null}
            {due ? <Text style={[s.date, overdue && { color: C.red }]}>{fmtDate(due)}</Text> : null}
            {n.kind !== 'note' && d ? <Text style={s.pct}>{d.progress}%</Text> : null}
          </Pressable>
        );
      }}
    />
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 16, paddingLeft: 8, minHeight: 44, borderBottomWidth: 1, borderColor: C.line, backgroundColor: C.paper },
  disclosure: { width: 18, alignItems: 'center' },
  title: { flex: 1, fontSize: FONT.body, color: C.ink },
  owner: { fontSize: FONT.tiny, color: C.ink2 },
  date: { fontFamily: MONO, fontSize: FONT.tiny, color: C.ink2 },
  pct: { fontFamily: MONO, fontSize: FONT.tiny, color: C.ink3, minWidth: 34, textAlign: 'right' },
  pendingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.orange },
  critical: { fontSize: 9, color: C.orange, marginLeft: -4 },
});
