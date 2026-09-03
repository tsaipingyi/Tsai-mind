import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Change, Contact } from '@tsai-mind/core';
import { C, FONT, MONO } from '../theme';
import { FIELD_LABEL, valueLabel } from '../lib/util';
import { Btn } from './ui';

/** Light-orange card with a 3px orange bar (design-system §5) and 确认 / 拒绝. */
export function PendingCard({
  change,
  title,
  subtitle,
  contacts,
  onApprove,
  onReject,
  onOpen,
  busy,
}: {
  change: Change;
  title: string;
  subtitle?: string;
  contacts: Contact[];
  onApprove: () => void;
  onReject: () => void;
  onOpen?: () => void;
  busy?: boolean;
}) {
  const c = change;
  const dateish = c.field === 'dueDate' || c.field === 'startDate';
  return (
    <View style={s.card} testID={`change-${c.id}`}>
      <Pressable onPress={onOpen} disabled={!onOpen}>
        <Text style={s.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={s.meta}>
          {subtitle ? `${subtitle} · ` : ''}
          {c.source === 'claude' ? '经 Claude' : '批量操作'}
        </Text>
        <View style={s.diffRow}>
          <Text style={s.diffLabel}>{FIELD_LABEL[c.field] ?? c.field}</Text>
          {c.field !== 'delete' && (
            <Text style={[s.diffValue, dateish && { fontFamily: MONO }]}>
              {valueLabel(c.field, c.oldValue, contacts)} → {valueLabel(c.field, c.newValue, contacts)}
            </Text>
          )}
        </View>
        {c.reason ? <Text style={s.reason}>{c.reason}</Text> : null}
      </Pressable>
      <View style={s.actions}>
        <Btn title="确认" kind="primary" small onPress={onApprove} disabled={busy} testID={`approve-${c.id}`} />
        <Btn title="拒绝" small onPress={onReject} disabled={busy} testID={`reject-${c.id}`} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: C.orangeSoft, borderLeftWidth: 3, borderLeftColor: C.orange, marginHorizontal: 16, marginBottom: 10, padding: 12, borderRadius: 6, gap: 6 },
  title: { fontSize: FONT.body, fontWeight: '600', color: C.ink },
  meta: { fontSize: FONT.tiny, color: C.ink2, marginTop: 1 },
  diffRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 4, flexWrap: 'wrap' },
  diffLabel: { fontSize: FONT.small, color: C.ink2 },
  diffValue: { fontSize: FONT.body, color: C.ink, fontWeight: '500' },
  reason: { fontSize: FONT.small, color: C.ink2, marginTop: 2 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 6 },
});
