import type { ToolCall } from '../api/types';

/**
 * Plain-Chinese tool chips for the phone Claude page (design/mobile-v2/Claude.dc.html「改了截止日 · 待确认」).
 * Same mapping as apps/mobile/src/state/assistant.ts so both clients read alike.
 */
export type ToolOutcome = '完成' | '待确认' | '失败';

export function toolOutcome(t: ToolCall): ToolOutcome {
  const r = t.resultText ?? '';
  if (/"status"\s*:\s*"pending"|change_id|changeId|待确认/.test(r)) return '待确认';
  if (/^\s*\{[^}]*"error"/.test(r) || /"ok"\s*:\s*false/.test(r)) return '失败';
  return '完成';
}

const TOOL_FIELD: Record<string, string> = {
  title: '标题',
  description: '说明',
  ownerId: '负责人',
  owner_id: '负责人',
  status: '状态',
  progress: '进度',
  startDate: '开始日',
  start_date: '开始日',
  dueDate: '截止日',
  due_date: '截止日',
  estimateHours: '工时',
  estimate_hours: '工时',
  priority: '优先级',
  tags: '标签',
  kind: '类型',
  side: '导图方向',
};

function inputOf(t: ToolCall): Record<string, unknown> {
  return t.input && typeof t.input === 'object' ? (t.input as Record<string, unknown>) : {};
}

/**
 * update_node → 改了{字段}, create_node → 加了「{title}」, set_owner → 换了负责人, delete_node → 删了「{title}」,
 * nudge → 拟了催办, draft_plan → 拟了 n 个节点的草案; anything else falls back to the tool name.
 */
export function toolVerb(t: ToolCall): string {
  const input = inputOf(t);
  const title = typeof input.title === 'string' ? input.title : typeof input.node_title === 'string' ? input.node_title : '';
  const quoted = title ? `「${title}」` : '';
  switch (t.name) {
    case 'update_node': {
      const patch = input.patch && typeof input.patch === 'object' ? (input.patch as Record<string, unknown>) : input;
      const fields = Object.keys(patch)
        .filter((k) => k in TOOL_FIELD)
        .map((k) => TOOL_FIELD[k]!);
      return fields.length ? `改了${[...new Set(fields)].join('、')}` : '改了节点';
    }
    case 'create_node':
    case 'add_node':
      return `加了${quoted || '节点'}`;
    case 'set_owner':
    case 'assign_owner':
      return '换了负责人';
    case 'set_dates':
      return '改了日期';
    case 'set_status':
      return '改了状态';
    case 'set_progress':
      return '改了进度';
    case 'delete_node':
      return `删了${quoted || '节点'}`;
    case 'nudge':
    case 'nudge_node':
    case 'draft_nudge':
      return '拟了催办';
    case 'draft_plan':
    case 'plan_outline':
    case 'propose_plan':
    case 'plan': {
      const n = countPlanNodes(t);
      return n ? `拟了 ${n} 个节点的草案` : '拟了草案';
    }
    case 'move_node':
      return `移了${quoted || '节点'}`;
    default:
      return t.name;
  }
}

function countPlanNodes(t: ToolCall): number {
  const input = inputOf(t);
  if (typeof input.outline === 'string') return input.outline.split('\n').filter((l) => l.trim()).length;
  const m = /"create"\s*:\s*(\d+)/.exec(t.resultText ?? '');
  return m ? Number(m[1]) : 0;
}

/** Chip text: the verb plus「· 待确认」/「· 失败」. */
export function toolLabel(t: ToolCall): string {
  const o = toolOutcome(t);
  return o === '完成' ? toolVerb(t) : `${toolVerb(t)} · ${o}`;
}
