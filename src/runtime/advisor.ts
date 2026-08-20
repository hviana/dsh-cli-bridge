/**
 * The bounded model request behind an autonomous decision.
 *
 * This is what "DeepSeek decides" means concretely: ONE one-shot request on the
 * session's own route, carrying only the facts the decision needs, capped in
 * output and in time. It is not a turn — nothing here touches the session log,
 * the context window, or the agent loop — so an autonomous delegation still
 * costs the caller a single tool result plus a few hundred tokens per decision.
 *
 * @module dsh-cli-bridge/runtime/advisor
 */
import { MessageId } from '@deepseek-ai/dsh-llm';
import type {
  GenerateOptions,
  Message,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { AdviceRequest } from '../domain/advice.ts';
import type { AdvisorConfig } from '../config.ts';

/** Which route and model a consultation runs on. */
export interface AdviceTarget {
  readonly provider: string;
  readonly model: string;
}

/** One decision, asked and answered. */
export interface AdvisorPort {
  /**
   * Put one consultation to the model.
   * @param request - the prepared prompt.
   * @param target - the route and model to ask.
   * @param signal - cancellation, including a user direction arriving.
   * @returns the model's reply text.
   */
  consult(
    request: AdviceRequest,
    target: AdviceTarget,
    signal?: AbortSignal,
  ): Promise<string>;
}

/** The slice of `ctx.llm` a consultation uses. */
export interface LlmPort {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}

/**
 * Build the advisor over a model service.
 * @param llm - the harness model seam.
 * @param config - output and time bounds.
 * @returns the port the delegation loop consults.
 */
export function modelAdvisor(llm: LlmPort, config: AdvisorConfig): AdvisorPort {
  return {
    async consult(
      request: AdviceRequest,
      target: AdviceTarget,
      signal?: AbortSignal,
    ): Promise<string> {
      // A decision that was already overtaken — by a user direction, or by the
      // caller giving up — is not worth a model request at all, and an adapter
      // handed a pre-aborted signal has no event left to react to.
      if (signal?.aborted === true) return '';
      const control = new AbortController();
      const abort = (): void => {
        control.abort();
      };
      signal?.addEventListener('abort', abort, { once: true });
      const deadline = setTimeout(abort, config.timeoutMs);
      deadline.unref?.();

      try {
        const stream = llm.stream({
          provider: target.provider,
          model: target.model,
          system: request.system,
          messages: [oneShot(request.prompt)],
          maxTokens: config.maxTokens,
          signal: control.signal,
        });
        // Only prose is an answer: reasoning deltas are the model thinking, and
        // a decision is what it concluded.
        const parts = await drain(
          stream,
          control.signal,
          (chunk) => (chunk.type === 'text-delta' ? chunk.text : ''),
        );
        return parts;
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}

/**
 * Read a model stream, and stop reading when the signal fires.
 *
 * The bound is enforced HERE rather than left to the adapter: an adapter that
 * only reacts to the abort event — and therefore not to a signal that fired
 * before it started iterating — would otherwise hold the decision open, and a
 * held decision holds the delegation, and the tool call with it.
 * @param stream - the adapter's chunks.
 * @param signal - the deadline and cancellation.
 * @param select - projects each chunk to the text it contributes.
 * @returns everything selected before the stream ended or the signal fired.
 */
async function drain(
  stream: AsyncIterable<StreamChunk>,
  signal: AbortSignal,
  select: (chunk: StreamChunk) => string,
): Promise<string> {
  const iterator = stream[Symbol.asyncIterator]();
  const parts: string[] = [];
  try {
    // A stream is read one chunk at a time by definition.
    /* oxlint-disable eslint/no-await-in-loop */
    while (!signal.aborted) {
      const next = await Promise.race([
        iterator.next(),
        aborted(signal).then(() => 'stop' as const),
      ]);
      if (next === 'stop' || next.done === true) break;
      parts.push(select(next.value));
    }
    /* oxlint-enable eslint/no-await-in-loop */
  } finally {
    // Tell the adapter nobody is reading any more; a generator that ignores it
    // is already detached from this decision.
    void iterator.return?.(undefined);
  }
  return parts.join('');
}

/** Resolves when a signal fires. */
async function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Build the single message of a one-shot consultation.
 *
 * The identity is minted here rather than taken from a session log, because
 * this request belongs to no session: it is a question about somebody else's
 * work, asked and answered outside the conversation entirely.
 * @param prompt - the consultation text.
 * @returns one user-role message.
 */
function oneShot(prompt: string): Message {
  return {
    id: MessageId(
      `cli-bridge-advice-${String(Math.trunc(performance.now() * 1000))}`,
    ),
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  };
}

/**
 * Resolve which route and model a delegation's decisions run on.
 *
 * The default is the calling session's own route — the model that delegated the
 * work is the one that arbitrates it — and configuration overrides either half
 * for a deployment that wants a cheaper or stricter arbiter.
 * @param config - the advisor configuration.
 * @param session - the calling agent's own route and model, when it has one.
 * @returns the target, or `undefined` when no route can be determined.
 */
export function adviceTarget(
  config: AdvisorConfig,
  session:
    | { provider?: string | undefined; model?: string | undefined }
    | undefined,
): AdviceTarget | undefined {
  const provider = config.provider.length > 0
    ? config.provider
    : session?.provider;
  const model = config.model.length > 0 ? config.model : session?.model;
  return provider === undefined || model === undefined ||
      provider.length === 0 || model.length === 0
    ? undefined
    : { provider, model };
}
