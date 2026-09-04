import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Change, Contact } from '@tsai-mind/core';
import { C, FONT, MONO } from '../theme';
import { FIELD_LABEL, valueLabel } from '../lib/util';
import { Btn } from './ui';

/**
 * The one pending card (Main.dc.html / Node.dc.html): light-orange, radius 12, padding 14/16;
 * 「Claude 提议 · 节点」13 ink2, the diff 17/500 (dates in mono), the reason 14 ink2,
 * 确认 (orange, grows) and 拒绝 (white, 96 wide).
 */
export function PendingCard({
  change,
  title,
  contacts,
  onApprove,
  onReject,
  onOpen,
  busy,
}: {
  change: Change;
  title: string;
  contacts: Contact[];
  onApprove: () => void;
  onReject: () => void;
  onOpen?: () => void;
  busy?: boolean;
}) {
  const c = change;
  const dateish = c.field === 'dueDate' || c.field === 'startDate';
  const who = c.source === 'claude' ? 'Claude 提议' : '批量操作';
  return (
    <View style={s.card} testID={`change-${c.id}`}>
      <Pressable onPress={onOpen} disabled={!onOpen} style={{ gap: 10 }}>
        <Text style={s.meta} numberOfLines={1}>
          {who} · {title}
        </Text>
        <Text style={s.diff}>
          {c.field === 'delete' ? (
            '删除这个节点'
          ) : (
            <>
              {FIELD_LABEL[c.field] ?? c.field}{' '}
              <Text style={dateish && { fontFamily: MONO }}>
                {valueLabel(c.field, c.oldValue, contacts)} → {valueLabel(c.field, c.newValue, contacts)}
              </Text>
            </>
          )}
        </Text>
        {c.reason ? <Text style={s.reason}>{c.reason}</Text> : null}
      </Pressable>
      <View style={s.actions}>
        <Btn title="确认" kind="primary" grow onPress={onApprove} disabled={busy} testID={`approve-${c.id}`} />
        <Btn title="拒绝" width={96} onPress={onReject} disabled={busy} testID={`reject-${c.id}`} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: C.orangeSoft, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16, gap: 10 },
  meta: { fontSize: FONT.small, color: C.ink2 },
  diff: { fontSize: FONT.title, fontWeight: '500', color: C.ink },
  reason: { fontSize: FONT.meta, color: C.ink2 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
});
