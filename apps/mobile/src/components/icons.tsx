import Svg, { Path, Rect } from 'react-native-svg';

/** Stroke icons copied from design/mobile-v2 (24-unit grid, 1.8 stroke, round caps). */
function Base({ size = 26, color, children }: { size?: number; color: string; children: React.ReactNode }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </Svg>
  );
}

export function TodayIcon({ color, size }: { color: string; size?: number }) {
  return (
    <Base color={color} size={size}>
      <Rect x={3} y={5} width={18} height={16} rx={3} />
      <Path d="M3 10h18M8 3v4M16 3v4" />
    </Base>
  );
}

export function ProjectsIcon({ color, size }: { color: string; size?: number }) {
  return (
    <Base color={color} size={size}>
      <Rect x={3} y={9} width={6} height={6} rx={2} />
      <Rect x={15} y={4} width={6} height={6} rx={2} />
      <Rect x={15} y={14} width={6} height={6} rx={2} />
      <Path d="M9 12h3M12 12V7h3M12 12v5h3" />
    </Base>
  );
}

export function ClaudeIcon({ color, size }: { color: string; size?: number }) {
  return (
    <Base color={color} size={size}>
      <Path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4z" />
    </Base>
  );
}

/** Send button arrow (Claude.dc.html): 20px, 2.2 stroke, white. */
export function ArrowUpIcon({ color = '#FFFFFF', size = 20 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 19V5M5 12l7-7 7 7" />
    </Svg>
  );
}

export function PlusIcon({ color = '#FFFFFF', size = 28 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function ChevronDownIcon({ color, size = 18 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M6 9l6 6 6-6" />
    </Svg>
  );
}
