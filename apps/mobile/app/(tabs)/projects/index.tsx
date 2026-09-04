import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { C, FONT, PAGE_PAD } from '../../../src/theme';
import { useInsets } from '../../../src/components/layout';
import { Chevron, Empty, HeaderLink, LargeTitle, Loading } from '../../../src/components/ui';
import { api, errorMessage } from '../../../src/api/client';
import type { ProjectRow } from '../../../src/api/types';
import { noteOnline, snapshots } from '../../../src/sync/runtime';

export default function ProjectsScreen() {
  const { top } = useInsets();
  const router = useRouter();
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.listProjects();
      noteOnline();
      setRows(r.filter((p) => !p.archivedAt));
      setErr(null);
      void snapshots.saveGeneric('projects', r);
    } catch (e) {
      const cached = await snapshots.loadGeneric<ProjectRow[]>('projects');
      if (cached) setRows(cached.filter((p) => !p.archivedAt));
      setErr(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useFocusEffect(
    useCallback(() => {
      if (rows) void load();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load]),
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.paper, paddingTop: top + 17 }}>
      <LargeTitle title="项目" right={<HeaderLink title="设置" onPress={() => router.push('/settings')} testID="open-settings" />} />
      {!rows && !err && <Loading />}
      {rows && (
        <FlatList
          data={rows}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ paddingTop: 12, paddingHorizontal: PAGE_PAD }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void load().finally(() => setRefreshing(false));
              }}
              tintColor={C.ink3}
            />
          }
          ListEmptyComponent={<Empty text={err ?? '还没有项目。在网页版新建一个。'} />}
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push(`/projects/${item.id}`)} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.paper2 }]} testID={`project-${item.id}`}>
              <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 3 }}>
                <Text style={s.name} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={s.meta} numberOfLines={1}>
                  {item.overdueCount > 0 ? <Text style={{ color: C.red }}>{item.overdueCount} 项逾期</Text> : '无逾期'}
                  {' · '}
                  {item.pendingCount > 0 ? <Text style={{ color: C.orangeDeep }}>{item.pendingCount} 待确认</Text> : '无待确认'}
                </Text>
              </View>
              <Chevron />
            </Pressable>
          )}
        />
      )}
      {rows && err && <Text style={s.err}>{err}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 10, borderBottomWidth: 1, borderColor: C.line },
  name: { fontSize: FONT.title, fontWeight: '500', color: C.ink },
  meta: { fontSize: FONT.small, color: C.ink2 },
  err: { color: C.ink3, fontSize: FONT.small, padding: PAGE_PAD },
});
