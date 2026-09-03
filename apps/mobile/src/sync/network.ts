import { Platform } from 'react-native';

type Listener = (online: boolean) => void;
const listeners = new Set<Listener>();
let started = false;

/**
 * Online/offline signal. Uses NetInfo on device; on web the browser events.
 * Fetch failures also flip the queue offline, so this is a hint, not the truth.
 */
export function onNetwork(fn: Listener): () => void {
  listeners.add(fn);
  start();
  return () => listeners.delete(fn);
}

function emit(online: boolean) {
  for (const fn of listeners) fn(online);
}

function start() {
  if (started) return;
  started = true;
  if (Platform.OS === 'web') {
    const w = globalThis as unknown as { addEventListener?: (t: string, f: () => void) => void };
    w.addEventListener?.('online', () => emit(true));
    w.addEventListener?.('offline', () => emit(false));
    return;
  }
  import('@react-native-community/netinfo')
    .then((m) => {
      const NetInfo = m.default;
      NetInfo.addEventListener((state) => emit(state.isConnected !== false && state.isInternetReachable !== false));
    })
    .catch(() => {
      /* NetInfo missing (e.g. Expo Go without the module): stay optimistic */
    });
}
