/**
 * Push notifications: permission, Expo push token → POST /api/devices,
 * notification categories with actions, and tap routing.
 *
 * Everything is a no-op on web and when APNs is unavailable (simulator, Expo Go
 * on SDK 53+), so the web export used for visual verification never touches
 * the native module.
 */
import { Platform } from 'react-native';
import { api } from './api/client';
import type { PushData, PushKind } from './api/types';

export type Router = { push: (href: string) => void; navigate?: (href: string) => void };

type NotificationsModule = typeof import('expo-notifications');

let mod: NotificationsModule | null = null;
let started = false;
let pendingRoute: PushData | null = null;
let router: Router | null = null;

export const CATEGORY: Record<PushKind, string> = { change: 'change', batch: 'batch', due: 'due', nudge: 'nudge', digest: 'digest', dependency_slip: 'dependency' };

export const ACTION = {
  approve: 'approve',
  reject: 'reject',
  done: 'done',
  postpone: 'postpone',
  nudge: 'nudge',
} as const;

async function load(): Promise<NotificationsModule | null> {
  if (Platform.OS === 'web') return null;
  if (mod) return mod;
  try {
    mod = await import('expo-notifications');
    return mod;
  } catch {
    return null;
  }
}

/** True when this build can actually receive APNs pushes (real device, not Expo Go). */
export async function pushAvailable(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const Device = await import('expo-device');
    if (!Device.isDevice) return false;
    const Constants = (await import('expo-constants')).default;
    // Expo Go dropped remote notifications in SDK 53; only development/production builds get a token.
    if (Constants.appOwnership === 'expo' || Constants.executionEnvironment === 'storeClient') return false;
    return true;
  } catch {
    return false;
  }
}

/** Where a notification should take the user. */
export function routeFor(data: PushData | null | undefined): string | null {
  if (!data || typeof data !== 'object') return null;
  switch (data.kind) {
    case 'change':
      return data.nodeId ? `/node/${data.nodeId}` : '/pending';
    case 'batch':
      return '/pending';
    case 'due':
    case 'nudge':
      return data.nodeId ? `/node/${data.nodeId}` : '/';
    case 'digest':
      return '/';
    case 'dependency_slip': {
      // open the successor (the task that can no longer start on time)
      const id = data.nodeId ?? data.toNode;
      return id ? `/node/${id}` : '/';
    }
    default:
      return data.nodeId ? `/node/${data.nodeId}` : null;
  }
}

/** Perform a notification action without opening the app UI. Returns true when it was handled. */
export async function handleAction(actionId: string, data: PushData | null | undefined): Promise<boolean> {
  if (!data) return false;
  try {
    if (actionId === ACTION.approve && data.changeId) {
      await api.approveChange(data.changeId);
      return true;
    }
    if (actionId === ACTION.reject && data.changeId) {
      await api.rejectChange(data.changeId);
      return true;
    }
    if (actionId === ACTION.done && data.nodeId) {
      await api.markDone(data.nodeId);
      return true;
    }
    if (actionId === ACTION.postpone && data.nodeId) {
      await api.postpone(data.nodeId, 1);
      return true;
    }
  } catch {
    /* the app will show the current state when opened */
  }
  return false;
}

export function setRouter(r: Router): void {
  router = r;
  if (pendingRoute) {
    const d = pendingRoute;
    pendingRoute = null;
    const href = routeFor(d);
    if (href) r.push(href);
  }
}

function openRoute(data: PushData | null | undefined): void {
  const href = routeFor(data);
  if (!href) return;
  if (router) router.push(href);
  else pendingRoute = data ?? null;
}

async function registerCategories(N: NotificationsModule): Promise<void> {
  const opts = { opensAppToForeground: false };
  await N.setNotificationCategoryAsync(CATEGORY.change, [
    { identifier: ACTION.approve, buttonTitle: '确认', options: opts },
    { identifier: ACTION.reject, buttonTitle: '拒绝', options: { ...opts, isDestructive: true } },
  ]);
  await N.setNotificationCategoryAsync(CATEGORY.due, [
    { identifier: ACTION.done, buttonTitle: '标记完成', options: opts },
    { identifier: ACTION.postpone, buttonTitle: '推迟一天', options: opts },
  ]);
  await N.setNotificationCategoryAsync(CATEGORY.nudge, [{ identifier: ACTION.nudge, buttonTitle: '催办', options: { opensAppToForeground: true } }]);
  await N.setNotificationCategoryAsync(CATEGORY.batch, []);
  await N.setNotificationCategoryAsync(CATEGORY.digest, []);
  await N.setNotificationCategoryAsync(CATEGORY.dependency_slip, []);
}

/**
 * Ask permission, register with the server, hook up listeners. Safe to call on
 * every launch after login; it returns quietly when push is unavailable.
 */
export async function startPush(opts: { deviceName?: string } = {}): Promise<{ token: string | null; reason?: string }> {
  const N = await load();
  if (!N) return { token: null, reason: 'unsupported' };
  if (!started) {
    started = true;
    N.setNotificationHandler({
      handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: true }),
    });
    N.addNotificationResponseReceivedListener((response) => {
      const data = (response.notification.request.content.data ?? null) as PushData | null;
      const actionId = response.actionIdentifier;
      if (actionId && actionId !== N.DEFAULT_ACTION_IDENTIFIER) {
        void handleAction(actionId, data).then((handled) => {
          if (!handled) openRoute(data);
        });
        return;
      }
      openRoute(data);
    });
    // cold start from a notification tap
    N.getLastNotificationResponseAsync?.()
      .then((r) => {
        if (r) openRoute((r.notification.request.content.data ?? null) as PushData | null);
      })
      .catch(() => undefined);
  }
  try {
    await registerCategories(N);
  } catch {
    /* categories are iOS-only sugar */
  }
  if (!(await pushAvailable())) return { token: null, reason: 'no-apns' };
  try {
    const perm = await N.getPermissionsAsync();
    let status = perm.status;
    if (status !== 'granted') status = (await N.requestPermissionsAsync()).status;
    if (status !== 'granted') return { token: null, reason: 'denied' };
    const Constants = (await import('expo-constants')).default;
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId || undefined;
    const t = await N.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    await api.registerDevice({ platform: Platform.OS === 'ios' ? 'ios' : 'android', pushToken: t.data, name: opts.deviceName });
    return { token: t.data };
  } catch (e) {
    return { token: null, reason: (e as Error)?.message ?? 'error' };
  }
}

/** Clear the app badge (called when 待确认 is opened). */
export async function clearBadge(): Promise<void> {
  const N = await load();
  if (!N) return;
  try {
    await N.setBadgeCountAsync(0);
  } catch {
    /* ignore */
  }
}
