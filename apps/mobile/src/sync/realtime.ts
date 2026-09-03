import { create } from 'zustand';
import type { RealtimeMessage } from '../api/types';
import { getBaseUrl } from '../api/client';

interface RealtimeState {
  connected: boolean;
}

export const useRealtime = create<RealtimeState>(() => ({ connected: false }));

type Handler = (msg: RealtimeMessage) => void;
type OpenHandler = () => void;

let socket: WebSocket | null = null;
let currentToken: string | null = null;
let backoff = 1000;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
const handlers = new Set<Handler>();
const openHandlers = new Set<OpenHandler>();

export function onRealtime(fn: Handler): () => void {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

export function onRealtimeOpen(fn: OpenHandler): () => void {
  openHandlers.add(fn);
  return () => openHandlers.delete(fn);
}

function wsUrl(token: string): string {
  const base = getBaseUrl().replace(/^http/i, 'ws');
  return `${base}/api/realtime?token=${encodeURIComponent(token)}`;
}

function connect(): void {
  if (stopped || !currentToken) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl(currentToken));
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.onopen = () => {
    backoff = 1000;
    useRealtime.setState({ connected: true });
    for (const fn of openHandlers) fn();
  };
  ws.onmessage = (ev) => {
    let msg: RealtimeMessage;
    try {
      msg = JSON.parse(String(ev.data)) as RealtimeMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
    for (const fn of handlers) fn(msg);
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    useRealtime.setState({ connected: false });
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
}

function scheduleReconnect(): void {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    connect();
  }, backoff);
  backoff = Math.min(backoff * 2, 30_000);
}

export function startRealtime(token: string): void {
  if (currentToken === token && !stopped) return;
  stopRealtime();
  currentToken = token;
  stopped = false;
  backoff = 1000;
  connect();
}

export function stopRealtime(): void {
  stopped = true;
  currentToken = null;
  if (timer) clearTimeout(timer);
  timer = null;
  if (socket) {
    const s = socket;
    socket = null;
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  useRealtime.setState({ connected: false });
}
