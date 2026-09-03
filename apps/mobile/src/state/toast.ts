import { create } from 'zustand';

export type ToastKind = 'info' | 'ok' | 'error';
export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
}

interface ToastState {
  toasts: Toast[];
}

export const useToasts = create<ToastState>(() => ({ toasts: [] }));
let seq = 0;

export function toast(text: string, kind: ToastKind = 'info', ms = 2500): void {
  const id = ++seq;
  useToasts.setState((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}
