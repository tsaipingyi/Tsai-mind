import { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Path, Rect, Text as SvgText } from 'react-native-svg';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { Contact, Derived, TreeStore } from '@tsai-mind/core';
import { C, STATUS_COLOR } from '../theme';
import { computeLayout, connectorPath, truncate, type LayoutNode } from '../map/layout';
import { contactName, fmtRange, initial, today } from '../lib/util';

/**
 * Read-only mind map with the same geometry as the web editor (200×52 boxes,
 * gaps 64/16, subtree centring, cubic connectors). Pan with the nested scroll
 * views, pinch to zoom (or the ± buttons), tap a node to open it.
 */
export function MindMap({
  store,
  derived,
  contacts,
  pendingNodeIds,
  criticalIds,
  rev,
  onSelect,
  selectedId,
}: {
  store: TreeStore;
  derived: Map<string, Derived>;
  contacts: Contact[];
  pendingNodeIds: Set<string>;
  /** nodes on the critical path: their connectors are drawn thicker in solid orange */
  criticalIds?: Set<string>;
  rev: number;
  onSelect: (id: string) => void;
  selectedId?: string | null;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [scale, setScale] = useState(0.8);
  const [pinchBase, setPinchBase] = useState(0.8);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => computeLayout(store, collapsed), [store, rev, collapsed]);
  const t = today();

  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onStart(() => setPinchBase(scale))
        .onUpdate((e) => setScale(clamp(pinchBase * e.scale))),
    [scale, pinchBase],
  );

  const toggle = (id: string) => {
    const c = new Set(collapsed);
    if (c.has(id)) c.delete(id);
    else c.add(id);
    setCollapsed(c);
  };

  const W = Math.max(1, layout.width * scale);
  const H = Math.max(1, layout.height * scale);

  return (
    <View style={{ flex: 1 }}>
      <GestureDetector gesture={pinch}>
        <ScrollView horizontal bounces={false} style={{ flex: 1 }} contentContainerStyle={{ minWidth: '100%' }} testID="mindmap-scroll">
          <ScrollView bounces={false} contentContainerStyle={{ minHeight: '100%' }}>
            <Svg width={W} height={H} viewBox={`0 0 ${layout.width} ${layout.height}`}>
              {layout.order.map((id) => {
                const ln = layout.nodes.get(id)!;
                return ln.childIds.map((cid) => {
                  const critical = !!criticalIds && criticalIds.has(id) && criticalIds.has(cid);
                  return (
                    <Path
                      key={`${id}-${cid}`}
                      d={connectorPath(ln, layout.nodes.get(cid)!)}
                      stroke={critical ? C.orange : C.orangeLine}
                      strokeWidth={critical ? 2.5 : 1.5}
                      fill="none"
                      testID={critical ? `critical-edge-${id}-${cid}` : undefined}
                    />
                  );
                });
              })}
              {layout.order.map((id) => {
                const ln = layout.nodes.get(id)!;
                const d = derived.get(id);
                return (
                  <NodeBox
                    key={id}
                    ln={ln}
                    derived={d}
                    contacts={contacts}
                    pending={pendingNodeIds.has(id)}
                    selected={selectedId === id}
                    today={t}
                    onPress={() => onSelect(id)}
                    onToggle={() => toggle(id)}
                  />
                );
              })}
            </Svg>
          </ScrollView>
        </ScrollView>
      </GestureDetector>
      <View style={s.zoom}>
        <Pressable onPress={() => setScale((v) => clamp(v / 1.25))} style={s.zoomBtn} accessibilityLabel="缩小">
          <Text style={s.zoomText}>－</Text>
        </Pressable>
        <Text style={s.zoomPct}>{Math.round(scale * 100)}%</Text>
        <Pressable onPress={() => setScale((v) => clamp(v * 1.25))} style={s.zoomBtn} accessibilityLabel="放大">
          <Text style={s.zoomText}>＋</Text>
        </Pressable>
      </View>
    </View>
  );
}

function clamp(v: number): number {
  return Math.min(2.5, Math.max(0.35, v));
}

function NodeBox({
  ln,
  derived,
  contacts,
  pending,
  selected,
  today,
  onPress,
  onToggle,
}: {
  ln: LayoutNode;
  derived: Derived | undefined;
  contacts: Contact[];
  pending: boolean;
  selected: boolean;
  today: string;
  onPress: () => void;
  onToggle: () => void;
}) {
  const n = ln.node;
  const status = derived?.status ?? n.status;
  const progress = derived?.progress ?? n.progress;
  const due = derived?.dueDate ?? n.dueDate;
  const start = derived?.startDate ?? n.startDate;
  const isRoot = ln.depth === 0;
  const overdue = !!due && due < today && status !== 'done';
  const stroke = status === 'blocked' ? C.red : isRoot || selected ? C.orange : C.orangeLine;
  const strokeWidth = isRoot || selected ? 2 : 1.5;
  const titleSize = isRoot ? 16 : 14;
  const title = truncate(n.title || '（无标题）', titleSize, ln.w - 24 - (n.kind === 'milestone' ? 14 : 0));
  const dateText = fmtRange(start, due);
  const ownerName = n.ownerId ? contactName(contacts, n.ownerId) : null;
  const ringR = 6.5;
  const circ = 2 * Math.PI * ringR;
  const ringX = ln.x + ln.w - 12 - 8;
  const ringY = ln.y + ln.h - 12 - 1;
  return (
    <G opacity={status === 'done' ? 0.45 : 1}>
      <G onPress={onPress} onPressIn={Platform.OS === 'web' ? undefined : onPress}>
        <Rect
          x={ln.x}
          y={ln.y}
          width={ln.w}
          height={ln.h}
          rx={8}
          fill={selected ? C.orangeSoft : C.paper}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeDasharray={n.kind === 'milestone' ? '5 3' : undefined}
        />
        <SvgText x={ln.x + 12} y={ln.y + 22} fontSize={titleSize} fontWeight="700" fill={C.ink}>
          {n.kind === 'milestone' ? `◆ ${title}` : title}
        </SvgText>
        {!isRoot && (
          <>
            <Circle cx={ln.x + 12 + 8} cy={ln.y + ln.h - 13} r={8} fill={n.ownerId ? C.paper2 : C.ink} stroke={n.ownerId ? C.line : 'none'} strokeWidth={1} />
            <SvgText x={ln.x + 12 + 8} y={ln.y + ln.h - 10} fontSize={8} fontWeight="600" fill={n.ownerId ? C.ink2 : '#fff'} textAnchor="middle">
              {ownerName ? initial(ownerName) : '我'}
            </SvgText>
          </>
        )}
        {dateText ? (
          <SvgText x={ln.x + (isRoot ? 12 : 34)} y={ln.y + ln.h - 10} fontSize={11} fontFamily="Menlo, monospace" fill={overdue ? C.red : C.ink2}>
            {dateText}
          </SvgText>
        ) : null}
        {n.kind !== 'note' && (
          <>
            <Circle cx={ringX} cy={ringY} r={ringR} fill="none" stroke={C.line} strokeWidth={2.5} />
            {progress > 0 && (
              <Circle
                cx={ringX}
                cy={ringY}
                r={ringR}
                fill="none"
                stroke={STATUS_COLOR[status]}
                strokeWidth={2.5}
                strokeDasharray={`${(circ * progress) / 100} ${circ}`}
                transform={`rotate(-90 ${ringX} ${ringY})`}
              />
            )}
          </>
        )}
        {pending && <Circle cx={ln.x + ln.w - 4} cy={ln.y + 4} r={4} fill={C.orange} />}
      </G>
      {ln.childCount > 0 && (
        <G onPress={onToggle}>
          <Circle cx={ln.x + ln.w} cy={ln.y + ln.h / 2} r={8} fill={C.paper} stroke={C.orangeLine} strokeWidth={1.5} />
          <SvgText x={ln.x + ln.w} y={ln.y + ln.h / 2 + 3.5} fontSize={10} fontWeight="700" fill={C.ink2} textAnchor="middle">
            {ln.collapsed ? String(ln.childCount) : '−'}
          </SvgText>
        </G>
      )}
    </G>
  );
}

const s = StyleSheet.create({
  zoom: { position: 'absolute', right: 12, bottom: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: C.paper, borderWidth: 1, borderColor: C.line, borderRadius: 8, overflow: 'hidden' },
  zoomBtn: { paddingHorizontal: 12, paddingVertical: 6 },
  zoomText: { fontSize: 16, color: C.ink },
  zoomPct: { fontSize: 12, color: C.ink2, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), minWidth: 40, textAlign: 'center' },
});
