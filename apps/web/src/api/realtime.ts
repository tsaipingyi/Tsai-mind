import { create } from 'zustand';
import type { RealtimeMessage } from './types';
import { isDemo } from '../demo/flag';

interface RealtimeState {
  connected: boolean;
  /** true while never connected in this tab (don't show "未连接" before the first attempt settles) */
  attempted: boolean;
}

export const useRealtime = create<RealtimeState>(() => ({ connected: false, attempted: false }));

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
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/realtime?token=${encodeURIComponent(token)}`;
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
    useRealtime.setState({ connected: true, attempted: true });
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
    useRealtime.setState({ connected: false, attempted: true });
    scheduleReconnect();
  };
  ws.onerror = () => {
    ws.close();
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
  if (isDemo) {
    // no server to talk to: the mock applies ops synchronously and the app already applies them optimistically
    currentToken = token;
    stopped = false;
    useRealtime.setState({ connected: true, attempted: true });
    return;
  }
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
