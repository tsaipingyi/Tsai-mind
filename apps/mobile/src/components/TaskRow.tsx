import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Contact } from '@tsai-mind/core';
import type { TodayEntry } from '../api/types';
import { C, FONT, MONO } from '../theme';
import { contactName, fmtDate } from '../lib/util';
import { Avatar, Btn } from './ui';
import { SwipeRow } from './SwipeRow';

/**
 * A task line in 今天. Swipe left = 标记完成, swipe right = 推迟一天 (iOS habit, design-system §7).
 */
export function TaskRow({
  entry,
  contacts,
  overdue,
  showNudge,
  onPress,
  onDone,
  onPostpone,
  onNudge,
}: {
  entry: TodayEntry;
  contacts: Contact[];
  overdue?: boolean;
  showNudge?: boolean;
  onPress: () => void;
  onDone?: () => void;
  onPostpone?: () => void;
  onNudge?: () => void;
}) {
  const n = entry.node;
  const owner = n.ownerId ? contactName(contacts, n.ownerId) : null;
  const sub = [entry.projectName, ...entry.path.slice(1)].join(' / ') + (owner ? ` · ${owner}` : '');
  const body = (
    <Pressable onPress={onPress} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.paper2 }]} testID={`task-${n.id}`}>
      <Avatar name={owner} me={!n.ownerId} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.title} numberOfLines={1}>
          {n.title || '（无标题）'}
        </Text>
        <Text style={s.sub} numberOfLines={1}>
          {sub}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <Text style={[s.date, overdue && { color: C.red }]}>{fmtDate(entry.derived.dueDate)}</Text>
        {overdue && entry.daysOverdue > 0 && <Text style={s.overdue}>逾期 {entry.daysOverdue} 天</Text>}
      </View>
      {showNudge && onNudge && <Btn title="催办" small kind="primary" onPress={onNudge} testID={`nudge-${n.id}`} />}
    </Pressable>
  );
  if (!onDone && !onPostpone) return body;
  return (
    <SwipeRow onLeft={onDone} leftLabel="标记完成" leftColor={C.green} onRight={onPostpone} rightLabel="推迟一天" rightColor={C.ink2}>
      {body}
    </SwipeRow>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 11, backgroundColor: C.paper, borderBottomWidth: 1, borderColor: C.line, minHeight: 60 },
  title: { fontSize: FONT.body, fontWeight: '500', color: C.ink },
  sub: { fontSize: FONT.tiny, color: C.ink2, marginTop: 2 },
  date: { fontFamily: MONO, fontSize: FONT.small, color: C.ink2 },
  overdue: { fontSize: FONT.tiny, color: C.red },
});
