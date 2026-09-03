import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import type { NodeStatus } from '@tsai-mind/core';
import { C, FONT, MONO, RADIUS, STATUS_COLOR } from '../theme';
import { STATUS_LABEL, initial } from '../lib/util';
import { useToasts } from '../state/toast';

export function Btn({
  title,
  onPress,
  kind = 'secondary',
  small,
  disabled,
  busy,
  style,
  testID,
}: {
  title: string;
  onPress?: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  small?: boolean;
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
        small && s.btnSmall,
        kind === 'primary' && s.btnPrimary,
        kind === 'danger' && s.btnDanger,
        pressed && (kind === 'primary' ? { backgroundColor: C.orangeDeep } : { backgroundColor: C.paper2 }),
        off && { opacity: 0.5 },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={kind === 'primary' ? '#fff' : C.ink2} />
      ) : (
        <Text style={[s.btnText, small && { fontSize: FONT.small }, kind === 'primary' && { color: '#fff' }, kind === 'danger' && { color: C.red }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function StatusPill({ status, active = true, onPress }: { status: NodeStatus; active?: boolean; onPress?: () => void }) {
  const color = STATUS_COLOR[status];
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      disabled={!onPress}
      style={[s.pill, { borderColor: active ? color : C.line }]}
    >
      <Text style={[s.pillText, { color: active ? color : C.ink3 }]}>{STATUS_LABEL[status]}</Text>
    </Pressable>
  );
}

export function StatusDot({ status, size = 8 }: { status: NodeStatus; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: STATUS_COLOR[status] }} />;
}

export function Avatar({ name, me, size = 28 }: { name?: string | null; me?: boolean; size?: number }) {
  const isMe = me || name == null;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: isMe ? C.ink : C.paper2,
        borderWidth: isMe ? 0 : 1,
        borderColor: C.line,
      }}
    >
      <Text style={{ fontSize: size * 0.42, fontWeight: '600', color: isMe ? '#fff' : C.ink2 }}>{isMe ? '我' : initial(name ?? '?')}</Text>
    </View>
  );
}

export function SectionHeader({ title, count, first }: { title: string; count?: number; first?: boolean }) {
  return (
    <View style={[s.sectionHeader, first && { marginTop: 4 }]}>
      <Text style={s.sectionTitle}>{title}</Text>
      {count !== undefined && <Text style={s.sectionCount}>{count}</Text>}
    </View>
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

export function LargeTitle({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={s.largeTitle}>
      <Text style={s.largeTitleText} accessibilityRole="header">
        {title}
      </Text>
      {right}
    </View>
  );
}

export function HeaderLink({ title, onPress, testID }: { title: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} testID={testID} accessibilityRole="button">
      {({ pressed }) => <Text style={{ fontSize: FONT.body, color: pressed ? C.ink3 : C.ink2 }}>{title}</Text>}
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
      <View style={[s.checkBox, checked && { backgroundColor: C.orange, borderColor: C.orange }]}>{checked && <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>✓</Text>}</View>
      <Text style={{ fontSize: FONT.small, color: C.ink2, flex: 1 }}>{label}</Text>
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
    paddingVertical: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.paper,
    minHeight: 40,
  },
  btnSmall: { paddingHorizontal: 12, paddingVertical: 6, minHeight: 32 },
  btnPrimary: { backgroundColor: C.orange, borderColor: C.orange },
  btnDanger: { borderColor: C.line },
  btnText: { fontSize: FONT.body, fontWeight: '500', color: C.ink },
  pill: { borderWidth: 1, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: C.paper },
  pillText: { fontSize: FONT.small, fontWeight: '500' },
  sectionHeader: { flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 16, paddingTop: 22, paddingBottom: 8 },
  sectionTitle: { fontSize: FONT.title, fontWeight: '700', color: C.ink },
  sectionCount: { fontSize: FONT.small, color: C.ink3, fontFamily: MONO },
  empty: { paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.line },
  emptyText: { color: C.ink3, fontSize: FONT.small },
  line: { height: 1, backgroundColor: C.line },
  largeTitle: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 },
  largeTitleText: { fontSize: FONT.large, fontWeight: '700', color: C.ink, letterSpacing: 0.2 },
  banner: { backgroundColor: C.paper2, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderColor: C.line },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  checkBox: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: C.ink3, alignItems: 'center', justifyContent: 'center', backgroundColor: C.paper },
  toastWrap: { position: 'absolute', left: 16, right: 16, bottom: 96, gap: 8, alignItems: 'center' },
  toast: { backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, borderRadius: RADIUS, paddingHorizontal: 14, paddingVertical: 10, maxWidth: '100%' },
});
