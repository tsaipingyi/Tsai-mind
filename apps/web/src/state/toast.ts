import { create } from 'zustand';

export interface ToastAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'ok' | 'error';
  actions?: ToastAction[];
}

interface ToastState {
  toasts: Toast[];
  push: (text: string, kind?: Toast['kind'], ms?: number, actions?: ToastAction[]) => void;
  dismiss: (id: number) => void;
}

let seq = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (text, kind = 'info', ms, actions) => {
    const id = seq++;
    set({ toasts: [...get().toasts, { id, text, kind, actions }] });
    const ttl = ms ?? (actions?.length ? 15000 : kind === 'error' ? 6000 : text.length > 60 ? 8000 : 3500);
    setTimeout(() => get().dismiss(id), ttl);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = (text: string, kind?: Toast['kind'], ms?: number) => useToasts.getState().push(text, kind, ms);

/** A toast with 确认 / 取消 buttons. Resolves true when confirmed. */
export function confirmToast(text: string, confirmLabel = '确认'): Promise<boolean> {
  return new Promise((resolve) => {
    const st = useToasts.getState();
    const id = seq;
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      useToasts.getState().dismiss(id);
      resolve(v);
    };
    st.push(text, 'info', 15000, [
      { label: '取消', run: () => finish(false) },
      { label: confirmLabel, primary: true, run: () => finish(true) },
    ]);
    setTimeout(() => finish(false), 15000);
  });
}
