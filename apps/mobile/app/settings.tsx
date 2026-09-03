import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { C, FONT, MONO } from '../src/theme';
import { Btn } from '../src/components/ui';
import { useSession } from '../src/state/session';
import { useSettings, type NotificationSettings } from '../src/state/settings';
import { useSync } from '../src/sync/runtime';
import { useProjects } from '../src/state/project';

const TOGGLES: { key: keyof NotificationSettings; label: string; note: string }[] = [
  { key: 'dueSoon', label: '到期提醒', note: '到期前 1 天和当天，卡片上可标记完成 / 推迟一天' },
  { key: 'overdue', label: '逾期汇总', note: '每天 09:00 一条' },
  { key: 'nudgeDue', label: '该催了', note: '逾期超过 3 天且 3 天没催' },
  { key: 'digest', label: '周摘要', note: '周一 08:00' },
];

export default function SettingsScreen() {
  const router = useRouter();
  const account = useSession((s) => s.account);
  const serverUrl = useSession((s) => s.serverUrl);
  const logout = useSession((s) => s.logout);
  const notifications = useSettings((s) => s.notifications);
  const setNotification = useSettings((s) => s.setNotification);
  const online = useSync((s) => s.online);
  const queued = useSync((s) => s.queued);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.paper }} contentContainerStyle={{ paddingBottom: 40 }}>
      <Text style={s.group}>账号</Text>
      <Row label="名字" value={account?.name ?? '—'} />
      <Row label="邮箱" value={account?.email ?? '—'} />
      <Row label="服务器" value={serverUrl} mono />
      <Row label="同步" value={online ? (queued ? `在线 · ${queued} 条待发送` : '在线') : `离线 · ${queued} 条待发送`} />

      <Text style={s.group}>通知</Text>
      {TOGGLES.map((t) => (
        <View key={t.key} style={s.row}>
          <View style={{ flex: 1 }}>
            <Text style={s.label}>{t.label}</Text>
            <Text style={s.note}>{t.note}</Text>
          </View>
          <Switch value={notifications[t.key]} onValueChange={(v) => void setNotification(t.key, v)} trackColor={{ true: C.orange, false: C.line }} thumbColor="#fff" ios_backgroundColor={C.line} {...({ activeThumbColor: "#fff" } as object)} />
        </View>
      ))}
      <Text style={s.foot}>Claude 提议改关键字段、草案生成的通知不可关。通知偏好暂存于本机（服务器还没有对应接口）。推送需要开发版或 TestFlight 安装，Expo Go 收不到。</Text>

      <View style={{ paddingHorizontal: 16, marginTop: 28 }}>
        <Btn
          title="退出"
          kind="danger"
          onPress={() => {
            void logout().then(() => {
              useProjects.getState().clearAll();
              router.replace('/login');
            });
          }}
        />
      </View>
    </ScrollView>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={s.label}>{label}</Text>
      <Text style={[s.value, mono && { fontFamily: MONO, fontSize: FONT.small }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  group: { fontSize: FONT.tiny, color: C.ink2, fontWeight: '600', paddingHorizontal: 16, paddingTop: 24, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderColor: C.line, minHeight: 48 },
  label: { fontSize: FONT.body, color: C.ink },
  value: { flex: 1, textAlign: 'right', fontSize: FONT.body, color: C.ink2 },
  note: { fontSize: FONT.tiny, color: C.ink3, marginTop: 2 },
  foot: { fontSize: FONT.tiny, color: C.ink3, paddingHorizontal: 16, paddingTop: 10, lineHeight: 17 },
});
