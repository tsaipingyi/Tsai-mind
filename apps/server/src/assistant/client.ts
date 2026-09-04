/**
 * The narrow slice of the Anthropic SDK the server uses, behind an interface so tests can inject a
 * scripted fake (`scriptedClient`). The real implementation streams through `client.beta.messages.stream`
 * with adaptive thinking and server-side refusal fallbacks (`fallbacks: "default"`).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlock, BetaMessage, BetaMessageParam, BetaTextBlockParam, BetaToolUnion, MessageCreateParamsBase } from '@anthropic-ai/sdk/resources/beta/messages/messages';

export type { BetaContentBlock, BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaTextBlockParam, BetaTool, BetaToolResultBlockParam, BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';

/** The beta header that gates `fallbacks: "default"` (scalar form). */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface ClaudeRequest {
  model: string;
  max_tokens: number;
  system?: string | BetaTextBlockParam[];
  messages: BetaMessageParam[];
  tools?: BetaToolUnion[];
  effort?: 'low' | 'medium' | 'high';
}

export interface ClaudeClient {
  /** Stream one message; `onText` receives every text delta. Resolves with the complete message. */
  stream(req: ClaudeRequest, onText: (delta: string) => void): Promise<BetaMessage>;
  /** Non-streaming request (short outputs such as the weekly digest). */
  create(req: ClaudeRequest): Promise<BetaMessage>;
}

function toParams(req: ClaudeRequest): MessageCreateParamsBase & { betas: string[] } {
  return {
    model: req.model,
    max_tokens: req.max_tokens,
    ...(req.system !== undefined ? { system: req.system } : {}),
    messages: req.messages,
    ...(req.tools && req.tools.length ? { tools: req.tools } : {}),
    thinking: { type: 'adaptive' },
    ...(req.effort ? { output_config: { effort: req.effort } } : {}),
    fallbacks: 'default',
    betas: [FALLBACK_BETA],
  };
}

export function anthropicClient(opts: { apiKey: string }): ClaudeClient {
  const client = new Anthropic({ apiKey: opts.apiKey });
  return {
    async stream(req, onText) {
      const stream = client.beta.messages.stream(toParams(req));
      stream.on('text', (delta) => onText(delta));
      return stream.finalMessage();
    },
    async create(req) {
      return client.beta.messages.create({ ...toParams(req), stream: false });
    },
  };
}

// ---------- test fake ----------

export type ScriptedTurn = BetaContentBlock[] | ((req: ClaudeRequest) => BetaContentBlock[]);

export interface ScriptedClient extends ClaudeClient {
  /** Every request received, in order. */
  requests: ClaudeRequest[];
}

/** A fake client that answers with the scripted content blocks, one turn per call, and streams text in chunks. */
export function scriptedClient(turns: ScriptedTurn[]): ScriptedClient {
  const requests: ClaudeRequest[] = [];
  let i = 0;
  const next = (req: ClaudeRequest): BetaMessage => {
    requests.push(structuredClone(req)); // snapshot: the loop keeps mutating `messages`
    const turn = turns[i++];
    if (!turn) throw new Error(`scripted client: no response scripted for request #${i}`);
    const content = typeof turn === 'function' ? turn(req) : turn;
    const stop_reason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    return {
      id: `msg_scripted_${i}`,
      type: 'message',
      role: 'assistant',
      model: req.model,
      content,
      stop_reason,
      stop_sequence: null,
      stop_details: null,
      container: null,
      context_management: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, server_tool_use: null, service_tier: null, iterations: null, output_tokens_details: null },
    } as unknown as BetaMessage;
  };
  return {
    requests,
    async stream(req, onText) {
      const msg = next(req);
      for (const b of msg.content) {
        if (b.type !== 'text') continue;
        for (const chunk of b.text.match(/[\s\S]{1,6}/g) ?? []) onText(chunk);
      }
      return msg;
    },
    async create(req) {
      return next(req);
    },
  };
}

/** Plain text of a message (text blocks joined). */
export function textOf(msg: BetaMessage): string {
  return msg.content
    .filter((b): b is Extract<BetaContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
