import { useEffect, useRef, useState } from 'react';

/**
 * Inline title editor. Enter commits, Escape cancels, Tab commits and asks for a child.
 * Keyboard events are stopped so the global editor shortcuts don't fire while typing.
 */
export function TitleInput({
  value,
  onCommit,
  onCancel,
  onTab,
  className,
}: {
  value: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
  onTab?: () => void;
  className?: string;
}) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(v);
  };

  return (
    <input
      ref={ref}
      className={className}
      value={v}
      data-title-input
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done.current = true;
          onCancel();
        } else if (e.key === 'Tab' && onTab) {
          e.preventDefault();
          commit();
          onTab();
        }
      }}
    />
  );
}
