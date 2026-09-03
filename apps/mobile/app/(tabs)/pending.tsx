import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Contact } from '@tsai-mind/core';
import { C, FONT } from '../../src/theme';
import { Btn, Checkbox, Empty, HeaderLink, LargeTitle, Loading, SectionHeader } from '../../src/components/ui';
import { PendingCard } from '../../src/components/PendingCard';
import { BatchCard } from '../../src/components/BatchCard';
import { usePending } from '../../src/state/pending';
import { useProjects } from '../../src/state/project';
import { api } from '../../src/api/client';
import { clearBadge } from '../../src/push';

export default function PendingScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const st = usePending();
  const projects = useProjects((s) => s.projects);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());

  useEffect(() => {
    void st.load();
    api.listContacts().then(setContacts).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useFocusEffect(
    useCallback(() => {
      void clearBadge();
      if (st.loadedAt) void st.load();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  // batches mention node ids; load their projects so titles resolve
  useEffect(() => {
    for (const b of st.batches) if (!projects[b.projectId]) void useProjects.getState().load(b.projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.batches]);

  const refresh = async () => {
    setRefreshing(true);
    await st.load();
    setRefreshing(false);
  };

  const projectName = useMemo(() => new Map(st.projects.map((p) => [p.id, p.name])), [st.projects]);
  const ids = [...sel].filter((id) => st.changes.some((c) => c.id === id));
  const allSelected = st.changes.length > 0 && st.changes.every((c) => sel.has(c.id));
  const toggle = (id: string) => {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSel(n);
  };
  const titleOf = (pid: string) => (id: string) => projects[pid]?.store.get(id)?.title ?? '…';

  const empty = !st.changes.length && !st.batches.length;
  return (
    <View style={{ flex: 1, backgroundColor: C.paper, paddingTop: insets.top }}>
      <LargeTitle title="待确认" right={<HeaderLink title="设置" onPress={() => router.push('/settings')} />} />
      <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={C.ink3} />} contentContainerStyle={{ paddingBottom: 100 }}>
        {st.loading && !st.loadedAt && <Loading />}
        {!st.loading && empty && <Empty text={st.error ? st.error : '没有等你确认的变更。'} />}
        {st.changes.length > 0 && (
          <>
            <SectionHeader title="变更" count={st.changes.length} first />
            <View style={{ paddingHorizontal: 16 }}>
              <Checkbox checked={allSelected} onChange={() => setSel(allSelected ? new Set() : new Set(st.changes.map((c) => c.id)))} label="全选" />
            </View>
            {st.changes.map((c) => (
              <View key={c.id} style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                <View style={{ paddingLeft: 16, paddingTop: 10 }}>
                  <Checkbox checked={sel.has(c.id)} onChange={() => toggle(c.id)} label="" />
                </View>
                <View style={{ flex: 1, marginLeft: -16 }}>
                  <PendingCard
                    change={c}
                    title={c.nodeTitle}
                    subtitle={c.projectName}
                    contacts={contacts}
                    onApprove={() => void st.decide([c.id], 'approve')}
                    onReject={() => void st.decide([c.id], 'reject')}
                    onOpen={() => router.push(`/node/${c.nodeId}`)}
                  />
                </View>
              </View>
            ))}
          </>
        )}
        {st.batches.length > 0 && (
          <>
            <SectionHeader title="草案" count={st.batches.length} first={!st.changes.length} />
            {st.batches.map((b) => (
              <BatchCard
                key={b.id}
                batch={b}
                projectName={projectName.get(b.projectId)}
                contacts={contacts}
                titleOf={titleOf(b.projectId)}
                onApply={() => st.applyBatch(b.id)}
                onDiscard={() => st.discardBatch(b.id)}
              />
            ))}
          </>
        )}
      </ScrollView>
      {ids.length > 0 && (
        <View style={[s.foot, { paddingBottom: 12 }]}>
          <Text style={{ flex: 1, fontSize: FONT.small, color: C.ink2 }}>已选 {ids.length}</Text>
          <Btn title="批量拒绝" small onPress={() => void st.decide(ids, 'reject').then(() => setSel(new Set()))} />
          <Btn title="批量确认" small kind="primary" onPress={() => void st.decide(ids, 'approve').then(() => setSel(new Set()))} />
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  foot: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 10, backgroundColor: C.paper, borderTopWidth: 1, borderColor: C.line },
});
