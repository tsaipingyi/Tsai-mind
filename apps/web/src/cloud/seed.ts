/**
 * First-run state for cloud mode: the account (same name as the demo seed), no contacts, no sample
 * projects — the persistence layer creates the one starter project through the normal
 * POST /api/projects route so it is logged and saved like anything the user does.
 */
import type { Seed } from '../demo/seed';
import type { Account } from '../api/types';

export const STARTER_PROJECT_NAME = '我的第一个项目';
export const STARTER_OUTLINE = ['- 想清楚这个项目要达成什么', '- 拆成三五个能交付的步骤', '- 打开右上角的 Claude，让它帮你排期'].join('\n');

export function buildCloudSeed(): Seed {
  let tz = 'Asia/Shanghai';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz;
  } catch {
    /* ignore */
  }
  const account: Account = { id: 'u_cloud', email: 'me@tsai.mind', name: '蔡', timezone: tz, settings: {} };
  return { account, tokens: [], contacts: [], projects: [], changes: [], batches: [], sessions: [], messages: new Map() };
}
