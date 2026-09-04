import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { NODE_STATUSES, isWaitingOnDependency } from '@tsai-mind/core';
import type { Contact, Derived, NodeStatus, TNode } from '@tsai-mind/core';
import { C, FONT, MONO, STATUS_COLOR } from '../../src/theme';
import { Avatar, Banner, Btn, Empty, Loading, StatusDot, StatusPill } from '../../src/components/ui';
import { PendingCard } from '../../src/components/PendingCard';
import { DateField } from '../../src/components/DateField';
import { findProjectOfNode, useProjects } from '../../src/state/project';
import { usePending } from '../../src/state/pending';
import { api } from '../../src/api/client';
import { activityActor, type Activity } from '../../src/api/types';
import { projectOfNode } from '../../src/sync/runtime';
import { FIELD_LABEL, STATUS_LABEL, contactName, daysAgo, fmtDate, relTime, today } from '../../src/lib/util';
import { shareText } from '../../src/lib/share';

export default function NodeScreen() {
  const { id: nodeId } = useLocalSearchParams<{ id: string }>();
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
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [activity, setActivity] = useState<Activity[]>([]);
  useEffect(() => {
    if (!nodeId || !projectId) return;
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
  }, [nodeId, projectId, node?.version, node?.lastNudgedAt]);

  if (resolveErr) return <Empty text={resolveErr} />;
  if (!lp || !projectId || (lp.loading && !lp.project)) return <Loading />;
  if (lp.error && !lp.project) return <Empty text={lp.error} />;
  if (!node) return <Empty text="这个节点已被删除。" />;

  const hasKids = !!d?.hasChildren;
  const progAuto = node.progressMode === 'auto';
  const datesAuto = node.dateMode === 'auto';
  const showStart = hasKids && datesAuto ? d!.startDate : node.startDate;
  const showDue = hasKids && datesAuto ? d!.dueDate : node.dueDate;
  const progress = d?.progress ?? node.progress;
  const t = today();
  const overdue = !!showDue && showDue < t && (d?.status ?? node.status) !== 'done';
  const nodePending = lp.pending.filter((c) => c.nodeId === node.id);
  const nudgedDays = daysAgo(node.lastNudgedAt);
  const path = lp.store.path(node.id);

  // dependencies (project-level edges), waiting state and slips from core
  const deps = lp.dependencies;
  const predecessors = deps.filter((x) => x.toNode === node.id).map((x) => lp.store.live(x.fromNode)).filter((n): n is TNode => !!n);
  const successors = deps.filter((x) => x.fromNode === node.id).map((x) => lp.store.live(x.toNode)).filter((n): n is TNode => !!n);
  const waiting = (d?.status ?? node.status) !== 'done' && isWaitingOnDependency(node.id, lp.store, lp.derived, deps);
  const slipIn = lp.slips.filter((x) => x.toNode === node.id);
  const slipOut = lp.slips.filter((x) => x.fromNode === node.id);
  const titleOf = (id: string) => lp.store.get(id)?.title ?? '…';
  const askClaude = () => router.push(`/chat/new?projectId=${encodeURIComponent(projectId)}&prefill=${encodeURIComponent(`关于「${node.title}」：`)}`);

  const commitTitle = () => {
    if (title.trim() !== node.title) updateNode(projectId, node.id, { title: title.trim() });
  };
  const doNudge = async () => {
    const text = await nudge(projectId, node.id);
    if (text) await shareText(text);
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.paper }} contentContainerStyle={{ paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: lp.project?.name ?? '' }} />
      {lp.offline && <Banner text="离线 · 修改会在联网后发送" tone="warn" />}
      <View style={s.pad}>
        <Text style={s.crumb} numberOfLines={1}>
          {path.length ? path.join(' / ') : '根节点'}
        </Text>
        <TextInput
          value={title}
          onChangeText={setTitle}
          onBlur={commitTitle}
          onSubmitEditing={commitTitle}
          returnKeyType="done"
          placeholder="标题"
          placeholderTextColor={C.ink3}
          style={s.title}
          testID="node-title"
        />
      </View>

      <Pressable onPress={() => setOwnerOpen(true)} style={s.row} testID="owner-row">
        <Text style={s.rowLabel}>负责人</Text>
        <View style={{ flex: 1 }} />
        <Avatar name={node.ownerId ? contactName(lp.contacts, node.ownerId) : null} me={!node.ownerId} size={22} />
        <Text style={s.rowValue}>{contactName(lp.contacts, node.ownerId)}</Text>
        <Text style={s.chev}>›</Text>
      </Pressable>

      <View style={[s.pad, { paddingTop: 16 }]}>
        <View style={s.h4row}>
          <Text style={s.h4}>状态</Text>
          {hasKids && <Text style={s.note}>由子节点推导</Text>}
        </View>
        <View style={s.pills}>
          {NODE_STATUSES.map((st: NodeStatus) => (
            <StatusPill key={st} status={st} active={(hasKids ? d!.status : node.status) === st} onPress={hasKids ? undefined : () => updateNode(projectId, node.id, { status: st })} />
          ))}
        </View>
      </View>

      <View style={[s.pad, { paddingTop: 16 }]}>
        <View style={s.h4row}>
          <Text style={s.h4}>进度</Text>
          <Text style={s.mono}>{progress}%</Text>
          <View style={{ flex: 1 }} />
          {hasKids && (
            <Pressable onPress={() => updateNode(projectId, node.id, progAuto ? { progressMode: 'manual', progress: d!.progress } : { progressMode: 'auto' })} hitSlop={8}>
              <Text style={s.link}>{progAuto ? '改为手动' : '改回自动'}</Text>
            </Pressable>
          )}
        </View>
        <Slider
          value={progress}
          minimumValue={0}
          maximumValue={100}
          step={5}
          disabled={hasKids && progAuto}
          minimumTrackTintColor={hasKids && progAuto ? C.ink3 : C.orange}
          maximumTrackTintColor={C.line}
          thumbTintColor={hasKids && progAuto ? C.ink3 : C.orange}
          onSlidingComplete={(v) => updateNode(projectId, node.id, { progress: Math.round(v) })}
          style={{ width: '100%', height: 36 }}
          accessibilityLabel="进度"
        />
        {hasKids && <Text style={s.note}>{progAuto ? '按子节点工时加权汇总，不能直接拖；要手动填写请先「改为手动」。' : '手动填写，不再跟随子节点。'}</Text>}
      </View>

      <View style={[s.pad, { paddingTop: 16 }]}>
        <View style={s.h4row}>
          <Text style={s.h4}>日期</Text>
          <View style={{ flex: 1 }} />
          {hasKids && (
            <Pressable
              onPress={() => updateNode(projectId, node.id, datesAuto ? { dateMode: 'manual', startDate: d!.startDate, dueDate: d!.dueDate } : { dateMode: 'auto' })}
              hitSlop={8}
            >
              <Text style={s.link}>{datesAuto ? '锁定日期' : '跟随子节点'}</Text>
            </Pressable>
          )}
        </View>
        <DateField label="开始日" value={showStart} disabled={hasKids && datesAuto} note={hasKids && datesAuto ? '由子节点推导' : undefined} onChange={(v) => updateNode(projectId, node.id, { startDate: v })} />
        <DateField
          label="截止日"
          value={showDue}
          disabled={hasKids && datesAuto}
          overdue={overdue}
          note={hasKids && datesAuto ? '由子节点推导' : undefined}
          onChange={(v) => updateNode(projectId, node.id, { dueDate: v })}
        />
      </View>

      {(predecessors.length > 0 || successors.length > 0 || slipIn.length > 0) && (
        <View style={{ paddingTop: 20 }}>
          <Text style={[s.h4, s.pad]}>依赖</Text>
          {waiting && (
            <Text style={[s.pad, s.waiting]} testID="dep-waiting">
              等待中：前置任务未完成
            </Text>
          )}
          {slipIn.map((x) => (
            <Text key={`in-${x.fromNode}`} style={[s.pad, s.slip]} testID={`dep-slip-${x.fromNode}`}>
              延误 {x.days} 天 · 「{titleOf(x.fromNode)}」截止 {fmtDate(x.fromDue)}，晚于本任务开始 {fmtDate(x.toStart)}
            </Text>
          ))}
          {slipOut.map((x) => (
            <Text key={`out-${x.toNode}`} style={[s.pad, s.slip]}>
              拖累「{titleOf(x.toNode)}」延误 {x.days} 天
            </Text>
          ))}
          {predecessors.length > 0 && (
            <>
              <Text style={[s.pad, s.depHead]}>前置任务</Text>
              {predecessors.map((n) => (
                <DepRow key={n.id} node={n} lp={lp} onPress={() => router.push(`/node/${n.id}`)} />
              ))}
            </>
          )}
          {successors.length > 0 && (
            <>
              <Text style={[s.pad, s.depHead]}>后续任务</Text>
              {successors.map((n) => (
                <DepRow key={n.id} node={n} lp={lp} onPress={() => router.push(`/node/${n.id}`)} />
              ))}
            </>
          )}
        </View>
      )}

      <View style={[s.pad, { paddingTop: 20, flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
        <Btn title="催办" onPress={() => void doNudge()} disabled={!node.ownerId} testID="nudge-btn" />
        <Text style={s.note}>{!node.ownerId ? '负责人是你自己，不用催' : nudgedDays === null ? '还没催过' : nudgedDays === 0 ? '今天催过' : `上次催办 ${nudgedDays} 天前`}</Text>
        <View style={{ flex: 1 }} />
        <Btn title="问 Claude" onPress={askClaude} testID="ask-claude-node" />
      </View>

      {nodePending.length > 0 && (
        <View style={{ paddingTop: 20 }}>
          <Text style={[s.h4, s.pad]}>待确认 {nodePending.length}</Text>
          <View style={{ height: 8 }} />
          {nodePending.map((c) => (
            <PendingCard key={c.id} change={c} title={node.title} contacts={lp.contacts} onApprove={() => void decide([c.id], 'approve')} onReject={() => void decide([c.id], 'reject')} />
          ))}
        </View>
      )}

      <View style={[s.pad, { paddingTop: 20 }]}>
        <Text style={s.h4}>最近活动</Text>
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
          <Text style={s.note}>暂无活动记录</Text>
        )}
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
              >
                <Avatar name={c.id ? c.name : null} me={!c.id} size={24} />
                <Text style={[s.sheetText, node.ownerId === c.id && { color: C.orangeDeep, fontWeight: '600' }]}>{c.name}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

function DepRow({ node: n, lp, onPress }: { node: TNode; lp: { derived: Map<string, Derived>; contacts: Contact[] }; onPress: () => void }) {
  const d = lp.derived.get(n.id);
  const status = d?.status ?? n.status;
  const due = d?.dueDate ?? n.dueDate;
  const overdue = !!due && due < today() && status !== 'done';
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.depRow, pressed && { backgroundColor: C.paper2 }]} testID={`dep-${n.id}`}>
      <StatusDot status={status} />
      <Text style={[s.depTitle, status === 'done' && { color: C.ink3 }]} numberOfLines={1}>
        {n.title || '（无标题）'}
      </Text>
      {n.ownerId ? <Text style={s.note}>{contactName(lp.contacts, n.ownerId)}</Text> : null}
      {due ? <Text style={[s.mono, { color: overdue ? C.red : C.ink2, fontSize: FONT.tiny }]}>{fmtDate(due)}</Text> : null}
      <Text style={s.chev}>›</Text>
    </Pressable>
  );
}

function fieldChange(k: string, v: unknown): string {
  const label = FIELD_LABEL[k] ?? k;
  if (k === 'status') return `${label} → ${STATUS_LABEL[v as NodeStatus] ?? String(v)}`;
  if (k === 'progress') return `${label} → ${String(v)}%`;
  if (k === 'title') return `改标题为「${String(v)}」`;
  if (k === 'description') return '改了描述';
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
  pad: { paddingHorizontal: 16 },
  crumb: { fontSize: FONT.tiny, color: C.ink3, paddingTop: 10 },
  title: { fontSize: 22, fontWeight: '700', color: C.ink, paddingVertical: 8, borderBottomWidth: 1, borderColor: C.line },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderColor: C.line },
  rowLabel: { fontSize: FONT.body, color: C.ink },
  rowValue: { fontSize: FONT.body, color: C.ink2 },
  chev: { fontSize: 20, color: C.ink3, marginLeft: 4 },
  h4row: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 8 },
  h4: { fontSize: FONT.small, fontWeight: '600', color: C.ink2 },
  note: { fontSize: FONT.tiny, color: C.ink3, flexShrink: 1 },
  link: { fontSize: FONT.tiny, color: C.orangeDeep },
  mono: { fontFamily: MONO, fontSize: FONT.small, color: C.ink },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  act: { flexDirection: 'row', gap: 10, paddingVertical: 7, borderBottomWidth: 1, borderColor: C.line },
  actTime: { fontFamily: MONO, fontSize: FONT.tiny, color: C.ink3, minWidth: 64 },
  actText: { flex: 1, fontSize: FONT.small, color: C.ink },
  via: { fontSize: FONT.tiny, color: C.orangeDeep },
  waiting: { fontSize: FONT.small, color: STATUS_COLOR.waiting, marginTop: 2, marginBottom: 4 },
  slip: { fontSize: FONT.small, color: C.red, marginTop: 2, marginBottom: 4, lineHeight: 19 },
  depHead: { fontSize: FONT.tiny, color: C.ink3, marginTop: 8, marginBottom: 2 },
  depRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderColor: C.line },
  depTitle: { flex: 1, fontSize: FONT.body, color: C.ink },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: C.paper, borderTopLeftRadius: 14, borderTopRightRadius: 14, paddingBottom: 32, paddingTop: 8 },
  sheetTitle: { fontSize: FONT.small, color: C.ink2, paddingHorizontal: 16, paddingVertical: 10 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderColor: C.line },
  sheetText: { fontSize: FONT.body, color: C.ink },
});
