import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** Tiny async KV used by the queue, snapshots and settings. AsyncStorage works on iOS and (via localStorage) on web. */
export interface KV {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const kv: KV = {
  getItem: (k) => AsyncStorage.getItem(k),
  setItem: (k, v) => AsyncStorage.setItem(k, v),
  removeItem: (k) => AsyncStorage.removeItem(k),
};

/**
 * Secrets (the PAT) go to expo-secure-store on device. It has no web implementation,
 * so the web export (used for visual verification) falls back to localStorage.
 */
export const secure: KV = {
  async getItem(k) {
    if (Platform.OS === 'web') return webLocal('get', k);
    const SecureStore = await import('expo-secure-store');
    return SecureStore.getItemAsync(k);
  },
  async setItem(k, v) {
    if (Platform.OS === 'web') {
      webLocal('set', k, v);
      return;
    }
    const SecureStore = await import('expo-secure-store');
    await SecureStore.setItemAsync(k, v);
  },
  async removeItem(k) {
    if (Platform.OS === 'web') {
      webLocal('remove', k);
      return;
    }
    const SecureStore = await import('expo-secure-store');
    await SecureStore.deleteItemAsync(k);
  },
};

function webLocal(op: 'get' | 'set' | 'remove', k: string, v?: string): string | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return null;
    if (op === 'get') return ls.getItem(k);
    if (op === 'set') ls.setItem(k, v ?? '');
    else ls.removeItem(k);
  } catch {
    /* ignore */
  }
  return null;
}

const CLIENT_ID_KEY = 'tsaimind.clientId';
let cachedClientId: string | null = null;

/** One id per install; every Op carries it so the server can echo our own ops back. */
export async function clientId(): Promise<string> {
  if (cachedClientId) return cachedClientId;
  let id = await kv.getItem(CLIENT_ID_KEY);
  if (!id) {
    const { uuid } = await import('./ids');
    id = uuid();
    await kv.setItem(CLIENT_ID_KEY, id);
  }
  cachedClientId = id;
  return id;
}

export function clientIdSync(): string {
  return cachedClientId ?? 'mobile';
}
