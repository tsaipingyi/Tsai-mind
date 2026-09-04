import { Platform } from 'react-native';
import type { NodeStatus } from '@tsai-mind/core';

/** Colour tokens from docs/design-system.md — white ground, orange only for attention. */
export const C = {
  paper: '#FFFFFF',
  paper2: '#FAFAFA',
  /** user chat bubble (design/mobile-v2/Claude.dc.html) */
  bubble: '#F3F3F3',
  ink: '#1C1C1C',
  ink2: '#6B6B6B',
  ink3: '#A3A3A3',
  line: '#E5E5E5',
  orange: '#F26B1D',
  orangeDeep: '#D4550C',
  orangeSoft: '#FFF1E8',
  orangeLine: '#F8B98F',
  red: '#D64545',
  green: '#2F9E62',
} as const;

export const STATUS_COLOR: Record<NodeStatus, string> = {
  todo: '#9A9A9A',
  in_progress: '#2E6FD8',
  blocked: '#D64545',
  waiting: '#7A5AD6',
  done: '#2F9E62',
};

export const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'Menlo, JetBrains Mono, Consolas, monospace' });

/** Sizes used by the mobile-v2 artboards (design/mobile-v2). */
export const FONT = {
  tiny: 11,
  small: 13,
  meta: 14,
  body: 15,
  input: 16,
  title: 17,
  h2: 22,
  h1: 26,
  large: 34,
} as const;

export const RADIUS = 10;
/** page side padding on every artboard */
export const PAGE_PAD = 20;
/** bottom tab bar without the home indicator (83 on an iPhone with a 34px inset) */
export const TAB_BAR = 49;
/** The web export (only used for the visual check at 390×844) has no safe-area insets; use the iPhone 14 values so it matches the artboards. */
export const WEB_INSETS = { top: 47, bottom: 34 } as const;
