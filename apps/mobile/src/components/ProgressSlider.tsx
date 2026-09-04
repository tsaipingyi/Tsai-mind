import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import { C, STATUS_COLOR } from '../theme';

const THUMB = 24;

/**
 * The 进度 slider from Node.dc.html: a 6px track (line grey, filled #2E6FD8) with a 24px white thumb.
 * Drag or tap; `onCommit` fires on release with a value rounded to `step`.
 */
export function ProgressSlider({ value, onCommit, disabled, step = 5 }: { value: number; onCommit: (v: number) => void; disabled?: boolean; step?: number }) {
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const widthRef = useRef(0);
  const startRef = useRef(0);
  const lastRef = useRef(value);

  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const fromX = (x: number) => (widthRef.current ? clamp((x / widthRef.current) * 100) : 0);
  const snap = (v: number) => Math.round(clamp(v) / step) * step;

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabled,
      onMoveShouldSetPanResponder: () => !disabled,
      onPanResponderGrant: (e) => {
        startRef.current = fromX(e.nativeEvent.locationX);
        lastRef.current = startRef.current;
        setDrag(startRef.current);
      },
      onPanResponderMove: (_e, g) => {
        const v = clamp(startRef.current + (widthRef.current ? (g.dx / widthRef.current) * 100 : 0));
        lastRef.current = v;
        setDrag(v);
      },
      onPanResponderRelease: () => {
        setDrag(null);
        onCommit(snap(lastRef.current));
      },
      onPanResponderTerminate: () => setDrag(null),
    }),
  ).current;

  const shown = drag ?? value;
  const fill = disabled ? C.ink3 : STATUS_COLOR.in_progress;
  const left = width ? (shown / 100) * width - THUMB / 2 : 0;
  return (
    <View
      style={s.wrap}
      onLayout={(e) => {
        widthRef.current = e.nativeEvent.layout.width;
        setWidth(e.nativeEvent.layout.width);
      }}
      accessibilityRole="adjustable"
      accessibilityLabel="进度"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(shown) }}
      accessibilityState={{ disabled: !!disabled }}
      testID="progress-slider"
      {...(disabled ? {} : pan.panHandlers)}
    >
      <View style={s.track}>
        <View style={[s.fill, { width: `${shown}%`, backgroundColor: fill }]} />
      </View>
      {!disabled && width > 0 ? <View pointerEvents="none" style={[s.thumb, { left }]} /> : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { height: THUMB, justifyContent: 'center' },
  track: { height: 6, borderRadius: 3, backgroundColor: C.line, overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, height: 6, borderRadius: 3 },
  thumb: {
    position: 'absolute',
    top: 0,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: C.paper,
    borderWidth: 1.5,
    borderColor: C.line,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
});
