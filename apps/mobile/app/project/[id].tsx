import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { C, FONT } from '../../src/theme';
import { Banner, Empty, Loading } from '../../src/components/ui';
import { MindMap } from '../../src/components/MindMap';
import { OutlineList } from '../../src/components/OutlineList';
import { useProjects } from '../../src/state/project';

type View_ = 'map' | 'outline';

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const lp = useProjects((s) => (id ? s.projects[id] : undefined));
  const load = useProjects((s) => s.load);
  const [view, setView] = useState<View_>('map');

  useEffect(() => {
    if (id) void load(id);
  }, [id, load]);

  const pendingIds = useMemo(() => new Set((lp?.pending ?? []).map((c) => c.nodeId)), [lp?.pending]);
  const open = (nodeId: string) => router.push(`/node/${nodeId}`);

  return (
    <View style={{ flex: 1, backgroundColor: C.paper }}>
      <Stack.Screen options={{ title: lp?.project?.name ?? '项目' }} />
      <View style={s.toolbar}>
        <View style={s.segment} accessibilityRole="tablist">
          {(['map', 'outline'] as View_[]).map((v) => (
            <Pressable key={v} onPress={() => setView(v)} style={[s.segBtn, view === v && s.segBtnOn]} accessibilityRole="tab" accessibilityState={{ selected: view === v }} testID={`view-${v}`}>
              <Text style={[s.segText, view === v && s.segTextOn]}>{v === 'map' ? '导图' : '大纲'}</Text>
            </Pressable>
          ))}
        </View>
        {lp?.pending.length ? (
          <Text style={s.pendingNote}>
            <Text style={{ color: C.orangeDeep }}>● </Text>待确认 {lp.pending.length}
          </Text>
        ) : null}
      </View>
      {lp?.offline && <Banner text="离线 · 显示的是上次同步的导图" tone="warn" />}
      {!lp || (lp.loading && !lp.project) ? (
        <Loading />
      ) : lp.error && !lp.project ? (
        <Empty text={lp.error} />
      ) : view === 'map' ? (
        <MindMap store={lp.store} derived={lp.derived} contacts={lp.contacts} pendingNodeIds={pendingIds} rev={lp.rev} onSelect={open} />
      ) : (
        <OutlineList store={lp.store} derived={lp.derived} contacts={lp.contacts} pendingNodeIds={pendingIds} rev={lp.rev} onSelect={open} />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderColor: C.line },
  segment: { flexDirection: 'row', borderWidth: 1, borderColor: C.line, borderRadius: 8, overflow: 'hidden' },
  segBtn: { paddingHorizontal: 16, paddingVertical: 6, backgroundColor: C.paper },
  segBtnOn: { backgroundColor: C.orangeSoft },
  segText: { fontSize: FONT.small, color: C.ink2, fontWeight: '500' },
  segTextOn: { color: C.orangeDeep },
  pendingNote: { fontSize: FONT.small, color: C.ink2 },
});
