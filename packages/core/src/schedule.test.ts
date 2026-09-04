import { describe, expect, it } from 'vitest';
import { TreeStore, computeRollup, computeCriticalPath, findDependencySlips, dependencyWouldCycle, isWaitingOnDependency, type NewNodeInput, type Op } from './index.js';

const NOW = '2026-09-03T08:00:00.000Z';
let seq = 0;
const create = (node: NewNodeInput): Op => ({ opId: `op${seq++}`, clientId: 't', projectId: 'p', actor: 'user', at: NOW, type: 'create_node', node });

function fixture() {
  const s = new TreeStore();
  const add = (n: NewNodeInput) => {
    const r = s.apply(create(n));
    if (!r.ok) throw new Error(r.message);
  };
  add({ id: 'root', projectId: 'p', parentId: null, rank: 'V', title: 'root' });
  add({ id: 'a', projectId: 'p', parentId: 'root', rank: 'V', title: 'a', dueDate: '2026-09-12', status: 'done' });
  add({ id: 'b', projectId: 'p', parentId: 'root', rank: 'k', title: 'b' });
  add({ id: 'b1', projectId: 'p', parentId: 'b', rank: 'V', title: 'b1', startDate: '2026-09-08', dueDate: '2026-09-14' });
  add({ id: 'b2', projectId: 'p', parentId: 'b', rank: 'k', title: 'b2', startDate: '2026-09-15', dueDate: '2026-09-30' });
  add({ id: 'c', projectId: 'p', parentId: 'root', rank: 's', title: 'c', kind: 'milestone', dueDate: '2026-10-10' });
  return s;
}

describe('critical path', () => {
  it('follows the latest due date down to a leaf', () => {
    const s = fixture();
    expect(computeCriticalPath(s, computeRollup(s))).toEqual(['root', 'c']);
    s.apply({ opId: 'x', clientId: 't', projectId: 'p', actor: 'user', at: NOW, type: 'update_node', nodeId: 'c', patch: { dueDate: '2026-09-20' } });
    expect(computeCriticalPath(s, computeRollup(s))).toEqual(['root', 'b', 'b2']);
  });
});

describe('dependency slips', () => {
  it('flags a predecessor finishing after the successor starts', () => {
    const s = fixture();
    const deps = [{ fromNode: 'b1', toNode: 'b2' }];
    expect(findDependencySlips(s, computeRollup(s), deps)).toEqual([]);
    s.apply({ opId: 'y', clientId: 't', projectId: 'p', actor: 'user', at: NOW, type: 'update_node', nodeId: 'b1', patch: { dueDate: '2026-09-18' } });
    const slips = findDependencySlips(s, computeRollup(s), deps);
    expect(slips).toHaveLength(1);
    expect(slips[0]).toMatchObject({ fromDue: '2026-09-18', toStart: '2026-09-15', days: 3 });
    expect(isWaitingOnDependency('b2', s, computeRollup(s), deps)).toBe(true);
    s.apply({ opId: 'z', clientId: 't', projectId: 'p', actor: 'user', at: NOW, type: 'update_node', nodeId: 'b1', patch: { status: 'done' } });
    expect(findDependencySlips(s, computeRollup(s), deps)).toEqual([]);
    expect(isWaitingOnDependency('b2', s, computeRollup(s), deps)).toBe(false);
  });
  it('detects cycles', () => {
    const deps = [{ fromNode: 'a', toNode: 'b' }, { fromNode: 'b', toNode: 'c' }];
    expect(dependencyWouldCycle(deps, 'c', 'a')).toBe(true);
    expect(dependencyWouldCycle(deps, 'a', 'c')).toBe(false);
    expect(dependencyWouldCycle(deps, 'a', 'a')).toBe(true);
  });
});
