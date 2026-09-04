import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ToolCall } from '../api/types';
import { C, FONT, MONO, RADIUS } from '../theme';
import { toolOutcome, type ChatMessage } from '../state/assistant';

/**
 * Chat pieces (design-system: white ground, orange only for attention).
 * User bubbles sit right in light grey; assistant bubbles sit left, white with a thin line.
 * Tool calls are compact chips「调用 update_node · 待确认」that expand on tap.
 */
export function MessageBubble({ message }: { message: ChatMessage }) {
  const mine = message.role === 'user';
  const waiting = message.streaming && !message.text && !message.toolCalls.length;
  return (
    <View style={[s.row, mine ? s.rowMine : s.rowTheirs]} testID={`msg-${message.id}`}>
      <View style={[s.bubble, mine ? s.bubbleMine : s.bubbleTheirs]}>
        {message.toolCalls.map((t, i) => (
          <ToolChip key={i} call={t} />
        ))}
        {waiting ? (
          <ActivityIndicator size="small" color={C.ink3} style={{ alignSelf: 'flex-start', marginVertical: 2 }} />
        ) : message.text ? (
          <Text style={s.text} selectable>
            {message.text}
            {message.streaming ? <Text style={{ color: C.ink3 }}> ▍</Text> : null}
          </Text>
        ) : null}
        {message.error ? <Text style={s.err}>{message.error}</Text> : null}
      </View>
    </View>
  );
}

export function ToolChip({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const outcome = toolOutcome(call);
  let input = '';
  try {
    input = call.input === undefined ? '' : JSON.stringify(call.input, null, 2);
  } catch {
    input = String(call.input);
  }
  return (
    <View style={{ marginBottom: 6 }}>
      <Pressable onPress={() => setOpen((v) => !v)} style={({ pressed }) => [s.chip, outcome === '待确认' && s.chipPending, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityState={{ expanded: open }} testID={`tool-${call.name}`}>
        <Text style={[s.chipText, outcome === '待确认' && { color: C.orangeDeep }, outcome === '失败' && { color: C.red }]} numberOfLines={1}>
          调用 {call.name} · {outcome}
        </Text>
        <Text style={s.chipChev}>{open ? '▴' : '▾'}</Text>
      </Pressable>
      {open && (
        <View style={s.detail}>
          {input ? (
            <>
              <Text style={s.detailLabel}>输入</Text>
              <Text style={s.mono} selectable>
                {input}
              </Text>
            </>
          ) : null}
          <Text style={[s.detailLabel, input ? { marginTop: 6 } : null]}>结果</Text>
          <Text style={s.mono} selectable>
            {call.resultText || '（空）'}
          </Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', paddingHorizontal: 12, marginBottom: 8 },
  rowMine: { justifyContent: 'flex-end' },
  rowTheirs: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '86%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  bubbleMine: { backgroundColor: C.paper2, borderBottomRightRadius: 4, borderWidth: 1, borderColor: C.paper2 },
  bubbleTheirs: { backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, borderBottomLeftRadius: 4 },
  text: { fontSize: FONT.body, color: C.ink, lineHeight: 21 },
  err: { fontSize: FONT.tiny, color: C.red, marginTop: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderWidth: 1, borderColor: C.line, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: C.paper },
  chipPending: { borderColor: C.orangeLine, backgroundColor: C.orangeSoft },
  chipText: { fontSize: FONT.tiny, color: C.ink2, fontFamily: MONO },
  chipChev: { fontSize: 10, color: C.ink3 },
  detail: { marginTop: 4, borderWidth: 1, borderColor: C.line, borderRadius: RADIUS, padding: 8, backgroundColor: C.paper2 },
  detailLabel: { fontSize: FONT.tiny, color: C.ink3, marginBottom: 2 },
  mono: { fontFamily: MONO, fontSize: 11, color: C.ink, lineHeight: 15 },
});
