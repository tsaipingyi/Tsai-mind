import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ISODate } from '@tsai-mind/core';
import { C, FONT, MONO, RADIUS } from '../theme';
import { dateToISO, isISODateString, isoToDate } from '../lib/util';

/**
 * Date row with the native picker (iOS inline calendar / Android dialog).
 * On web (only used for visual verification) it is a YYYY-MM-DD text field.
 */
export function DateField({
  label,
  value,
  onChange,
  disabled,
  note,
  overdue,
}: {
  label: string;
  value: ISODate | null;
  onChange: (v: ISODate | null) => void;
  disabled?: boolean;
  note?: string;
  overdue?: boolean;
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
      <View style={{ flexDirection: 'row', gap: 8, paddingBottom: 10 }}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={C.ink3}
          autoFocus
          style={s.input}
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
      </View>
    );
  }

  return (
    <View>
      <Pressable onPress={() => void openPicker()} disabled={disabled} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.paper2 }]}>
        <Text style={s.label}>{label}</Text>
        <View style={{ flex: 1 }} />
        {note ? <Text style={s.note}>{note}</Text> : null}
        <Text style={[s.value, !value && { color: C.ink3 }, overdue && { color: C.red }, disabled && { color: C.ink3 }]}>{value ?? '未设'}</Text>
        {value && !disabled && (
          <Pressable
            hitSlop={8}
            onPress={() => {
              onChange(null);
              setOpen(false);
            }}
            accessibilityLabel={`清除${label}`}
          >
            <Text style={s.clear}>×</Text>
          </Pressable>
        )}
      </Pressable>
      {picker}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderColor: C.line },
  label: { fontSize: FONT.body, color: C.ink },
  note: { fontSize: FONT.tiny, color: C.ink3 },
  value: { fontFamily: MONO, fontSize: FONT.body, color: C.ink },
  clear: { fontSize: 18, color: C.ink3, paddingHorizontal: 4 },
  input: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: RADIUS, paddingHorizontal: 10, paddingVertical: 8, fontFamily: MONO, fontSize: FONT.body, color: C.ink },
});
