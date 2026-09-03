import { Platform } from 'react-native';
import type { NodeStatus } from '@tsai-mind/core';

/** Colour tokens from docs/design-system.md — white ground, orange only for attention. */
export const C = {
  paper: '#FFFFFF',
  paper2: '#FAFAFA',
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

export const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'JetBrains Mono, Menlo, Consolas, monospace' });

export const FONT = {
  body: 15,
  small: 13,
  tiny: 12,
  title: 17,
  large: 34,
} as const;

export const RADIUS = 8;
