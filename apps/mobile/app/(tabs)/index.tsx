import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { C, FONT, PAGE_PAD } from '../../src/theme';
import { useInsets } from '../../src/components/layout';
import { Empty, ListLabel, Loading, MoreRow } from '../../src/components/ui';
import { TaskRow, type TaskWhen } from '../../src/components/TaskRow';
import { PendingCard } from '../../src/components/PendingCard';
import { useToday } from '../../src/state/today';
import { usePending } from '../../src/state/pending';
import { useSync } from '../../src/sync/runtime';
import { shareText } from '../../src/lib/share';
import type { TodayEntry } from '../../src/api/types';
import { longDate } from '../../src/lib/util';

/**
 * 今天 (design/mobile-v2/Main.dc.html): title + date, at most one pending card (+「还有 n 项待确认」),
 * one list「要做的」= overdue + due today + due tomorrow, and「本周还有 n 项」that expands inline.
 */
export default function TodayScreen() {
  const { top } = useInsets();
  const router = useRouter();
  const st = useToday();
  const batches = usePending((s) => s.batches);
  const online = useSync((s) => s.online);
  const [refreshing, setRefreshing] = useState(false);
  const [weekOpen, setWeekOpen] = useState(false);

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
    await Promise.all([st.load(), usePending.getState().load()]);
    setRefreshing(false);
  };

  const open = (e: TodayEntry) => router.push(`/projects/node/${e.node.id}`);
  const nudge = async (e: TodayEntry) => {
    const text = await st.nudge(e);
    if (text) await shareText(text);
  };
  const row = (e: TodayEntry, when: TaskWhen) => (
    <TaskRow key={e.node.id} entry={e} contacts={st.contacts} when={when} onPress={() => open(e)} onDone={() => void st.markDone(e)} onPostpone={() => void st.postpone(e)} onNudge={() => void nudge(e)} />
  );

  const sec = st.sections;
  const todo: { e: TodayEntry; when: TaskWhen }[] = sec
    ? [...sec.overdue.map((e) => ({ e, when: 'overdue' as const })), ...sec.dueToday.map((e) => ({ e, when: 'today' as const })), ...sec.dueTomorrow.map((e) => ({ e, when: 'tomorrow' as const }))]
    : [];
  const first = st.pending[0];
  const morePending = Math.max(0, st.pending.length - 1) + batches.length;

  return (
    <View style={{ flex: 1, backgroundColor: C.paper }}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={C.ink3} />}
        contentContainerStyle={{ paddingTop: top + 17, paddingHorizontal: PAGE_PAD, paddingBottom: 40, gap: 20 }}
      >
        <View style={s.head}>
          <Text style={s.h1} accessibilityRole="header">
            今天
          </Text>
          <Text style={s.date} testID="today-date">
            {longDate(st.today)}
          </Text>
        </View>
        {!online ? <Text style={s.offline}>离线 · 显示的是上次同步的内容，修改会在联网后发送</Text> : null}
        {st.error && online && !sec ? <Text style={s.offline}>{st.error}</Text> : null}

        {first || morePending > 0 ? (
          <View style={{ gap: 8 }}>
            {first ? (
              <PendingCard
                change={first}
                title={first.nodeTitle}
                contacts={st.contacts}
                onApprove={() => void st.decide(first, 'approve')}
                onReject={() => void st.decide(first, 'reject')}
                onOpen={() => router.push(`/projects/node/${first.nodeId}`)}
              />
            ) : null}
            {morePending > 0 ? <MoreRow text={`还有 ${morePending} 项待确认`} onPress={() => router.push('/pending')} testID="more-pending" /> : null}
          </View>
        ) : null}

        {!sec && st.loading ? <Loading /> : null}
        {sec ? (
          <View>
            <ListLabel text={`要做的 · ${todo.length}`} testID="todo-label" />
            {todo.length ? todo.map(({ e, when }) => row(e, when)) : <Empty text="没有逾期、今天或明天到期的任务。" />}
          </View>
        ) : null}

        {sec && st.week.length > 0 ? (
          <View>
            <MoreRow text={`本周还有 ${st.week.length} 项`} onPress={() => setWeekOpen((v) => !v)} expanded={weekOpen} testID="more-week" />
            {weekOpen ? st.week.map((e) => row(e, 'week')) : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  h1: { fontSize: FONT.large, fontWeight: '700', color: C.ink, letterSpacing: -0.3, lineHeight: 41 },
  date: { fontSize: FONT.body, color: C.ink2 },
  offline: { fontSize: FONT.small, color: C.orangeDeep },
});
