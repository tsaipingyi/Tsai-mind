import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ISODate } from '@tsai-mind/core';
import { C, FONT, MONO, RADIUS } from '../theme';
import { dateToISO, isISODateString, isoToDate } from '../lib/util';
import { Chevron } from './ui';

/**
 * A 52px card row (Node.dc.html): label 16 (80 wide), value 16 mono, trailing ›.
 * Tap opens the native picker (iOS inline calendar / Android dialog); on web (visual check only) a YYYY-MM-DD field.
 */
export function DateField({
  label,
  value,
  onChange,
  disabled,
  note,
  overdue,
  overdueDays,
  last,
  testID,
}: {
  label: string;
  value: ISODate | null;
  onChange: (v: ISODate | null) => void;
  disabled?: boolean;
  /** shown in place of the chevron, e.g. 由子节点推导 */
  note?: string;
  overdue?: boolean;
  overdueDays?: number;
  /** no bottom line (last row of the card) */
  last?: boolean;
  testID?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value ?? '');

  const openPicker = async () => {
    if (disabled) return;
    if (Platform.OS === 'android') {
      const { DateTimePickerAndroid } = require('@react-native-community/datetimepicker') as typeof import('@react-native-community/datetimepicker');
      DateTimePickerAndroid.open({
        value: value ? isoToDate(value) : new Date(),
        mode: 'date',
        onChange: (ev, d) => {
          if (ev.type === 'set' && d) onChange(dateToISO(d));
        },
      });
      return;
    }
    setDraft(value ?? '');
    setOpen((o) => !o);
  };

  let picker: React.ReactNode = null;
  if (open && Platform.OS === 'ios') {
    const DateTimePicker = (require('@react-native-community/datetimepicker') as typeof import('@react-native-community/datetimepicker')).default;
    picker = (
      <DateTimePicker
        value={value ? isoToDate(value) : new Date()}
        mode="date"
        display="inline"
        locale="zh-CN"
        accentColor={C.orange}
        onChange={(ev, d) => {
          if (d) onChange(dateToISO(d));
          if (ev.type === 'set') setOpen(false);
        }}
      />
    );
  } else if (open && Platform.OS === 'web') {
    picker = (
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder="YYYY-MM-DD"
        placeholderTextColor={C.ink3}
        autoFocus
        style={s.input}
        testID={testID ? `${testID}-input` : undefined}
        onSubmitEditing={() => {
          if (isISODateString(draft)) {
            onChange(draft);
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (isISODateString(draft)) onChange(draft);
          setOpen(false);
        }}
      />
    );
  }

  const text = value ? `${fmtShort(value)}${overdue && overdueDays ? ` · 逾期 ${overdueDays} 天` : ''}` : '未设';
  return (
    <View style={[!last && s.lined]}>
      <Pressable onPress={() => void openPicker()} disabled={disabled} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.paper2 }]} testID={testID}>
        <Text style={s.label}>{label}</Text>
        <Text style={[s.value, !value && { color: C.ink3 }, overdue && { color: C.red }, disabled && { color: C.ink3 }]} numberOfLines={1}>
          {text}
        </Text>
        {note ? <Text style={s.note}>{note}</Text> : !disabled ? <Chevron /> : null}
      </Pressable>
      {picker ? (
        <View style={s.pickerWrap}>
          {picker}
          {value && !disabled ? (
            <Pressable
              hitSlop={8}
              onPress={() => {
                onChange(null);
                setOpen(false);
              }}
              accessibilityRole="button"
            >
              <Text style={s.clear}>清除{label}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function fmtShort(iso: ISODate): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return y === new Date().getFullYear() ? `${m}/${d}` : iso;
}

const s = StyleSheet.create({
  lined: { borderBottomWidth: 1, borderColor: C.line },
  row: { flexDirection: 'row', alignItems: 'center', height: 52, paddingHorizontal: 16 },
  label: { fontSize: FONT.input, color: C.ink, width: 80 },
  value: { flexGrow: 1, flexShrink: 1, fontSize: FONT.input, color: C.ink, fontFamily: MONO },
  note: { fontSize: FONT.small, color: C.ink3 },
  pickerWrap: { paddingHorizontal: 16, paddingBottom: 12, gap: 8 },
  clear: { fontSize: FONT.small, color: C.ink2 },
  input: { borderWidth: 1, borderColor: C.line, borderRadius: RADIUS, paddingHorizontal: 10, paddingVertical: 8, fontFamily: MONO, fontSize: FONT.input, color: C.ink },
});
