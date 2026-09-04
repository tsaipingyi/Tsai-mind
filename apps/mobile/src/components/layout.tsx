import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WEB_INSETS } from '../theme';

/** Safe-area insets; on web (visual check only) the iPhone 14 values so the export matches the artboards. */
export function useInsets(): { top: number; bottom: number } {
  const i = useSafeAreaInsets();
  if (Platform.OS === 'web') return WEB_INSETS;
  return { top: i.top, bottom: i.bottom };
}
