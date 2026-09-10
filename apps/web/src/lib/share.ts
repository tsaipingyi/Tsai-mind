import { toast } from '../state/toast';
import { copyText } from './util';

/**
 * Hand a text to the system share sheet when the browser has one (iOS Safari / the claude.ai app),
 * otherwise copy it to the clipboard and show it in a toast. Returns how it was delivered.
 */
export async function shareOrCopy(text: string): Promise<'shared' | 'copied' | 'shown'> {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { share?: (data: { text: string }) => Promise<void> }) : undefined;
  if (nav?.share) {
    try {
      await nav.share({ text });
      return 'shared';
    } catch (e) {
      // the user dismissed the sheet, or the platform refused: fall through to the clipboard
      if ((e as Error).name === 'AbortError') return 'shown';
    }
  }
  const copied = await copyText(text);
  toast(`${copied ? '已复制到剪贴板：\n' : ''}${text}`, 'ok', 8000);
  return copied ? 'copied' : 'shown';
}
