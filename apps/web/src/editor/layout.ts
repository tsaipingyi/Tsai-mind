import type { TNode, TreeStore } from '@tsai-mind/core';

export const NODE_W = 200;
export const ROOT_W = 160;
export const NODE_H = 52;
export const H_GAP = 64;
export const V_GAP = 16;
export const PAD = 40;

export type Side = 'left' | 'right';

export interface LayoutNode {
  id: string;
  node: TNode;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  parentId: string | null;
  childIds: string[];
  /** live child count (even when collapsed) */
  childCount: number;
  collapsed: boolean;
  subtreeH: number;
  /** which side of the root this node grows towards (the root itself is 'right') */
  side: Side;
}

export interface MapLayout {
  nodes: Map<string, LayoutNode>;
  order: string[];
  width: number;
  height: number;
}

/**
 * Balanced map (XMind style): the root sits in the middle and its branches are split between the
 * right and the left side. Branches keep their order — the first ones go right, the rest left — and
 * the split point is chosen so both sides carry about the same number of nodes. The split ignores
 * collapsing so a branch never jumps sides when it is folded.
 */
export function rootSides(store: TreeStore): Map<string, Side> {
  const sides = new Map<string, Side>();
  const root = store.root();
  if (!root) return sides;
  const branches = store.children(root.id);
  const weights = branches.map((b) => 1 + store.descendants(b.id).length);
  const total = weights.reduce((a, b) => a + b, 0);
  let best = branches.length;
  let bestDiff = Infinity;
  let acc = 0;
  for (let k = 0; k <= branches.length; k++) {
    if (k > 0) acc += weights[k - 1]!;
    const diff = Math.abs(acc - (total - acc));
    // ties go to the right side (a single branch stays on the right)
    if (diff <= bestDiff) {
      bestDiff = diff;
      best = k;
    }
  }
  branches.forEach((b, i) => sides.set(b.id, i < best ? 'right' : 'left'));
  return sides;
}

export function computeLayout(store: TreeStore, collapsed: Set<string>): MapLayout {
  const nodes = new Map<string, LayoutNode>();
  const order: string[] = [];
  const root = store.root();
  if (!root) return { nodes, order, width: 0, height: 0 };
  const sides = rootSides(store);

  const measure = (n: TNode, depth: number, parentId: string | null, side: Side): LayoutNode => {
    const kids = store.children(n.id);
    const isCollapsed = collapsed.has(n.id);
    const ln: LayoutNode = {
      id: n.id,
      node: n,
      x: 0,
      y: 0,
      w: depth === 0 ? ROOT_W : NODE_W,
      h: NODE_H,
      depth,
      parentId,
      childIds: [],
      childCount: kids.length,
      collapsed: isCollapsed,
      subtreeH: NODE_H,
      side,
    };
    nodes.set(n.id, ln);
    order.push(n.id);
    if (!isCollapsed && kids.length) {
      let sum = 0;
      for (const k of kids) {
        const kl = measure(k, depth + 1, n.id, depth === 0 ? sides.get(k.id)! : side);
        ln.childIds.push(k.id);
        sum += kl.subtreeH;
      }
      sum += V_GAP * (kids.length - 1);
      ln.subtreeH = Math.max(NODE_H, sum);
    }
    return ln;
  };

  const rootL = measure(root, 0, null, 'right');

  let minX = 0;
  let maxX = 0;
  // places `ln` with its subtree's top at `top`, growing away from the root on its side
  const place = (ln: LayoutNode, x: number, top: number) => {
    ln.x = x;
    ln.y = top + (ln.subtreeH - ln.h) / 2;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x + ln.w);
    let cy = top;
    for (const cid of ln.childIds) {
      const c = nodes.get(cid)!;
      const childX = c.side === 'right' ? x + ln.w + H_GAP : x - H_GAP - c.w;
      place(c, childX, cy);
      cy += c.subtreeH + V_GAP;
    }
  };

  // the root: each side is a stack of branches centred on the root's middle
  const stackH = (ids: string[]) => ids.reduce((a, id) => a + nodes.get(id)!.subtreeH, 0) + V_GAP * Math.max(0, ids.length - 1);
  const rightIds = rootL.childIds.filter((id) => nodes.get(id)!.side === 'right');
  const leftIds = rootL.childIds.filter((id) => nodes.get(id)!.side === 'left');
  const rightH = stackH(rightIds);
  const leftH = stackH(leftIds);
  const totalH = Math.max(NODE_H, rightH, leftH);
  const centerY = totalH / 2;
  rootL.subtreeH = totalH;
  rootL.x = 0;
  rootL.y = centerY - rootL.h / 2;
  maxX = rootL.w;
  const placeStack = (ids: string[], h: number) => {
    let cy = centerY - h / 2;
    for (const id of ids) {
      const c = nodes.get(id)!;
      place(c, c.side === 'right' ? rootL.w + H_GAP : -H_GAP - c.w, cy);
      cy += c.subtreeH + V_GAP;
    }
  };
  placeStack(rightIds, rightH);
  placeStack(leftIds, leftH);

  // shift everything so the left-most node sits at PAD
  const dx = PAD - minX;
  for (const ln of nodes.values()) {
    ln.x += dx;
    ln.y += PAD;
  }

  return { nodes, order, width: maxX - minX + PAD * 2, height: totalH + PAD * 2 };
}

export function connectorPath(p: LayoutNode, c: LayoutNode): string {
  const right = c.side === 'right';
  const x1 = right ? p.x + p.w : p.x;
  const y1 = p.y + p.h / 2;
  const x2 = right ? c.x : c.x + c.w;
  const y2 = c.y + c.h / 2;
  const dx = (x2 - x1) / 2;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}
