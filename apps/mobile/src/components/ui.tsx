import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import type { NodeStatus } from '@tsai-mind/core';
import { C, FONT, MONO, PAGE_PAD, RADIUS, STATUS_COLOR } from '../theme';
import { STATUS_LABEL } from '../lib/util';
import { useToasts } from '../state/toast';

/**
 * Buttons per the artboards: primary = orange, 44 high, radius 10, white 16/500;
 * secondary = white, 1px line, 16 ink. `grow` fills the row.
 */
export function Btn({
  title,
  onPress,
  kind = 'secondary',
  grow,
  width,
  height = 44,
  disabled,
  busy,
  style,
  testID,
}: {
  title: string;
  onPress?: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  grow?: boolean;
  width?: number;
  height?: number;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        s.btn,
        { height },
        grow && { flexGrow: 1, flexBasis: 0 },
        width !== undefined && { width },
        kind === 'primary' && s.btnPrimary,
        pressed && (kind === 'primary' ? { backgroundColor: C.orangeDeep } : { backgroundColor: C.paper2 }),
        off && { opacity: 0.5 },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={kind === 'primary' ? '#fff' : C.ink2} />
      ) : (
        <Text style={[s.btnText, kind === 'primary' && { color: '#fff', fontWeight: '500' }, kind === 'danger' && { color: C.red }]}>{title}</Text>
      )}
    </Pressable>
  );
}

/** Status pill (Node.dc.html): 40 high, radius 20, 15px; selected = 1.5px border in the status colour + same colour 500. */
export function StatusPill({ status, active, onPress, grow = true, disabled }: { status: NodeStatus; active: boolean; onPress?: () => void; grow?: boolean; disabled?: boolean }) {
  const color = STATUS_COLOR[status];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled: !!disabled }}
      aria-selected={active}
      onPress={onPress}
      disabled={disabled || !onPress}
      style={[s.pill, grow && { flexGrow: 1, flexBasis: 0 }, active && { borderColor: color, borderWidth: 1.5 }, disabled && { opacity: 0.6 }]}
      testID={`status-${status}`}
    >
      <Text style={[s.pillText, active && { color, fontWeight: '500' }]}>{STATUS_LABEL[status]}</Text>
    </Pressable>
  );
}

export function StatusDot({ status, size = 8 }: { status: NodeStatus; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: STATUS_COLOR[status], flexShrink: 0 }} />;
}

/** The orange 8px「待确认」marker (design-system §2). */
export function PendingDot() {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.orange, flexShrink: 0 }} />;
}

/** 13px ink2 list label with a 1px bottom line (Main.dc.html「要做的 · 4」). */
export function ListLabel({ text, testID }: { text: string; testID?: string }) {
  return (
    <Text style={s.listLabel} testID={testID}>
      {text}
    </Text>
  );
}

/** 15px ink2 row with a trailing › (「本周还有 3 项」「还有 n 项待确认」「更多：…」). */
export function MoreRow({ text, onPress, expanded, tall, testID, top }: { text: string; onPress: () => void; expanded?: boolean; tall?: boolean; testID?: string; top?: boolean }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ expanded }} style={[s.moreRow, tall && s.moreRowTall, top && { borderTopWidth: 1, borderColor: C.line }]} testID={testID}>
      <Text style={s.moreText} numberOfLines={1}>
        {text}
      </Text>
      <Text style={[s.chev, expanded && { transform: [{ rotate: '90deg' }] }]}>›</Text>
    </Pressable>
  );
}

export function Chevron() {
  return <Text style={s.chev}>›</Text>;
}

/** Orange ‹ back chevron (22px, 24 wide) used by the project and node headers. */
export function BackChevron({ onPress, testID }: { onPress: () => void; testID?: string }) {
  return (
    <Pressable onPress={onPress} hitSlop={12} accessibilityRole="button" accessibilityLabel="返回" testID={testID} style={{ width: 24 }}>
      <Text style={s.back}>‹</Text>
    </Pressable>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <View style={s.empty}>
      <Text style={s.emptyText}>{text}</Text>
    </View>
  );
}

export function Mono({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[{ fontFamily: MONO, fontSize: FONT.small, color: C.ink2 }, style]}>{children}</Text>;
}

export function Line() {
  return <View style={s.line} />;
}

/** Large title (34/700, -0.3 tracking) with a baseline-aligned right slot. */
export function LargeTitle({ title, right, onPress, testID }: { title: string; right?: ReactNode; onPress?: () => void; testID?: string }) {
  const text = (
    <Text style={s.largeTitleText} accessibilityRole="header">
      {title}
    </Text>
  );
  return (
    <View style={s.largeTitle}>
      {onPress ? (
        <Pressable onPress={onPress} hitSlop={8} accessibilityRole="button" testID={testID} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {text}
        </Pressable>
      ) : (
        text
      )}
      {right}
    </View>
  );
}

/** 15px text link; orange (#D4550C, 500) for actions like 问 Claude / 新对话, ink2 otherwise. */
export function HeaderLink({ title, onPress, testID, tone = 'ink' }: { title: string; onPress: () => void; testID?: string; tone?: 'ink' | 'orange' }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} testID={testID} accessibilityRole="button">
      {({ pressed }) => (
        <Text style={{ fontSize: FONT.body, color: tone === 'orange' ? C.orangeDeep : C.ink2, fontWeight: tone === 'orange' ? '500' : '400', opacity: pressed ? 0.6 : 1 }}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Banner({ text, tone = 'info' }: { text: string; tone?: 'info' | 'warn' }) {
  return (
    <View style={[s.banner, tone === 'warn' && { backgroundColor: C.orangeSoft }]}>
      <Text style={{ fontSize: FONT.small, color: tone === 'warn' ? C.orangeDeep : C.ink2 }}>{text}</Text>
    </View>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Pressable onPress={() => onChange(!checked)} style={s.checkRow} accessibilityRole="checkbox" accessibilityState={{ checked }}>
      <View style={[s.checkBox, checked && { backgroundColor: C.orange, borderColor: C.orange }]}>{checked && <View style={s.checkMark} />}</View>
      {label ? <Text style={{ fontSize: FONT.small, color: C.ink2, flex: 1 }}>{label}</Text> : null}
    </Pressable>
  );
}

export function Toasts() {
  const toasts = useToasts((t) => t.toasts);
  if (!toasts.length) return null;
  return (
    <View pointerEvents="none" style={s.toastWrap}>
      {toasts.map((t) => (
        <View key={t.id} style={[s.toast, t.kind === 'error' && { borderColor: C.red }, t.kind === 'ok' && { borderColor: C.green }]}>
          <Text style={{ color: C.ink, fontSize: FONT.small }}>{t.text}</Text>
        </View>
      ))}
    </View>
  );
}

export function Loading() {
  return (
    <View style={{ padding: 32, alignItems: 'center' }}>
      <ActivityIndicator color={C.ink3} />
    </View>
  );
}

const s = StyleSheet.create({
  btn: {
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: RADIUS,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.paper,
  },
  btnPrimary: { backgroundColor: C.orange, borderColor: C.orange },
  btnText: { fontSize: FONT.input, color: C.ink },
  pill: { height: 40, borderRadius: 20, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center', backgroundColor: C.paper, paddingHorizontal: 12 },
  pillText: { fontSize: FONT.body, color: C.ink2 },
  listLabel: { fontSize: FONT.small, color: C.ink2, paddingBottom: 6, borderBottomWidth: 1, borderColor: C.line },
  moreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4, gap: 12 },
  moreRowTall: { height: 44, paddingVertical: 0 },
  moreText: { fontSize: FONT.body, color: C.ink2, flexShrink: 1 },
  chev: { fontSize: 18, color: C.ink3 },
  back: { fontSize: 22, color: C.orange, lineHeight: 26 },
  empty: { paddingVertical: 14 },
  emptyText: { color: C.ink3, fontSize: FONT.small },
  line: { height: 1, backgroundColor: C.line },
  largeTitle: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: PAGE_PAD },
  largeTitleText: { fontSize: FONT.large, fontWeight: '700', color: C.ink, letterSpacing: -0.3, lineHeight: 41 },
  banner: { backgroundColor: C.paper2, paddingHorizontal: PAGE_PAD, paddingVertical: 8, borderBottomWidth: 1, borderColor: C.line },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  checkBox: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: C.ink3, alignItems: 'center', justifyContent: 'center', backgroundColor: C.paper },
  checkMark: { width: 8, height: 8, borderRadius: 2, backgroundColor: '#fff' },
  toastWrap: { position: 'absolute', left: 16, right: 16, bottom: 96, gap: 8, alignItems: 'center' },
  toast: { backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, borderRadius: RADIUS, paddingHorizontal: 14, paddingVertical: 10, maxWidth: '100%' },
});
