import { create } from 'zustand';
import { forgetUnlocked } from '../lib/lock';

/** bumps whenever the page should re-check its lock (锁定 pressed) */
interface LockState {
  rev: number;
  lockNow: () => void;
}

export const useLock = create<LockState>((set) => ({
  rev: 0,
  lockNow: () => {
    forgetUnlocked();
    set((s) => ({ rev: s.rev + 1 }));
  },
}));
