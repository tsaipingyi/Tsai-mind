/**
 * Cloud mode public surface (what the layout / pages may import):
 *   isCloud                      — build flag
 *   useCloudStatus / CLOUD_STATE_LABEL — persistence status for a pill
 *   exportOutline(projectId)     — outline export via `downloads` (Blob link elsewhere)
 *   PROJECT_CHANGED_EVENT        — window event fired when another device changed a project
 *   installCloud(server)         — wires persistence + the sample assistant onto the DemoServer
 */
import type { DemoServer } from '../demo/mockApi';
import { SampleAssistant } from './assistant';
import { bootCloudPersistence, cloudPersister } from './persist';
import { exportOutline } from './export';
import { useCloudStatus } from './status';

export { isCloud } from './mode';
export { useCloudStatus, setCloudStatus, CLOUD_STATE_LABEL, OFFLINE_MESSAGE } from './status';
export type { CloudState, CloudStatus } from './status';
export { exportOutline } from './export';
export { PROJECT_CHANGED_EVENT } from './persist';
export { CloudStatusFallback } from './StatusPill';

/** Attach the cloud pieces to the in-page server. Resolves once persisted state is loaded (or offline). */
export function installCloud(server: DemoServer): Promise<void> {
  server.assistant = new SampleAssistant(server);
  const ready = bootCloudPersistence(server);
  // a small debug/automation handle (used by e2e/cloud.mjs)
  (window as unknown as { tsaimindCloud?: unknown }).tsaimindCloud = {
    exportOutline,
    status: () => useCloudStatus.getState(),
    flush: () => cloudPersister()?.flushAll(),
    ready,
  };
  return ready;
}
