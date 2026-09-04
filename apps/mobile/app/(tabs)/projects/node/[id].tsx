import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { isWaitingOnDependency } from '@tsai-mind/core';
import type { Derived, NodeStatus, TNode } from '@tsai-mind/core';
import { C, FONT, MONO, PAGE_PAD, STATUS_COLOR } from '../../../../src/theme';
import { useInsets } from '../../../../src/components/layout';
import { BackChevron, Btn, Chevron, Empty, Loading, MoreRow, StatusDot, StatusPill } from '../../../../src/components/ui';
import { PendingCard } from '../../../../src/components/PendingCard';
import { DateField } from '../../../../src/components/DateField';
import { ProgressSlider } from '../../../../src/components/ProgressSlider';
import { findProjectOfNode, useProjects } from '../../../../src/state/project';
import { usePending } from '../../../../src/state/pending';
import { api } from '../../../../src/api/client';
import { activityActor, type Activity } from '../../../../src/api/types';
import { projectOfNode } from '../../../../src/sync/runtime';
import { FIELD_LABEL, STATUS_LABEL, contactName, daysAgo, daysBetween, fmtDate, relTime, today } from '../../../../src/lib/util';
import { shareText } from '../../../../src/lib/share';

/** The four statuses on the pill row; 等待中 lives under 更多. */
const PILLS: NodeStatus[] = ['todo', 'in_progress', 'blocked', 'done'];
const PRIORITIES: { v: 1 | 2 | 3 | 4; label: string }[] = [
  { v: 1, label: '最高' },
  { v: 2, label: '高' },
  { v: 3, label: '普通' },
  { v: 4, label: '低' },
];

/**
 * 节点详情 (design/mobile-v2/Node.dc.html): path, editable title, four status pills, a card with
 * 截止 / 负责人 / 进度, the node's pending card, 催办, and「更多」for everything else.
 */
export default function NodeScreen() {
  const { id: nodeId, focus } = useLocalSearchParams<{ id: string; focus?: string }>();
  const { top } = useInsets();
  const router = useRouter();
  const [projectId, setProjectId] = useState<string | null>(() => (nodeId ? (findProjectOfNode(nodeId)?.id ?? null) : null));
  const [resolveErr, setResolveErr] = useState<string | null>(null);
  const lp = useProjects((s) => (projectId ? s.projects[projectId] : undefined));
  const load = useProjects((s) => s.load);
  const updateNode = useProjects((s) => s.updateNode);
  const nudge = useProjects((s) => s.nudge);
  const decide = usePending((s) => s.decide);

  // resolve node → project (memory → local index → server)
  useEffect(() => {
    if (!nodeId || projectId) return;
    let cancelled = false;
    (async () => {
      const local = await projectOfNode(nodeId);
      if (local) {
        if (!cancelled) setProjectId(local);
        return;
      }
      try {
        const d = await api.nodeDetail(nodeId);
        if (!cancelled) setProjectId(d.projectId);
      } catch (e) {
        if (!cancelled) setResolveErr((e as Error).message || '找不到这个节点');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodeId, projectId]);

  useEffect(() => {
    if (projectId) void load(projectId);
  }, [projectId, load]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const node = useMemo(() => (lp && nodeId ? lp.store.live(nodeId) : undefined), [lp, lp?.rev, nodeId]);
  const d = node ? lp?.derived.get(node.id) : undefined;

  const [title, setTitle] = useState('');
  useEffect(() => setTitle(node?.title ?? ''), [node?.id, node?.title]);
  const [desc, setDesc] = useState('');
  useEffect(() => setDesc(node?.description ?? ''), [node?.id, node?.description]);
  const [hours, setHours] = useState('');
  useEffect(() => setHours(node?.estimateHours == null ? '' : String(node.estimateHours)), [node?.id, node?.estimateHours]);
  const [tags, setTags] = useState('');
  useEffect(() => setTags((node?.tags ?? []).join(', ')), [node?.id, node?.tags]);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [activity, setActivity] = useState<Activity[]>([]);
  useEffect(() => {
    if (!nodeId || !projectId || !more) return;
    let cancelled = false;
    api
      .nodeDetail(nodeId)
      .then((r) => {
        if (!cancelled) setActivity([...r.activity].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 10));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [nodeId, projectId, more, node?.version, node?.lastNudgedAt]);

  const back = () => (router.canGoBack() ? router.back() : router.replace(projectId ? `/projects/${projectId}` : '/projects'));

  if (resolveErr) return <Empty text={resolveErr} />;
  if (!lp || !projectId || (lp.loading && !lp.project)) return <Loading />;
  if (lp.error && !lp.project) return <Empty text={lp.error} />;
  if (!node) return <Empty text="这个节点已被删除。" />;

  const hasKids = !!d?.hasChildren;
  const progAuto = node.progressMode === 'auto';
  const datesAuto = node.dateMode === 'auto';
  const derivedDates = hasKids && datesAuto;
  const showStart = derivedDates ? d!.startDate : node.startDate;
  const showDue = derivedDates ? d!.dueDate : node.dueDate;
  const progress = d?.progress ?? node.progress;
  const status = hasKids ? d!.status : node.status;
  const t = today();
  const overdue = !!showDue && showDue < t && status !== 'done';
  const overdueDays = overdue && showDue ? daysBetween(showDue, t) : 0;
  const nodePending = lp.pending.filter((c) => c.nodeId === node.id);
  const nudgedDays = daysAgo(node.lastNudgedAt);
  const path = lp.store.path(node.id);
  const owner = contactName(lp.contacts, node.ownerId);

  const deps = lp.dependencies;
  const predecessors = deps.filter((x) => x.toNode === node.id).map((x) => lp.store.live(x.fromNode)).filter((n): n is TNode => !!n);
  const successors = deps.filter((x) => x.fromNode === node.id).map((x) => lp.store.live(x.toNode)).filter((n): n is TNode => !!n);
  const waiting = status !== 'done' && isWaitingOnDependency(node.id, lp.store, lp.derived, deps);
  const slipIn = lp.slips.filter((x) => x.toNode === node.id);
  const slipOut = lp.slips.filter((x) => x.fromNode === node.id);
  const titleOf = (id: string) => lp.store.get(id)?.title ?? '…';
  const hasDeps = predecessors.length > 0 || successors.length > 0 || slipIn.length > 0 || slipOut.length > 0;
  const askClaude = () => router.push(`/claude?projectId=${encodeURIComponent(projectId)}&prefill=${encodeURIComponent(`关于「${node.title}」：`)}&t=${Date.now()}`);

  const commitTitle = () => {
    if (title.trim() !== node.title) updateNode(projectId, node.id, { title: title.trim() });
  };
  const commitDesc = () => {
    if (desc !== (node.description ?? '')) updateNode(projectId, node.id, { description: desc });
  };
  const commitHours = () => {
    const v = hours.trim() === '' ? null : Number(hours);
    if (v !== null && !Number.isFinite(v)) return;
    if (v !== node.estimateHours) updateNode(projectId, node.id, { estimateHours: v });
  };
  const commitTags = () => {
    const list = tags
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (list.join(',') !== node.tags.join(',')) updateNode(projectId, node.id, { tags: list });
  };
  const doNudge = async () => {
    const text = await nudge(projectId, node.id);
    if (text) await shareText(text);
  };
  const nudgeNote = !node.ownerId ? '负责人是你自己，不用催' : nudgedDays === null ? '还没催过' : nudgedDays === 0 ? '今天催过' : `${nudgedDays} 天前催过`;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.paper }} contentContainerStyle={{ paddingTop: top + 9, paddingHorizontal: PAGE_PAD, paddingBottom: 48, gap: 20 }} keyboardShouldPersistTaps="handled">
      <View style={s.crumbRow}>
        <BackChevron onPress={back} testID="node-back" />
        <Text style={s.crumb} numberOfLines={1}>
          {path.length ? path.join(' / ') : (lp.project?.name ?? '')}
        </Text>
      </View>
      {lp.offline ? <Text style={s.offline}>离线 · 修改会在联网后发送</Text> : null}
      <TextInput
        value={title}
        onChangeText={setTitle}
        onBlur={commitTitle}
        onSubmitEditing={commitTitle}
        returnKeyType="done"
        placeholder="标题"
        placeholderTextColor={C.ink3}
        autoFocus={focus === '1'}
        style={s.title}
        testID="node-title"
      />

      <View style={{ gap: 8 }}>
        <View style={s.pills}>
          {PILLS.map((st) => (
            <StatusPill key={st} status={st} active={status === st} disabled={hasKids} onPress={hasKids ? undefined : () => updateNode(projectId, node.id, { status: st })} />
          ))}
        </View>
        {hasKids ? <Text style={s.note}>状态由子节点推导</Text> : status === 'waiting' ? <Text style={[s.note, { color: STATUS_COLOR.waiting }]}>等待中 · 在「更多」里改</Text> : null}
      </View>

      <View style={s.card}>
        <DateField
          label="截止"
          value={showDue}
          disabled={derivedDates}
          note={derivedDates ? '由子节点推导' : undefined}
          overdue={overdue}
          overdueDays={overdueDays}
          onChange={(v) => updateNode(projectId, node.id, { dueDate: v })}
          testID="due-row"
        />
        <Pressable onPress={() => setOwnerOpen(true)} style={({ pressed }) => [s.cardRow, pressed && { backgroundColor: C.paper2 }]} testID="owner-row">
          <Text style={s.rowLabel}>负责人</Text>
          <Text style={s.rowValue} numberOfLines={1}>
            {owner}
          </Text>
          <Chevron />
        </Pressable>
        <View style={s.progressBlock}>
          <View style={s.progressHead}>
            <Text style={s.rowLabel16}>进度</Text>
            <Text style={s.pct} testID="progress-value">
              {progress}%
            </Text>
          </View>
          <ProgressSlider value={progress} disabled={hasKids && progAuto} onCommit={(v) => updateNode(projectId, node.id, { progress: v })} />
          {hasKids ? (
            <Text style={s.note}>
              {progAuto ? '按子节点工时加权汇总，不能直接拖。' : '手动填写，不再跟随子节点。'}{' '}
              <Text style={s.link} onPress={() => updateNode(projectId, node.id, progAuto ? { progressMode: 'manual', progress: d!.progress } : { progressMode: 'auto' })}>
                {progAuto ? '改为手动' : '改回自动'}
              </Text>
            </Text>
          ) : null}
        </View>
      </View>

      {nodePending.map((c) => (
        <PendingCard key={c.id} change={c} title={node.title || '（无标题）'} contacts={lp.contacts} onApprove={() => void decide([c.id], 'approve')} onReject={() => void decide([c.id], 'reject')} />
      ))}

      <View style={{ gap: 6 }}>
        <Btn title="催办" height={48} onPress={() => void doNudge()} disabled={!node.ownerId} testID="nudge-btn" />
        <Text style={s.nudgeNote} testID="nudge-note">
          {nudgeNote}
        </Text>
      </View>

      <View>
        <MoreRow tall top text="更多：开始日、工时、依赖、说明、记录" expanded={more} onPress={() => setMore((v) => !v)} testID="more-toggle" />
        {more ? (
          <View style={{ gap: 20, paddingTop: 8 }} testID="more-body">
            <View style={s.card}>
              <DateField
                label="开始日"
                value={showStart}
                disabled={derivedDates}
                note={derivedDates ? '由子节点推导' : undefined}
                onChange={(v) => updateNode(projectId, node.id, { startDate: v })}
                testID="start-row"
              />
              <View style={s.cardRow}>
                <Text style={s.rowLabel}>工时</Text>
                <TextInput value={hours} onChangeText={setHours} onBlur={commitHours} keyboardType="numeric" placeholder="未设" placeholderTextColor={C.ink3} style={s.rowInput} testID="estimate-input" />
                <Text style={s.unit}>小时</Text>
              </View>
              <View style={s.cardRow}>
                <Text style={s.rowLabel}>优先级</Text>
                <View style={{ flexDirection: 'row', gap: 6, flexGrow: 1, justifyContent: 'flex-end' }}>
                  {PRIORITIES.map((p) => (
                    <Pressable key={p.v} onPress={() => updateNode(projectId, node.id, { priority: p.v })} style={[s.prio, node.priority === p.v && s.prioOn]} accessibilityRole="button" accessibilityState={{ selected: node.priority === p.v }}>
                      <Text style={[s.prioText, node.priority === p.v && { color: C.orangeDeep, fontWeight: '500' }]}>{p.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
              <View style={[s.cardRow, { borderBottomWidth: 0 }]}>
                <Text style={s.rowLabel}>标签</Text>
                <TextInput value={tags} onChangeText={setTags} onBlur={commitTags} placeholder="用逗号分隔" placeholderTextColor={C.ink3} style={s.rowInput} testID="tags-input" />
              </View>
            </View>
            {hasKids ? (
              <Text style={s.note}>
                {datesAuto ? '日期由子节点推导。' : '日期已锁定，不再跟随子节点。'}{' '}
                <Text style={s.link} onPress={() => updateNode(projectId, node.id, datesAuto ? { dateMode: 'manual', startDate: d!.startDate, dueDate: d!.dueDate } : { dateMode: 'auto' })}>
                  {datesAuto ? '锁定日期' : '跟随子节点'}
                </Text>
              </Text>
            ) : null}

            {!hasKids ? (
              <View style={{ gap: 8 }}>
                <Text style={s.h4}>其他状态</Text>
                <View style={{ flexDirection: 'row' }}>
                  <StatusPill status="waiting" active={status === 'waiting'} grow={false} onPress={() => updateNode(projectId, node.id, { status: status === 'waiting' ? 'todo' : 'waiting' })} />
                </View>
              </View>
            ) : null}

            <View style={{ gap: 8 }}>
              <Text style={s.h4}>说明</Text>
              <TextInput value={desc} onChangeText={setDesc} onBlur={commitDesc} multiline placeholder="写点说明" placeholderTextColor={C.ink3} style={s.desc} testID="desc-input" />
            </View>

            {hasDeps ? (
              <View style={{ gap: 6 }}>
                <Text style={s.h4}>依赖</Text>
                {waiting ? (
                  <Text style={s.waiting} testID="dep-waiting">
                    等待中：前置任务未完成
                  </Text>
                ) : null}
                {slipIn.map((x) => (
                  <Text key={`in-${x.fromNode}`} style={s.slip} testID={`dep-slip-${x.fromNode}`}>
                    延误 {x.days} 天 · 「{titleOf(x.fromNode)}」截止 {fmtDate(x.fromDue)}，晚于本任务开始 {fmtDate(x.toStart)}
                  </Text>
                ))}
                {slipOut.map((x) => (
                  <Text key={`out-${x.toNode}`} style={s.slip}>
                    拖累「{titleOf(x.toNode)}」延误 {x.days} 天
                  </Text>
                ))}
                {predecessors.length > 0 ? (
                  <>
                    <Text style={s.depHead}>前置任务</Text>
                    {predecessors.map((n) => (
                      <DepRow key={n.id} node={n} derived={lp.derived} onPress={() => router.push(`/projects/node/${n.id}`)} />
                    ))}
                  </>
                ) : null}
                {successors.length > 0 ? (
                  <>
                    <Text style={s.depHead}>后续任务</Text>
                    {successors.map((n) => (
                      <DepRow key={n.id} node={n} derived={lp.derived} onPress={() => router.push(`/projects/node/${n.id}`)} />
                    ))}
                  </>
                ) : null}
              </View>
            ) : null}

            <View style={{ gap: 4 }}>
              <Text style={s.h4}>记录</Text>
              {activity.length ? (
                activity.map((a) => (
                  <View key={String(a.id)} style={s.act}>
                    <Text style={s.actTime}>{relTime(a.createdAt)}</Text>
                    <Text style={s.actText}>
                      {describeActivity(a)}
                      {activityActor(a) === 'claude' ? <Text style={s.via}> 经 Claude</Text> : null}
                    </Text>
                  </View>
                ))
              ) : (
                <Text style={s.note}>暂无记录</Text>
              )}
            </View>

            <Btn title="问 Claude" height={48} onPress={askClaude} testID="ask-claude-node" />
          </View>
        ) : null}
      </View>

      <Modal visible={ownerOpen} transparent animationType="fade" onRequestClose={() => setOwnerOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setOwnerOpen(false)}>
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>负责人</Text>
            {[{ id: null as string | null, name: '我' }, ...lp.contacts.filter((c) => !c.archivedAt || c.id === node.ownerId)].map((c) => (
              <Pressable
                key={c.id ?? 'me'}
                onPress={() => {
                  updateNode(projectId, node.id, { ownerId: c.id });
                  setOwnerOpen(false);
                }}
                style={s.sheetRow}
                testID={`owner-${c.id ?? 'me'}`}
              >
                <Text style={[s.sheetText, node.ownerId === c.id && { color: C.orangeDeep, fontWeight: '500' }]}>{c.name}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

function DepRow({ node: n, derived, onPress }: { node: TNode; derived: Map<string, Derived>; onPress: () => void }) {
  const d = derived.get(n.id);
  const status = d?.status ?? n.status;
  const due = d?.dueDate ?? n.dueDate;
  const overdue = !!due && due < today() && status !== 'done';
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.depRow, pressed && { backgroundColor: C.paper2 }]} testID={`dep-${n.id}`}>
      <StatusDot status={status} />
      <Text style={[s.depTitle, status === 'done' && { color: C.ink3 }]} numberOfLines={1}>
        {n.title || '（无标题）'}
      </Text>
      {due ? <Text style={[s.mono, { color: overdue ? C.red : C.ink2 }]}>{fmtDate(due)}</Text> : null}
      <Chevron />
    </Pressable>
  );
}

function fieldChange(k: string, v: unknown): string {
  const label = FIELD_LABEL[k] ?? k;
  if (k === 'status') return `${label} → ${STATUS_LABEL[v as NodeStatus] ?? String(v)}`;
  if (k === 'progress') return `${label} → ${String(v)}%`;
  if (k === 'title') return `改标题为「${String(v)}」`;
  if (k === 'description') return '改了说明';
  if (k === 'dueDate' || k === 'startDate') return `${label} → ${v ? fmtDate(String(v)) : '空'}`;
  if (k === 'lastNudgedAt') return '催办';
  return `改了${label}`;
}

function describeActivity(a: Activity): string {
  const p = a.payload ?? {};
  switch (a.kind) {
    case 'node_created':
    case 'create_node':
      return '创建了节点';
    case 'deleted':
    case 'delete_node':
      return '删除了节点';
    case 'restored':
    case 'restore_node':
      return '恢复了节点';
    case 'moved':
    case 'move_node':
      return '移动了节点';
    case 'nudged':
    case 'nudge':
      return '催办';
    case 'undone':
      return '撤销了一步操作';
    case 'note_added':
    case 'note':
      return `备注：${String(p.body ?? '')}`;
    case 'change_proposed':
      return `提议改${FIELD_LABEL[String(p.field)] ?? String(p.field)}`;
    case 'change_decided':
      return p.decision === 'approve' || p.decision === 'approved' ? '确认了变更' : p.decision ? '拒绝了变更' : '处理了变更';
    case 'batch_applied':
      return '应用了草案';
    case 'field_changed':
    case 'update_node':
    case 'update': {
      const fields = p.fields as Record<string, { from: unknown; to: unknown }> | undefined;
      if (fields) return Object.entries(fields).map(([k, v]) => fieldChange(k, v?.to)).join('，');
      const patch = (p.patch ?? p) as Record<string, unknown>;
      const keys = Object.keys(patch).filter((k) => k in FIELD_LABEL);
      return keys.length ? keys.map((k) => fieldChange(k, patch[k])).join('，') : '更新了节点';
    }
    default:
      return typeof p.message === 'string' ? p.message : a.kind;
  }
}

const s = StyleSheet.create({
  crumbRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  crumb: { fontSize: FONT.small, color: C.ink2, flexShrink: 1 },
  offline: { fontSize: FONT.small, color: C.orangeDeep },
  title: { fontSize: FONT.h1, fontWeight: '700', color: C.ink, lineHeight: 33, padding: 0 },
  pills: { flexDirection: 'row', gap: 8 },
  note: { fontSize: FONT.small, color: C.ink3, lineHeight: 18 },
  link: { color: C.orangeDeep },
  card: { borderWidth: 1, borderColor: C.line, borderRadius: 12 },
  cardRow: { flexDirection: 'row', alignItems: 'center', height: 52, paddingHorizontal: 16, borderBottomWidth: 1, borderColor: C.line },
  rowLabel: { fontSize: FONT.input, color: C.ink, width: 80 },
  rowLabel16: { fontSize: FONT.input, color: C.ink },
  rowValue: { flexGrow: 1, flexShrink: 1, fontSize: FONT.input, color: C.ink },
  rowInput: { flexGrow: 1, flexShrink: 1, fontSize: FONT.input, color: C.ink, padding: 0, height: 52 },
  unit: { fontSize: FONT.small, color: C.ink3 },
  progressBlock: { paddingTop: 12, paddingHorizontal: 16, paddingBottom: 14, gap: 8 },
  progressHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  pct: { fontFamily: MONO, fontSize: FONT.input, color: C.ink },
  nudgeNote: { fontSize: FONT.small, color: C.ink3, textAlign: 'center' },
  h4: { fontSize: FONT.small, color: C.ink2 },
  prio: { height: 30, paddingHorizontal: 10, borderRadius: 15, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  prioOn: { borderColor: C.orange, backgroundColor: C.orangeSoft },
  prioText: { fontSize: FONT.small, color: C.ink2 },
  desc: { minHeight: 88, borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 12, fontSize: FONT.input, lineHeight: 22, color: C.ink, textAlignVertical: 'top' },
  waiting: { fontSize: FONT.small, color: STATUS_COLOR.waiting },
  slip: { fontSize: FONT.small, color: C.red, lineHeight: 19 },
  depHead: { fontSize: FONT.small, color: C.ink3, marginTop: 6 },
  depRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, borderBottomWidth: 1, borderColor: C.line },
  depTitle: { flexGrow: 1, flexShrink: 1, fontSize: FONT.body, color: C.ink },
  mono: { fontFamily: MONO, fontSize: FONT.small },
  act: { flexDirection: 'row', gap: 10, minHeight: 36, alignItems: 'center', borderBottomWidth: 1, borderColor: C.line },
  actTime: { fontFamily: MONO, fontSize: FONT.small, color: C.ink3, minWidth: 64 },
  actText: { flexGrow: 1, flexShrink: 1, fontSize: FONT.meta, color: C.ink },
  via: { fontSize: FONT.small, color: C.orangeDeep },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: C.paper, borderTopLeftRadius: 14, borderTopRightRadius: 14, paddingBottom: 32, paddingTop: 8 },
  sheetTitle: { fontSize: FONT.small, color: C.ink2, paddingHorizontal: PAGE_PAD, paddingVertical: 10 },
  sheetRow: { paddingHorizontal: PAGE_PAD, height: 52, justifyContent: 'center', borderTopWidth: 1, borderColor: C.line },
  sheetText: { fontSize: FONT.input, color: C.ink },
});
