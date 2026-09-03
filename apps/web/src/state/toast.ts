import { create } from 'zustand';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'ok' | 'error';
}

interface ToastState {
  toasts: Toast[];
  push: (text: string, kind?: Toast['kind'], ms?: number) => void;
  dismiss: (id: number) => void;
}

let seq = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (text, kind = 'info', ms) => {
    const id = seq++;
    set({ toasts: [...get().toasts, { id, text, kind }] });
    const ttl = ms ?? (kind === 'error' ? 6000 : text.length > 60 ? 8000 : 3500);
    setTimeout(() => get().dismiss(id), ttl);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = (text: string, kind?: Toast['kind'], ms?: number) => useToasts.getState().push(text, kind, ms);
