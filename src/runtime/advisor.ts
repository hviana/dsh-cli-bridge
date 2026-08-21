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

/** What one consultation produced, and how the model stopped producing it. */
export interface AdviceReply {
  /** The prose the model concluded with; empty when it never got that far. */
  readonly text: string;
  /**
   * Why generation stopped, when the adapter reported it.
   *
   * Kept because an EMPTY answer is otherwise unexplainable, and the two causes
   * call for opposite responses from whoever reads it: `max-tokens` means the
   * budget was spent — on a reasoning model, usually spent thinking — and wants
   * a bigger `autonomy.advisor.maxTokens`, while `stop` means the model genuinely
   * had nothing to say.
   */
  readonly finish?: string;
}

/** One decision, asked and answered. */
export interface AdvisorPort {
  /**
   * Put one consultation to the model.
   * @param request - the prepared prompt.
   * @param target - the route and model to ask.
   * @param signal - cancellation, including a user direction arriving.
   * @returns the model's reply, and how it stopped.
   */
  consult(
    request: AdviceRequest,
    target: AdviceTarget,
    signal?: AbortSignal,
  ): Promise<AdviceReply>;
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
    ): Promise<AdviceReply> {
      // A decision that was already overtaken — by a user direction, or by the
      // caller giving up — is not worth a model request at all, and an adapter
      // handed a pre-aborted signal has no event left to react to.
      if (signal?.aborted === true) return { text: '' };
      const control = new AbortController();
      const abort = (): void => {
        control.abort();
      };
      signal?.addEventListener('abort', abort, { once: true });

      // The bound is on SILENCE, not on duration: every chunk pushes the
      // deadline out, so a consultation that has to read the project before it
      // can answer is never cut off for taking the time that took — while one
      // that hangs still releases the delegation.
      let idle = setTimeout(abort, config.timeoutMs);
      idle.unref?.();
      const progressed = (): void => {
        clearTimeout(idle);
        idle = setTimeout(abort, config.timeoutMs);
        idle.unref?.();
      };

      try {
        const stream = llm.stream({
          provider: target.provider,
          model: target.model,
          system: request.system,
          messages: [oneShot(request.prompt)],
          // Absent unless a deployment asked for a ceiling: the model uses what
          // its provider allows, because a decision is not always a sentence and
          // this plugin cannot know how much thought the question deserves.
          ...config.maxTokens === undefined
            ? {}
            : { maxTokens: config.maxTokens },
          signal: control.signal,
        });
        // Only prose is an answer: reasoning deltas are the model thinking, and
        // a decision is what it concluded. The finish reason is kept anyway, so
        // an answer that never arrived can say why instead of reading as
        // indifference.
        return await drain(stream, control.signal, progressed);
      } finally {
        clearTimeout(idle);
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
 * @param onChunk - called per chunk, so the caller can reset its idle bound.
 * @returns the prose it concluded with, and how it stopped.
 */
async function drain(
  stream: AsyncIterable<StreamChunk>,
  signal: AbortSignal,
  onChunk: () => void,
): Promise<AdviceReply> {
  const iterator = stream[Symbol.asyncIterator]();
  const parts: string[] = [];
  let finish: string | undefined;
  try {
    // A stream is read one chunk at a time by definition.
    /* oxlint-disable eslint/no-await-in-loop */
    while (!signal.aborted) {
      const next = await Promise.race([
        iterator.next(),
        aborted(signal).then(() => 'stop' as const),
      ]);
      if (next === 'stop' || next.done === true) break;
      onChunk();
      const chunk = next.value;
      if (chunk.type === 'text-delta') parts.push(chunk.text);
      if (chunk.type === 'finish') finish = chunk.reason.kind;
    }
    /* oxlint-enable eslint/no-await-in-loop */
  } finally {
    // Tell the adapter nobody is reading any more; a generator that ignores it
    // is already detached from this decision.
    void iterator.return?.(undefined);
  }
  return {
    text: parts.join(''),
    ...finish === undefined ? {} : { finish },
  };
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
 * Three sources, each half resolved independently, best-first:
 *
 * 1. CONFIGURATION, for a deployment that wants a cheaper or stricter arbiter;
 * 2. the calling session's own route — the model that delegated the work is the
 *    one that arbitrates it;
 * 3. the composition's DEFAULT route.
 *
 * The third source is not a nicety. An agent created without an explicit model
 * carries empty options, which is the ordinary case, so the first two sources
 * are both blank in a standard deployment — and a target that cannot be named is
 * a target that cannot be consulted, which silently turned every autonomy switch
 * into a no-op that still asked the human.
 * @param config - the advisor configuration.
 * @param session - the calling agent's own route and model, when it has one.
 * @param fallback - the composition's default route, when it has one.
 * @returns the target, or `undefined` when no route can be determined.
 */
export function adviceTarget(
  config: AdvisorConfig,
  session:
    | { provider?: string | undefined; model?: string | undefined }
    | undefined,
  fallback?:
    | {
      readonly provider?: string | undefined;
      readonly model?: string | undefined;
    }
    | undefined,
): AdviceTarget | undefined {
  const provider = firstNamed(
    config.provider,
    session?.provider,
    fallback?.provider,
  );
  const model = firstNamed(config.model, session?.model, fallback?.model);
  return provider === undefined || model === undefined
    ? undefined
    : { provider, model };
}

/**
 * The first candidate that actually names something.
 * @param candidates - the sources, best-first.
 * @returns the first non-empty value, or `undefined` when none names anything.
 */
function firstNamed(
  ...candidates: readonly (string | undefined)[]
): string | undefined {
  return candidates.find((candidate): candidate is string =>
    candidate !== undefined && candidate.length > 0
  );
}
