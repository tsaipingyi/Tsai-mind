import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { Contact } from '@tsai-mind/core';
import { C, PAGE_PAD } from '../src/theme';
import { Btn, Empty, ListLabel, Loading } from '../src/components/ui';
import { PendingCard } from '../src/components/PendingCard';
import { BatchCard } from '../src/components/BatchCard';
import { usePending } from '../src/state/pending';
import { useProjects } from '../src/state/project';
import { api } from '../src/api/client';
import { clearBadge } from '../src/push';

/** All pending changes + draft batches; opened from 今天's「还有 n 项待确认」row (and by push notifications). */
export default function PendingScreen() {
  const router = useRouter();
  const st = usePending();
  const projects = useProjects((s) => s.projects);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [refreshing, setRefreshing] = useState(false);

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
  const titleOf = (pid: string) => (id: string) => projects[pid]?.store.get(id)?.title ?? '…';
  const ids = st.changes.map((c) => c.id);
  const empty = !st.changes.length && !st.batches.length;

  return (
    <View style={{ flex: 1, backgroundColor: C.paper }}>
      <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={C.ink3} />} contentContainerStyle={{ paddingHorizontal: PAGE_PAD, paddingTop: 16, paddingBottom: 100, gap: 20 }}>
        {st.loading && !st.loadedAt ? <Loading /> : null}
        {!st.loading && empty ? <Empty text={st.error ? st.error : '没有等你确认的变更。'} /> : null}
        {st.changes.length > 0 ? (
          <View style={{ gap: 12 }}>
            <ListLabel text={`变更 · ${st.changes.length}`} />
            {st.changes.map((c) => (
              <PendingCard
                key={c.id}
                change={c}
                title={c.nodeTitle}
                contacts={contacts}
                onApprove={() => void st.decide([c.id], 'approve')}
                onReject={() => void st.decide([c.id], 'reject')}
                onOpen={() => router.push(`/projects/node/${c.nodeId}`)}
              />
            ))}
          </View>
        ) : null}
        {st.batches.length > 0 ? (
          <View style={{ gap: 12 }}>
            <ListLabel text={`草案 · ${st.batches.length}`} />
            {st.batches.map((b) => (
              <BatchCard key={b.id} batch={b} projectName={projectName.get(b.projectId)} contacts={contacts} titleOf={titleOf(b.projectId)} onApply={() => st.applyBatch(b.id)} onDiscard={() => st.discardBatch(b.id)} />
            ))}
          </View>
        ) : null}
      </ScrollView>
      {ids.length > 1 ? (
        <View style={s.foot}>
          <Btn title={`全部确认 ${ids.length} 项`} kind="primary" grow onPress={() => void st.decide(ids, 'approve')} testID="approve-all" />
          <Btn title="全部拒绝" width={96} onPress={() => void st.decide(ids, 'reject')} testID="reject-all" />
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  foot: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', gap: 10, paddingHorizontal: PAGE_PAD, paddingTop: 10, paddingBottom: 28, backgroundColor: C.paper, borderTopWidth: 1, borderColor: C.line },
});
