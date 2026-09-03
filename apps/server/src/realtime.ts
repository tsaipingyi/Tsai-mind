import type { WebSocket } from 'ws';

export type RealtimeMessage =
  | { type: 'op'; serverSeq: number; op: unknown }
  | { type: 'change'; change: unknown }
  | { type: 'batch'; batch: unknown }
  | { type: 'pong' };

/** In-process fan-out to connected WebSocket clients (single instance, no Redis). */
export class Hub {
  private readonly sockets = new Set<WebSocket>();

  add(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));
  }

  broadcast(msg: RealtimeMessage): void {
    const data = JSON.stringify(msg);
    for (const s of this.sockets) {
      if (s.readyState === s.OPEN) s.send(data);
    }
  }

  get size(): number {
    return this.sockets.size;
  }
}
