import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Contact } from '@tsai-mind/core';
import type { PlanBatch } from '../api/types';
import { C, FONT, MONO } from '../theme';
import { FIELD_LABEL, valueLabel } from '../lib/util';
import { Btn, Checkbox } from './ui';

export function BatchCard({
  batch,
  projectName,
  contacts,
  titleOf,
  onApply,
  onDiscard,
}: {
  batch: PlanBatch;
  projectName?: string;
  contacts: Contact[];
  titleOf: (id: string) => string;
  onApply: () => Promise<boolean>;
  onDiscard: () => Promise<boolean>;
}) {
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const sm = batch.diff.summary;
  const modeLabel = { append: '只新增', sync: '新增和修改', replace: '完全同步（会删除）' }[batch.mode] ?? batch.mode;
  const updates = batch.diff.ops.filter((o) => o.type === 'update_node');
  const moves = batch.diff.ops.filter((o) => o.type === 'move_node');
  const deletes = batch.diff.ops.filter((o) => o.type === 'delete_node');

  const run = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };

  return (
    <View style={s.card} testID={`batch-${batch.id}`}>
      <Text style={s.title}>
        草案 · {modeLabel} · 放在「{titleOf(batch.parentId)}」下
      </Text>
      {projectName ? <Text style={s.meta}>{projectName}</Text> : null}
      <Text style={s.summary}>
        新增 {sm.create} · 修改 {sm.update} · 移动 {sm.move} · 删除 {sm.delete}
      </Text>
      {batch.diff.errors.length > 0 && (
        <View style={s.block}>
          {batch.diff.errors.map((e, i) => (
            <Text key={i} style={[s.item, { color: C.red }]}>
              第 {e.lineNo} 行：{e.message}
            </Text>
          ))}
        </View>
      )}
      {batch.diff.created.length > 0 && (
        <View style={s.block}>
          <Text style={s.blockTitle}>新增</Text>
          {batch.diff.created.slice(0, 12).map((c) => (
            <Text key={c.id} style={s.item} numberOfLines={1}>
              · {c.title}
            </Text>
          ))}
          {batch.diff.created.length > 12 && <Text style={s.item}>… 共 {batch.diff.created.length} 个</Text>}
        </View>
      )}
      {updates.length > 0 && (
        <View style={s.block}>
          <Text style={s.blockTitle}>修改</Text>
          {updates.map((o) =>
            o.type === 'update_node' ? (
              <Text key={o.opId} style={s.item} numberOfLines={2}>
                · {titleOf(o.nodeId)}：
                {Object.entries(o.patch)
                  .map(([k, v]) => `${FIELD_LABEL[k] ?? k} → ${valueLabel(k, v, contacts)}`)
                  .join('，')}
              </Text>
            ) : null,
          )}
        </View>
      )}
      {moves.length > 0 && (
        <View style={s.block}>
          <Text style={s.blockTitle}>移动</Text>
          {moves.map((o) =>
            o.type === 'move_node' ? (
              <Text key={o.opId} style={s.item} numberOfLines={1}>
                · {titleOf(o.nodeId)} → {titleOf(o.parentId)} 下
              </Text>
            ) : null,
          )}
        </View>
      )}
      {deletes.length > 0 && (
        <View style={s.block}>
          <Text style={[s.blockTitle, { color: C.red }]}>删除</Text>
          {deletes.map((o) => (o.type === 'delete_node' ? <Text key={o.opId} style={[s.item, { color: C.red }]}>· {titleOf(o.nodeId)}</Text> : null))}
          <Checkbox checked={ack} onChange={setAck} label={`我知道这会删除 ${sm.delete} 个节点`} />
        </View>
      )}
      <View style={s.actions}>
        <Btn title="丢弃" small disabled={busy} onPress={() => void run(onDiscard)} />
        <Btn title="应用" small kind="primary" disabled={busy || (sm.delete > 0 && !ack) || batch.diff.errors.length > 0} onPress={() => void run(onApply)} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderWidth: 1, borderColor: C.line, borderRadius: 8, marginHorizontal: 16, marginBottom: 10, padding: 12, gap: 4 },
  title: { fontSize: FONT.body, fontWeight: '600', color: C.ink },
  meta: { fontSize: FONT.tiny, color: C.ink2 },
  summary: { fontSize: FONT.small, color: C.ink2, fontFamily: MONO, marginTop: 2 },
  block: { marginTop: 6, gap: 2 },
  blockTitle: { fontSize: FONT.tiny, color: C.ink3, fontWeight: '600' },
  item: { fontSize: FONT.small, color: C.ink },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
});
