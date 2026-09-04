/**
 * Server-sent events over a POST request.
 *
 * `fetch` + `ReadableStream` is not reliable in React Native (the body arrives
 * in one piece, or never streams on Hermes), so the primary transport is an
 * XMLHttpRequest whose `onprogress` hands us `responseText` as it grows — that
 * works on iOS, Android and web. When there is no XHR at all (some test
 * runtimes) we fall back to `fetch` with a reader.
 *
 * The parser is pure (no I/O) so it can be unit tested without React Native.
 */
import { ApiError } from './client';

export interface SSEEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental parser for the text/event-stream format: feed it chunks in any
 * split (mid-line, mid-UTF-16 is not a concern since we get strings), get back
 * complete events. Handles `\n`, `\r\n` and `\r` line endings, `:` comments,
 * multi-line `data:` (joined with `\n`) and the optional single space after the
 * field name.
 */
export class SSEParser {
  private buf = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;

  push(chunk: string): SSEEvent[] {
    this.buf += chunk;
    const out: SSEEvent[] = [];
    for (;;) {
      const nl = this.buf.search(/\r\n|\r|\n/);
      if (nl < 0) break;
      const sep = this.buf[nl] === '\r' && this.buf[nl + 1] === '\n' ? 2 : 1;
      // a lone '\r' at the very end may be the first half of '\r\n': wait for more
      if (sep === 1 && this.buf[nl] === '\r' && nl === this.buf.length - 1) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + sep);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** Flush a trailing event that was not terminated by a blank line. */
  end(): SSEEvent[] {
    const out: SSEEvent[] = [];
    if (this.buf) {
      const ev = this.line(this.buf);
      this.buf = '';
      if (ev) out.push(ev);
    }
    const last = this.dispatch();
    if (last) out.push(last);
    return out;
  }

  private line(line: string): SSEEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.event = value;
        break;
      case 'data':
        this.data.push(value);
        break;
      case 'id':
        this.id = value;
        break;
      default:
        /* retry and unknown fields are ignored */
        break;
    }
    return null;
  }

  private dispatch(): SSEEvent | null {
    if (!this.data.length && !this.event) return null;
    const ev: SSEEvent = { event: this.event || 'message', data: this.data.join('\n') };
    if (this.id !== undefined) ev.id = this.id;
    this.event = '';
    this.data = [];
    return ev;
  }
}

/** Parse a complete stream in one go. */
export function parseSSE(text: string): SSEEvent[] {
  const p = new SSEParser();
  return [...p.push(text), ...p.end()];
}

export interface StreamOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  onEvent: (ev: SSEEvent) => void;
}

export interface StreamHandle {
  /** Resolves when the stream ends; rejects with an ApiError on HTTP / network failure. */
  done: Promise<void>;
  abort: () => void;
}

function httpError(status: number, text: string): ApiError {
  let code = 'error';
  let message = `${status}`;
  try {
    const j = JSON.parse(text) as { error?: string; message?: string };
    if (j.error) code = j.error;
    if (j.message) message = j.message;
    else if (j.error) message = j.error;
  } catch {
    /* not JSON */
  }
  return new ApiError(status, code, message);
}

export function streamSSE(opts: StreamOptions): StreamHandle {
  const g = globalThis as { XMLHttpRequest?: typeof XMLHttpRequest; ReadableStream?: unknown };
  if (typeof g.XMLHttpRequest === 'function') return viaXHR(opts, g.XMLHttpRequest);
  if (typeof fetch === 'function' && g.ReadableStream) return viaFetch(opts);
  return { done: Promise.reject(new ApiError(0, 'unsupported', '此环境不支持流式响应')), abort: () => undefined };
}

function viaXHR(opts: StreamOptions, XHR: typeof XMLHttpRequest): StreamHandle {
  const xhr = new XHR();
  const parser = new SSEParser();
  let seen = 0;
  let settled = false;
  const done = new Promise<void>((resolve, reject) => {
    const pump = () => {
      let text = '';
      try {
        text = xhr.responseText ?? '';
      } catch {
        return; // responseText not readable yet on some engines
      }
      if (text.length > seen) {
        const chunk = text.slice(seen);
        seen = text.length;
        for (const ev of parser.push(chunk)) opts.onEvent(ev);
      }
    };
    xhr.open(opts.method ?? 'POST', opts.url, true);
    xhr.responseType = 'text';
    for (const [k, v] of Object.entries(opts.headers ?? {})) xhr.setRequestHeader(k, v);
    xhr.onprogress = () => {
      if (xhr.status >= 200 && xhr.status < 300) pump();
    };
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 4 || settled) return;
      settled = true;
      if (xhr.status >= 200 && xhr.status < 300) {
        pump();
        for (const ev of parser.end()) opts.onEvent(ev);
        resolve();
      } else if (xhr.status === 0) {
        reject(new ApiError(0, 'network', '无法连接服务器'));
      } else {
        let text = '';
        try {
          text = xhr.responseText ?? '';
        } catch {
          /* ignore */
        }
        reject(httpError(xhr.status, text));
      }
    };
    xhr.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new ApiError(0, 'network', '无法连接服务器'));
    };
    xhr.onabort = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    xhr.send(opts.body === undefined ? null : JSON.stringify(opts.body));
  });
  return { done, abort: () => xhr.abort() };
}

function viaFetch(opts: StreamOptions): StreamHandle {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const done = (async () => {
    let res: Response;
    try {
      res = await fetch(opts.url, {
        method: opts.method ?? 'POST',
        headers: opts.headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctrl?.signal,
      });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      throw new ApiError(0, 'network', '无法连接服务器');
    }
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''));
    const parser = new SSEParser();
    if (!res.body) {
      for (const ev of [...parser.push(await res.text()), ...parser.end()]) opts.onEvent(ev);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done: fin } = await reader.read();
      if (fin) break;
      for (const ev of parser.push(dec.decode(value, { stream: true }))) opts.onEvent(ev);
    }
    for (const ev of parser.end()) opts.onEvent(ev);
  })();
  return { done, abort: () => ctrl?.abort() };
}
