import { describe, expect, it } from 'vitest';
import { SSEParser, parseSSE } from './sse';

const stream = ['event: text', 'data: {"delta":"你好"}', '', 'event: tool', 'data: {"name":"update_node","input":{},"result":{"status":"pending"}}', '', 'event: done', 'data: {"messageId":"m1","text":"你好"}', '', ''].join('\n');

describe('SSEParser', () => {
  it('parses a complete stream', () => {
    const evs = parseSSE(stream);
    expect(evs.map((e) => e.event)).toEqual(['text', 'tool', 'done']);
    expect(JSON.parse(evs[0]!.data)).toEqual({ delta: '你好' });
    expect(JSON.parse(evs[2]!.data).messageId).toBe('m1');
  });

  it('yields the same events regardless of chunk boundaries', () => {
    for (const size of [1, 3, 7, 16, 1000]) {
      const p = new SSEParser();
      const out = [];
      for (let i = 0; i < stream.length; i += size) out.push(...p.push(stream.slice(i, i + size)));
      out.push(...p.end());
      expect(out).toEqual(parseSSE(stream));
    }
  });

  it('handles CRLF, comments, multi-line data and ids', () => {
    const p = new SSEParser();
    const evs = p.push(': keep-alive\r\nid: 7\r\nevent: text\r\ndata: a\r\ndata: b\r\n\r\n');
    expect(evs).toEqual([{ event: 'text', data: 'a\nb', id: '7' }]);
  });

  it('defaults the event name to message and strips one leading space only', () => {
    const evs = parseSSE('data:  two spaces\n\n');
    expect(evs).toEqual([{ event: 'message', data: ' two spaces' }]);
  });

  it('flushes a trailing event without a final blank line', () => {
    const p = new SSEParser();
    expect(p.push('event: done\ndata: {"x":1}')).toEqual([]);
    expect(p.end()).toEqual([{ event: 'done', data: '{"x":1}' }]);
    expect(p.end()).toEqual([]);
  });

  it('waits for the second half of a split CRLF', () => {
    const p = new SSEParser();
    expect(p.push('data: x\r')).toEqual([]);
    expect(p.push('\n\r\n')).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('ignores blank lines with no pending fields', () => {
    expect(parseSSE('\n\n\n')).toEqual([]);
  });
});
