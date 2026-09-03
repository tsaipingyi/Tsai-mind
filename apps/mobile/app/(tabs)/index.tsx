import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT } from '../../src/theme';
import { Banner, Empty, HeaderLink, LargeTitle, Loading, SectionHeader } from '../../src/components/ui';
import { TaskRow } from '../../src/components/TaskRow';
import { PendingCard } from '../../src/components/PendingCard';
import { useToday } from '../../src/state/today';
import { usePending } from '../../src/state/pending';
import { useSync } from '../../src/sync/runtime';
import { shareText } from '../../src/lib/share';
import type { TodayEntry } from '../../src/api/types';
import { contactName, fmtDate } from '../../src/lib/util';

export default function TodayScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const st = useToday();
  const online = useSync((s) => s.online);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void st.load();
    void usePending.getState().load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useFocusEffect(
    useCallback(() => {
      if (st.sections) void st.load();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const refresh = async () => {
    setRefreshing(true);
    await st.load();
    setRefreshing(false);
  };

  const open = (e: TodayEntry) => router.push(`/node/${e.node.id}`);
  const nudge = async (e: TodayEntry) => {
    const text = await st.nudge(e);
    if (text) await shareText(text);
  };

  const sec = st.sections;
  return (
    <View style={{ flex: 1, backgroundColor: C.paper, paddingTop: insets.top }}>
      <LargeTitle title="今天" right={<HeaderLink title="设置" onPress={() => router.push('/settings')} testID="open-settings" />} />
      {!online && <Banner text="离线 · 显示的是上次同步的内容，修改会在联网后发送" tone="warn" />}
      {st.error && online && !st.sections && <Banner text={st.error} tone="warn" />}
      <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={C.ink3} />} contentContainerStyle={{ paddingBottom: 40 }}>
        {!sec && st.loading && <Loading />}
        {!sec && !st.loading && st.error && <Empty text={st.error} />}
        {sec && (
          <>
            <SectionHeader title="逾期" count={sec.overdue.length} first />
            {sec.overdue.length ? (
              sec.overdue.map((e) => (
                <TaskRow key={e.node.id} entry={e} contacts={st.contacts} overdue onPress={() => open(e)} onDone={() => void st.markDone(e)} onPostpone={() => void st.postpone(e)} />
              ))
            ) : (
              <Empty text="没有逾期的任务。" />
            )}

            <SectionHeader title="今天到期" count={sec.dueToday.length} />
            {sec.dueToday.length ? (
              sec.dueToday.map((e) => <TaskRow key={e.node.id} entry={e} contacts={st.contacts} onPress={() => open(e)} onDone={() => void st.markDone(e)} onPostpone={() => void st.postpone(e)} />)
            ) : (
              <Empty text="今天没有到期的任务。" />
            )}

            {sec.dueTomorrow.length > 0 && (
              <>
                <SectionHeader title="明天到期" count={sec.dueTomorrow.length} />
                {sec.dueTomorrow.map((e) => (
                  <TaskRow key={e.node.id} entry={e} contacts={st.contacts} onPress={() => open(e)} onDone={() => void st.markDone(e)} onPostpone={() => void st.postpone(e)} />
                ))}
              </>
            )}

            <SectionHeader title="待确认" count={st.pending.length} />
            {st.pending.length ? (
              st.pending.map((c) => (
                <PendingCard
                  key={c.id}
                  change={c}
                  title={c.nodeTitle}
                  subtitle={c.projectName}
                  contacts={st.contacts}
                  onApprove={() => void st.decide(c, 'approve')}
                  onReject={() => void st.decide(c, 'reject')}
                  onOpen={() => router.push(`/node/${c.nodeId}`)}
                />
              ))
            ) : (
              <Empty text="没有等你确认的变更。" />
            )}

            <SectionHeader title="该催的" count={sec.nudgeDue.length} />
            {sec.nudgeDue.length ? (
              sec.nudgeDue.map((e) => (
                <View key={e.node.id}>
                  <TaskRow entry={e} contacts={st.contacts} overdue showNudge onPress={() => open(e)} onNudge={() => void nudge(e)} />
                  <Text style={s.nudgeMeta}>
                    {contactName(st.contacts, e.node.ownerId)} · 截止 {fmtDate(e.derived.dueDate)} · {e.node.lastNudgedAt ? `上次催办 ${fmtDate(e.node.lastNudgedAt.slice(0, 10))}` : '还没催过'}
                  </Text>
                </View>
              ))
            ) : (
              <Empty text="暂时没有需要催的人。" />
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  nudgeMeta: { fontSize: FONT.tiny, color: C.ink3, paddingHorizontal: 16, paddingVertical: 6, borderBottomWidth: 1, borderColor: C.line },
});
