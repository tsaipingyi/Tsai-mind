/**
 * Push sender on top of expo-server-sdk with an injectable transport so tests can capture messages.
 * Every push carries `data` {kind, nodeId?, changeId?, batchId?, projectId?} and a `categoryId`
 * that the iOS app maps to notification actions:
 *   change → approve / reject, batch → open, due → done / postpone, nudge → open, digest → open.
 */
import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import type { Logger } from './service/context.js';

export type PushCategory = 'change' | 'batch' | 'due' | 'nudge' | 'digest';

export interface PushData {
  kind: PushCategory;
  nodeId?: string;
  changeId?: string;
  batchId?: string;
  projectId?: string;
  [key: string]: unknown;
}

export interface PushMessage {
  title: string;
  body: string;
  data: PushData;
  categoryId: PushCategory;
  badge?: number;
  /** Collapses repeated pushes about the same thing on the device. */
  collapseId?: string;
}

export type PushTransport = (messages: ExpoPushMessage[]) => Promise<ExpoPushTicket[]>;

export interface PushOutcome {
  sent: number;
  tickets: ExpoPushTicket[];
  /** Tokens Expo reported as DeviceNotRegistered; the caller should drop these devices. */
  invalidTokens: string[];
}

export interface PushSender {
  send(tokens: string[], message: PushMessage): Promise<PushOutcome>;
}

const CHUNK = 100;

/** Transport that talks to Expo's push API. */
export function expoTransport(opts: { accessToken?: string } = {}): PushTransport {
  const expo = new Expo(opts.accessToken ? { accessToken: opts.accessToken } : {});
  return (messages) => expo.sendPushNotificationsAsync(messages);
}

/** Transport for tests: records every message and answers with ok tickets. */
export function capturingTransport(): { transport: PushTransport; messages: ExpoPushMessage[]; reset(): void } {
  const messages: ExpoPushMessage[] = [];
  return {
    messages,
    reset: () => messages.splice(0, messages.length),
    transport: async (batch) => {
      messages.push(...batch);
      return batch.map((_m, i) => ({ status: 'ok' as const, id: `ticket-${messages.length - batch.length + i}` }));
    },
  };
}

export function createPushSender(opts: { transport: PushTransport; log?: Logger }): PushSender {
  const log = opts.log ?? console;
  return {
    async send(tokens, message) {
      const valid = tokens.filter((t) => Expo.isExpoPushToken(t));
      for (const t of tokens) if (!valid.includes(t)) log.warn({ token: t.slice(0, 24) }, 'push: not an Expo push token, skipped');
      if (valid.length === 0) return { sent: 0, tickets: [], invalidTokens: [] };
      const messages: ExpoPushMessage[] = valid.map((to) => ({
        to,
        title: message.title,
        body: message.body,
        data: message.data,
        categoryId: message.categoryId,
        sound: 'default',
        priority: 'high',
        ...(message.badge !== undefined ? { badge: message.badge } : {}),
        ...(message.collapseId ? { collapseId: message.collapseId } : {}),
      }));
      const tickets: ExpoPushTicket[] = [];
      const invalidTokens: string[] = [];
      for (let i = 0; i < messages.length; i += CHUNK) {
        const chunk = messages.slice(i, i + CHUNK);
        try {
          const res = await opts.transport(chunk);
          res.forEach((t, j) => {
            tickets.push(t);
            if (t.status === 'error') {
              const token = chunk[j]?.to as string | undefined;
              log.warn({ token: token?.slice(0, 24), error: t.details?.error, message: t.message }, 'push: ticket error');
              if (t.details?.error === 'DeviceNotRegistered' && token) invalidTokens.push(token);
            }
          });
        } catch (err) {
          log.error(err, 'push: transport failed');
        }
      }
      return { sent: tickets.filter((t) => t.status === 'ok').length, tickets, invalidTokens };
    },
  };
}

/** Sender that drops everything (used when no transport is configured). */
export const noopPushSender: PushSender = { send: async () => ({ sent: 0, tickets: [], invalidTokens: [] }) };
