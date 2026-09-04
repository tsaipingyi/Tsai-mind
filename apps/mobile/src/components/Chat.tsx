import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ToolCall } from '../api/types';
import { C, FONT, MONO, RADIUS } from '../theme';
import { toolLabel, toolOutcome, type ChatMessage } from '../state/assistant';

/**
 * Chat pieces from Claude.dc.html: user bubbles right (#F3F3F3, radius 16/16/4/16, padding 10/14, 16px);
 * assistant replies as plain 16px text left (max width 300, no bubble) with tool chips underneath.
 */
export function MessageBubble({ message }: { message: ChatMessage }) {
  const mine = message.role === 'user';
  const waiting = message.streaming && !message.text && !message.toolCalls.length;
  if (mine) {
    return (
      <View style={s.mine} testID={`msg-${message.id}`}>
        <Text style={s.mineText} selectable>
          {message.text}
        </Text>
      </View>
    );
  }
  return (
    <View style={s.theirs} testID={`msg-${message.id}`}>
      {waiting ? (
        <ActivityIndicator size="small" color={C.ink3} style={{ alignSelf: 'flex-start', marginVertical: 2 }} />
      ) : message.text ? (
        <Text style={s.theirsText} selectable>
          {message.text}
          {message.streaming ? <Text style={{ color: C.ink3 }}> ▍</Text> : null}
        </Text>
      ) : null}
      {message.toolCalls.map((t, i) => (
        <ToolChip key={i} call={t} />
      ))}
      {message.error ? <Text style={s.err}>{message.error}</Text> : null}
    </View>
  );
}

/** 「改了截止日 · 待确认」chip: 13px, 1px #F8B98F border, radius 8, orange dot; grey when done, red text when failed. Tap to expand. */
export function ToolChip({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const outcome = toolOutcome(call);
  const pending = outcome === '待确认';
  let input = '';
  try {
    input = call.input === undefined ? '' : JSON.stringify(call.input, null, 2);
  } catch {
    input = String(call.input);
  }
  return (
    <View style={{ alignSelf: 'flex-start', maxWidth: '100%' }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => [s.chip, pending && s.chipPending, pressed && { opacity: 0.7 }]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        testID={`tool-${call.name}`}
      >
        <View style={[s.dot, { backgroundColor: pending ? C.orange : outcome === '失败' ? C.red : C.ink3 }]} />
        <Text style={[s.chipText, pending && { color: C.orangeDeep }, outcome === '失败' && { color: C.red }]} numberOfLines={1}>
          {toolLabel(call)}
        </Text>
      </Pressable>
      {open && (
        <View style={s.detail}>
          <Text style={s.detailLabel}>{call.name}</Text>
          {input ? (
            <Text style={s.mono} selectable>
              {input}
            </Text>
          ) : null}
          <Text style={[s.detailLabel, { marginTop: 6 }]}>结果</Text>
          <Text style={s.mono} selectable>
            {call.resultText || '（空）'}
          </Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  mine: { alignSelf: 'flex-end', maxWidth: 280, backgroundColor: C.bubble, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderBottomRightRadius: 4, borderBottomLeftRadius: 16, paddingVertical: 10, paddingHorizontal: 14 },
  mineText: { fontSize: FONT.input, lineHeight: 23, color: C.ink },
  theirs: { alignSelf: 'flex-start', maxWidth: 300, gap: 8 },
  theirsText: { fontSize: FONT.input, lineHeight: 24, color: C.ink },
  err: { fontSize: FONT.small, color: C.red },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: C.paper },
  chipPending: { borderColor: C.orangeLine },
  dot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { fontSize: FONT.small, color: C.ink2, flexShrink: 1 },
  detail: { marginTop: 6, borderWidth: 1, borderColor: C.line, borderRadius: RADIUS, padding: 8, backgroundColor: C.paper2 },
  detailLabel: { fontSize: FONT.tiny, color: C.ink3, marginBottom: 2, fontFamily: MONO },
  mono: { fontFamily: MONO, fontSize: 11, color: C.ink, lineHeight: 15 },
});
