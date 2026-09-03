import { useEffect, useMemo, useRef, useState } from 'react';
import type { Contact, NodeStatus } from '@tsai-mind/core';
import { NODE_STATUSES } from '@tsai-mind/core';
import { STATUS_LABEL } from '../lib/util';
import { Avatar } from '../components/ui';

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  run: () => void;
}

function useListNav(count: number, onPick: (i: number) => void, onClose: () => void) {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [count]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(count - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (count) onPick(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };
  return { active, setActive, onKeyDown };
}

function Popover({
  placeholder,
  items,
  onClose,
  title,
}: {
  placeholder: string;
  items: Item[];
  onClose: () => void;
  title?: string;
}) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? items.filter((i) => i.label.toLowerCase().includes(s) || i.id.toLowerCase().includes(s)) : items;
  }, [items, q]);
  const { active, setActive, onKeyDown } = useListNav(
    filtered.length,
    (i) => {
      filtered[i]?.run();
    },
    onClose,
  );
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.popover')) onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);
  return (
    <div className="popover center" role="dialog" aria-label={title ?? placeholder} onKeyDown={onKeyDown}>
      {title && (
        <div className="faint" style={{ fontSize: 12, padding: '2px 8px' }}>
          {title}
        </div>
      )}
      <input ref={ref} className="input" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="items">
        {filtered.map((it, i) => (
          <div
            key={it.id}
            className={`item${i === active ? ' active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              it.run();
            }}
          >
            {it.icon}
            <span>{it.label}</span>
            {it.hint && <span className="hint">{it.hint}</span>}
          </div>
        ))}
        {!filtered.length && <div className="empty">没有匹配项</div>}
      </div>
    </div>
  );
}

export function OwnerPicker({
  contacts,
  current,
  onPick,
  onClose,
}: {
  contacts: Contact[];
  current: string | null;
  onPick: (id: string | null) => void;
  onClose: () => void;
}) {
  const items: Item[] = [
    { id: 'me', label: '我', hint: current === null ? '当前' : undefined, icon: <Avatar ownerId={null} />, run: () => onPick(null) },
    ...contacts
      .filter((c) => !c.archivedAt)
      .map((c) => ({
        id: c.id,
        label: c.company ? `${c.name} · ${c.company}` : c.name,
        hint: current === c.id ? '当前' : undefined,
        icon: <Avatar contact={c} ownerId={c.id} />,
        run: () => onPick(c.id),
      })),
  ];
  return <Popover title="负责人" placeholder="输入名字筛选，Enter 指派" items={items} onClose={onClose} />;
}

export interface PaletteActions {
  setStatus: (s: NodeStatus) => void;
  setProgress: (p: number) => void;
  focusDate: () => void;
  pickOwner: () => void;
  addChild: () => void;
  remove: () => void;
  nudge: () => void;
  copyOutline: () => void;
  canNudge: boolean;
}

export function CommandPalette({ actions, onClose }: { actions: PaletteActions; onClose: () => void }) {
  const [sub, setSub] = useState<'status' | 'progress' | null>(null);
  if (sub === 'status') {
    const items: Item[] = NODE_STATUSES.map((s) => ({
      id: s,
      label: STATUS_LABEL[s],
      hint: s,
      run: () => {
        actions.setStatus(s);
        onClose();
      },
    }));
    return <Popover key="status" title="状态" placeholder="选择状态" items={items} onClose={onClose} />;
  }
  if (sub === 'progress') {
    const items: Item[] = [0, 10, 25, 50, 75, 90, 100].map((p) => ({
      id: String(p),
      label: `${p}%`,
      run: () => {
        actions.setProgress(p);
        onClose();
      },
    }));
    return <Popover key="progress" title="进度" placeholder="选择进度" items={items} onClose={onClose} />;
  }
  const items: Item[] = [
    { id: 'status', label: '状态', hint: '改状态', run: () => setSub('status') },
    { id: 'progress', label: '进度', hint: '改进度', run: () => setSub('progress') },
    {
      id: 'date',
      label: '日期',
      hint: '在侧栏改日期',
      run: () => {
        actions.focusDate();
        onClose();
      },
    },
    {
      id: 'owner',
      label: '负责人',
      hint: '@',
      run: () => {
        onClose();
        actions.pickOwner();
      },
    },
    {
      id: 'child',
      label: '加子节点',
      hint: 'Tab',
      run: () => {
        actions.addChild();
        onClose();
      },
    },
    {
      id: 'delete',
      label: '删除',
      hint: 'Delete',
      run: () => {
        onClose();
        actions.remove();
      },
    },
    ...(actions.canNudge
      ? [
          {
            id: 'nudge',
            label: '催办',
            hint: '生成并复制催办消息',
            run: () => {
              actions.nudge();
              onClose();
            },
          },
        ]
      : []),
    {
      id: 'copy-outline',
      label: '复制大纲',
      hint: '整个项目',
      run: () => {
        actions.copyOutline();
        onClose();
      },
    },
  ];
  return <Popover key="root" title="命令" placeholder="输入命令…" items={items} onClose={onClose} />;
}
