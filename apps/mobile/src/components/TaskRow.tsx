import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Contact } from '@tsai-mind/core';
import type { TodayEntry } from '../api/types';
import { C, FONT, MONO } from '../theme';
import { contactName, fmtDate, weekdayLabel } from '../lib/util';
import { SwipeRow } from './SwipeRow';

export type TaskWhen = 'overdue' | 'today' | 'tomorrow' | 'week';

/**
 * A row of 要做的 (Main.dc.html): min-height 64, title 17/500, sub 13 (owner · 逾期 n 天 in red / 今天 / 明天),
 * right-aligned mono 15 date (red when overdue) and, for overdue rows with a contact owner, a trailing「催」.
 * Swipe left = 标记完成, swipe right = 推迟一天.
 */
export function TaskRow({
  entry,
  contacts,
  when,
  onPress,
  onDone,
  onPostpone,
  onNudge,
}: {
  entry: TodayEntry;
  contacts: Contact[];
  when: TaskWhen;
  onPress: () => void;
  onDone?: () => void;
  onPostpone?: () => void;
  onNudge?: () => void;
}) {
  const n = entry.node;
  const owner = contactName(contacts, n.ownerId);
  const due = entry.derived.dueDate;
  const overdue = when === 'overdue';
  const sub = overdue ? `${owner} · 逾期 ${Math.max(entry.daysOverdue, 1)} 天` : when === 'today' ? `${owner} · 今天` : when === 'tomorrow' ? `${owner} · 明天` : `${owner} · ${due ? weekdayLabel(due) : ''}`;
  const body = (
    <Pressable onPress={onPress} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.paper2 }]} testID={`task-${n.id}`}>
      <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 3 }}>
        <Text style={s.title} numberOfLines={1}>
          {n.title || '（无标题）'}
        </Text>
        <Text style={[s.sub, overdue && { color: C.red }]} numberOfLines={1}>
          {sub}
        </Text>
      </View>
      <Text style={[s.date, overdue && { color: C.red }]}>{fmtDate(due)}</Text>
      {overdue && n.ownerId && onNudge ? (
        <Pressable onPress={onNudge} hitSlop={8} accessibilityRole="button" accessibilityLabel="催办" testID={`nudge-${n.id}`} style={s.nudge}>
          <Text style={s.nudgeText}>催</Text>
        </Pressable>
      ) : null}
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 10, backgroundColor: C.paper, borderBottomWidth: 1, borderColor: C.line },
  title: { fontSize: FONT.title, fontWeight: '500', color: C.ink },
  sub: { fontSize: FONT.small, color: C.ink2 },
  date: { fontFamily: MONO, fontSize: FONT.body, color: C.ink },
  nudge: { paddingVertical: 8, paddingLeft: 12, marginLeft: -12 },
  nudgeText: { fontSize: FONT.body, fontWeight: '500', color: C.orangeDeep },
});
