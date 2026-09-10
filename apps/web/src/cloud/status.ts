/**
 * Cloud persistence status for the UI (a small pill in the top bar / rail).
 *
 *   const { state, message } = useCloudStatus();
 *   // state: 'loading' | 'ready' | 'saving' | 'offline' | 'error'
 *
 * `label` gives the Chinese text for each state; `message` carries detail (an error, or the
 * offline explanation). `firstRun` is true until the viewer makes their first change.
 */
import { create } from 'zustand';

export type CloudState = 'loading' | 'ready' | 'saving' | 'local' | 'offline' | 'error';

export interface CloudStatus {
  state: CloudState;
  message?: string;
  firstRun: boolean;
  /** ISO time of the last confirmed write */
  savedAt: string | null;
  /** convenience for consumers that only know saving/saved: true exactly when `state === 'ready'` */
  saved: boolean;
}

export const CLOUD_STATE_LABEL: Record<CloudState, string> = {
  loading: '正在连接云端…',
  ready: '已同步',
  saving: '保存中…',
  local: '本机保存',
  offline: '离线',
  error: '保存失败',
};

export const OFFLINE_MESSAGE = '这个页面没有拿到云端存储，数据只在本页内存里，刷新就没了。';
export const LOCAL_MESSAGE = '这个页面不在 claude.ai 里打开，数据只存在这个浏览器里，不会同步到别的设备。';

export const useCloudStatus = create<CloudStatus>(() => ({ state: 'loading', message: undefined, firstRun: false, savedAt: null, saved: false }));

export function setCloudStatus(patch: Partial<CloudStatus>): void {
  const state = patch.state ?? useCloudStatus.getState().state;
  useCloudStatus.setState({ ...patch, saved: state === 'ready' || state === 'local' });
}
