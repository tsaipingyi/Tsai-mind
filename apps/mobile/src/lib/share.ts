import { Platform, Share } from 'react-native';
import { toast } from '../state/toast';

/** 催办 opens the system share sheet (design-system §7); on web fall back to the clipboard. */
export async function shareText(text: string): Promise<void> {
  if (Platform.OS === 'web') {
    const nav = (globalThis as { navigator?: { share?: (d: { text: string }) => Promise<void>; clipboard?: { writeText: (t: string) => Promise<void> } } }).navigator;
    try {
      if (nav?.share) {
        await nav.share({ text });
        return;
      }
    } catch {
      /* cancelled */
    }
    try {
      await nav?.clipboard?.writeText(text);
      toast('已复制催办文案', 'ok', 4000);
    } catch {
      toast(text, 'info', 6000);
    }
    return;
  }
  try {
    await Share.share({ message: text });
  } catch {
    /* user cancelled */
  }
}
