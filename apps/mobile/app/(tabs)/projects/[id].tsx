import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { TNode } from '@tsai-mind/core';
import { C, FONT, PAGE_PAD, RADIUS } from '../../../src/theme';
import { useInsets } from '../../../src/components/layout';
import { BackChevron, Empty, HeaderLink, Loading } from '../../../src/components/ui';
import { PlusIcon } from '../../../src/components/icons';
import { MindMap } from '../../../src/components/MindMap';
import { OutlineList } from '../../../src/components/OutlineList';
import { useProjects } from '../../../src/state/project';
import { fmtDate } from '../../../src/lib/util';

type View_ = 'outline' | 'map';

/**
 * Project (design/mobile-v2/Project.dc.html): back + title + meta + 问 Claude, a 列表 | 导图 segment
 * (列表 default), the outline rows, a hint line and the orange「+」that adds a child under the root.
 */
export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { top } = useInsets();
  const router = useRouter();
  const lp = useProjects((s) => (id ? s.projects[id] : undefined));
  const load = useProjects((s) => s.load);
  const createChild = useProjects((s) => s.createChild);
  const markDone = useProjects((s) => s.markDone);
  const [view, setView] = useState<View_>('outline');

  useEffect(() => {
    if (id) void load(id);
  }, [id, load]);

  const pendingIds = useMemo(() => new Set((lp?.pending ?? []).map((c) => c.nodeId)), [lp?.pending]);
  const criticalIds = useMemo(() => new Set(lp?.criticalPath ?? []), [lp?.criticalPath]);
  const open = (nodeId: string) => router.push(`/projects/node/${nodeId}`);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/projects'));
  const askClaude = () => router.push(`/claude?projectId=${encodeURIComponent(id ?? '')}&t=${Date.now()}`);
  const add = () => {
    const root = lp?.store.root();
    if (!id || !root) return;
    const nid = createChild(id, root.id);
    if (nid) router.push(`/projects/node/${nid}?focus=1`);
  };

  const meta = useMemo(() => {
    if (!lp?.project) return '';
    const root = lp.store.root();
    const d = root ? lp.derived.get(root.id) : undefined;
    const parts: string[] = [];
    if (d) parts.push(`进度 ${d.progress}%`);
    const milestones = lp.store
      .all()
      .filter((n: TNode) => n.kind === 'milestone' && (lp.derived.get(n.id)?.dueDate ?? n.dueDate))
      .sort((a, b) => ((lp.derived.get(a.id)?.dueDate ?? a.dueDate)! < (lp.derived.get(b.id)?.dueDate ?? b.dueDate)! ? 1 : -1));
    const m = milestones[0];
    if (m) parts.push(`${fmtDate(lp.derived.get(m.id)?.dueDate ?? m.dueDate)} ${m.title}`);
    else if (d?.dueDate) parts.push(`截止 ${fmtDate(d.dueDate)}`);
    if (lp.slips.length) parts.push(`${lp.slips.length} 处延误`);
    return parts.join(' · ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lp, lp?.rev, lp?.slips]);

  return (
    <View style={{ flex: 1, backgroundColor: C.paper, paddingTop: top + 9 }}>
      <View style={s.header}>
        <BackChevron onPress={back} testID="project-back" />
        <View style={{ flexGrow: 1, flexShrink: 1, gap: 2 }}>
          <Text style={s.title} numberOfLines={1}>
            {lp?.project?.name ?? '项目'}
          </Text>
          {meta ? (
            <Text style={s.meta} numberOfLines={1} testID="project-meta">
              {meta}
            </Text>
          ) : null}
        </View>
        <HeaderLink title="问 Claude" tone="orange" onPress={askClaude} testID="ask-claude" />
      </View>
      <View style={s.segment} accessibilityRole="tablist">
        {(['outline', 'map'] as View_[]).map((v) => (
          <Pressable key={v} onPress={() => setView(v)} style={[s.segBtn, view === v && s.segBtnOn]} accessibilityRole="tab" accessibilityState={{ selected: view === v }} aria-selected={view === v} testID={`view-${v}`}>
            <Text style={[s.segText, view === v && s.segTextOn]}>{v === 'outline' ? '列表' : '导图'}</Text>
          </Pressable>
        ))}
      </View>
      {lp?.offline ? <Text style={s.offline}>离线 · 显示的是上次同步的内容</Text> : null}
      <View style={{ flex: 1 }}>
        {!lp || (lp.loading && !lp.project) ? (
          <Loading />
        ) : lp.error && !lp.project ? (
          <View style={{ paddingHorizontal: PAGE_PAD }}>
            <Empty text={lp.error} />
          </View>
        ) : view === 'outline' ? (
          <OutlineList
            store={lp.store}
            derived={lp.derived}
            pendingNodeIds={pendingIds}
            rev={lp.rev}
            onSelect={open}
            onDone={(nid) => markDone(lp.id, nid)}
            footer={<Text style={s.hint}>左滑标记完成 · 点右上角「问 Claude」拆任务</Text>}
          />
        ) : (
          <MindMap store={lp.store} derived={lp.derived} contacts={lp.contacts} pendingNodeIds={pendingIds} criticalIds={criticalIds} rev={lp.rev} onSelect={open} />
        )}
      </View>
      {lp?.project ? (
        <Pressable onPress={add} style={({ pressed }) => [s.fab, pressed && { backgroundColor: C.orangeDeep }]} accessibilityRole="button" accessibilityLabel="新建节点" testID="add-node">
          <PlusIcon />
        </Pressable>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: PAGE_PAD },
  title: { fontSize: FONT.h2, fontWeight: '700', color: C.ink },
  meta: { fontSize: FONT.small, color: C.ink2 },
  segment: { flexDirection: 'row', marginHorizontal: PAGE_PAD, marginTop: 16, marginBottom: 16, height: 40, borderWidth: 1, borderColor: C.line, borderRadius: RADIUS, overflow: 'hidden' },
  segBtn: { flexGrow: 1, flexBasis: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: C.paper },
  segBtnOn: { backgroundColor: C.orangeSoft },
  segText: { fontSize: FONT.body, color: C.ink2 },
  segTextOn: { color: C.orangeDeep, fontWeight: '500' },
  offline: { fontSize: FONT.small, color: C.orangeDeep, paddingHorizontal: PAGE_PAD, paddingBottom: 8 },
  hint: { paddingHorizontal: PAGE_PAD, paddingTop: 16, paddingBottom: 96, fontSize: FONT.small, color: C.ink3 },
  fab: {
    position: 'absolute',
    right: PAGE_PAD,
    bottom: PAGE_PAD,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: C.orange,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: C.orange,
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
});
