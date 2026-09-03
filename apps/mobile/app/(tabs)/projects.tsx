import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, MONO } from '../../src/theme';
import { Empty, HeaderLink, LargeTitle, Loading } from '../../src/components/ui';
import { api, errorMessage } from '../../src/api/client';
import type { ProjectRow } from '../../src/api/types';
import { noteOnline, snapshots } from '../../src/sync/runtime';

export default function ProjectsScreen() {
  const insets = useSafeAreaInsets();
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
    <View style={{ flex: 1, backgroundColor: C.paper, paddingTop: insets.top }}>
      <LargeTitle title="项目" right={<HeaderLink title="设置" onPress={() => router.push('/settings')} />} />
      {!rows && !err && <Loading />}
      {rows && (
        <FlatList
          data={rows}
          keyExtractor={(p) => p.id}
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
            <Pressable onPress={() => router.push(`/project/${item.id}`)} style={({ pressed }) => [s.row, pressed && { backgroundColor: C.paper2 }]} testID={`project-${item.id}`}>
              <View style={{ flex: 1 }}>
                <Text style={s.name} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={s.meta}>
                  {item.overdueCount > 0 ? <Text style={{ color: C.red }}>逾期 {item.overdueCount}</Text> : <Text>无逾期</Text>}
                  {' · '}
                  {item.pendingCount > 0 ? <Text style={{ color: C.orangeDeep }}>待确认 {item.pendingCount}</Text> : <Text>无待确认</Text>}
                </Text>
              </View>
              <Text style={s.chev}>›</Text>
            </Pressable>
          )}
        />
      )}
      {rows && err && <Text style={s.err}>{err}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderColor: C.line },
  name: { fontSize: FONT.title, fontWeight: '600', color: C.ink },
  meta: { fontSize: FONT.small, color: C.ink2, marginTop: 3, fontFamily: MONO },
  chev: { fontSize: 22, color: C.ink3 },
  err: { color: C.ink3, fontSize: FONT.tiny, padding: 16 },
});
