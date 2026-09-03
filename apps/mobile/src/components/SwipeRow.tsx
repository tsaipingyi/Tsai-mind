import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useRef } from 'react';
import { FONT } from '../theme';

/**
 * Swipe-to-act row. `onLeft` fires when the user swipes LEFT (actions revealed on the right side);
 * `onRight` when swiping RIGHT (actions on the left side).
 */
export function SwipeRow({
  children,
  onLeft,
  leftLabel,
  leftColor,
  onRight,
  rightLabel,
  rightColor,
}: {
  children: ReactNode;
  onLeft?: () => void;
  leftLabel?: string;
  leftColor?: string;
  onRight?: () => void;
  rightLabel?: string;
  rightColor?: string;
}) {
  const ref = useRef<SwipeableMethods>(null);
  const fire = (fn?: () => void) => {
    ref.current?.close();
    fn?.();
  };
  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={2}
      overshootLeft={false}
      overshootRight={false}
      rightThreshold={56}
      leftThreshold={56}
      onSwipeableOpen={(dir) => (dir === 'right' ? fire(onLeft) : fire(onRight))}
      renderRightActions={onLeft ? () => <Action label={leftLabel ?? ''} color={leftColor ?? '#2F9E62'} /> : undefined}
      renderLeftActions={onRight ? () => <Action label={rightLabel ?? ''} color={rightColor ?? '#6B6B6B'} /> : undefined}
    >
      {children}
    </ReanimatedSwipeable>
  );
}

function Action({ label, color }: { label: string; color: string }) {
  return (
    <View style={[s.action, { backgroundColor: color }]}>
      <Text style={s.actionText}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  action: { width: 96, alignItems: 'center', justifyContent: 'center' },
  actionText: { color: '#fff', fontSize: FONT.small, fontWeight: '600' },
});
