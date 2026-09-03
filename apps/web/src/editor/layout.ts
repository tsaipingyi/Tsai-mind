import type { TNode, TreeStore } from '@tsai-mind/core';

export const NODE_W = 200;
export const ROOT_W = 160;
export const NODE_H = 52;
export const H_GAP = 64;
export const V_GAP = 16;
export const PAD = 40;

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
}

export interface MapLayout {
  nodes: Map<string, LayoutNode>;
  order: string[];
  width: number;
  height: number;
}

export function computeLayout(store: TreeStore, collapsed: Set<string>): MapLayout {
  const nodes = new Map<string, LayoutNode>();
  const order: string[] = [];
  const root = store.root();
  if (!root) return { nodes, order, width: 0, height: 0 };

  const measure = (n: TNode, depth: number, parentId: string | null): LayoutNode => {
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
    };
    nodes.set(n.id, ln);
    order.push(n.id);
    if (!isCollapsed && kids.length) {
      let sum = 0;
      for (const k of kids) {
        const kl = measure(k, depth + 1, n.id);
        ln.childIds.push(k.id);
        sum += kl.subtreeH;
      }
      sum += V_GAP * (kids.length - 1);
      ln.subtreeH = Math.max(NODE_H, sum);
    }
    return ln;
  };

  const rootL = measure(root, 0, null);

  let maxX = 0;
  const place = (ln: LayoutNode, x: number, top: number) => {
    ln.x = x;
    ln.y = top + (ln.subtreeH - ln.h) / 2;
    maxX = Math.max(maxX, x + ln.w);
    let cy = top;
    const childX = x + ln.w + H_GAP;
    for (const cid of ln.childIds) {
      const c = nodes.get(cid)!;
      place(c, childX, cy);
      cy += c.subtreeH + V_GAP;
    }
  };
  place(rootL, PAD, PAD);

  return { nodes, order, width: maxX + PAD, height: rootL.subtreeH + PAD * 2 };
}

export function connectorPath(p: LayoutNode, c: LayoutNode): string {
  const x1 = p.x + p.w;
  const y1 = p.y + p.h / 2;
  const x2 = c.x;
  const y2 = c.y + c.h / 2;
  const dx = (x2 - x1) / 2;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}
