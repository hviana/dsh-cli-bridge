import { describe, expect, it, vi } from 'vitest';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { Config } from '../../src/config.ts';
import {
  adviceTarget,
  type LlmPort,
  modelAdvisor,
} from '../../src/runtime/advisor.ts';
import type { AdviceRequest } from '../../src/domain/advice.ts';

const advisorConfig = new Config({}).autonomy.advisor;

const request: AdviceRequest = {
  topic: 'decide',
  system: 'be an arbiter',
  prompt: 'the question',
};
const target = { provider: 'deepseek-official', model: 'deepseek-v4' };

/** A model that replies with the given chunks. */
function fakeLlm(
  chunks: readonly StreamChunk[],
  options: { hold?: boolean; fail?: Error } = {},
) {
  const calls: GenerateOptions[] = [];
  const llm: LlmPort = {
    stream(generate: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(generate);
      return {
        async *[Symbol.asyncIterator]() {
          if (options.fail !== undefined) throw options.fail;
          for (const chunk of chunks) yield chunk;
          if (options.hold === true) {
            // Never completes on its own: the caller's bounds must end it.
            await new Promise<void>((resolve) => {
              generate.signal?.addEventListener('abort', () => resolve(), {
                once: true,
              });
            });
          }
        },
      };
    },
  };
  return { llm, calls };
}

const text = (value: string): StreamChunk => ({
  type: 'text-delta',
  index: 0,
  text: value,
});

describe('consulting the model', () => {
  it('joins the prose it streamed back', async () => {
    const { llm } = fakeLlm([text('{"answer":'), text('"keep it"}')]);
    expect(await modelAdvisor(llm, advisorConfig).consult(request, target))
      .toEqual({ text: '{"answer":"keep it"}' });
  });

  it('asks on the route and model it was given', async () => {
    const { llm, calls } = fakeLlm([text('ok')]);
    await modelAdvisor(llm, advisorConfig).consult(request, target);
    expect(calls[0]).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4',
      system: 'be an arbiter',
    });
  });

  it('sends exactly one user message carrying the prompt', async () => {
    const { llm, calls } = fakeLlm([text('ok')]);
    await modelAdvisor(llm, advisorConfig).consult(request, target);
    expect(calls[0]?.messages).toHaveLength(1);
    expect(calls[0]?.messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'the question' }],
    });
  });

  it('imposes NO output budget of its own', async () => {
    // A decision can require reading the project first, and on a reasoning model
    // the output budget covers that thinking. Any cap the plugin picked would be
    // a guess about how much thought the question deserves — and too small a
    // guess yields no answer at all, not a shorter one.
    const { llm, calls } = fakeLlm([text('ok')]);
    await modelAdvisor(llm, advisorConfig).consult(request, target);
    expect(advisorConfig.maxTokens).toBeUndefined();
    expect(calls[0]).not.toHaveProperty('maxTokens');
  });

  it('passes a ceiling a deployment actually configured', async () => {
    const capped = new Config({ autonomy: { advisor: { maxTokens: 512 } } })
      .autonomy.advisor;
    const { llm, calls } = fakeLlm([text('ok')]);
    await modelAdvisor(llm, capped).consult(request, target);
    expect(calls[0]?.maxTokens).toBe(512);
  });

  it('ignores the model’s reasoning and keeps its conclusion', async () => {
    const { llm } = fakeLlm([
      { type: 'reasoning-delta', index: 0, text: 'hmm, the alias…' },
      text('{"answer":"keep it"}'),
    ]);
    expect(await modelAdvisor(llm, advisorConfig).consult(request, target))
      .toEqual({ text: '{"answer":"keep it"}' });
  });

  it('stops on the caller’s signal — a user direction arriving', async () => {
    const { llm, calls } = fakeLlm([text('partial')], { hold: true });
    const control = new AbortController();
    const consulting = modelAdvisor(llm, advisorConfig).consult(
      request,
      target,
      control.signal,
    );
    control.abort();
    expect(await consulting).toMatchObject({ text: 'partial' });
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it('does not even ask when the decision was already overtaken', async () => {
    const { llm, calls } = fakeLlm([text('too late')], { hold: true });
    const control = new AbortController();
    control.abort();
    expect(
      await modelAdvisor(llm, advisorConfig).consult(
        request,
        target,
        control.signal,
      ),
    ).toEqual({ text: '' });
    expect(calls).toEqual([]);
  });

  it('stops at its own deadline', async () => {
    vi.useFakeTimers();
    try {
      const { llm, calls } = fakeLlm([], { hold: true });
      const consulting = modelAdvisor(llm, {
        ...advisorConfig,
        timeoutMs: 1000,
      }).consult(request, target);
      await vi.advanceTimersByTimeAsync(1001);
      await consulting;
      expect(calls[0]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks a silence timeout distinctly from a caller abort', async () => {
    // A consultation the deadline itself cut off and one the caller abandoned
    // both come back empty, but they want opposite remedies — only the deadline
    // means "the arbiter needs more time to think". The finish reason is what
    // lets the loop say which one happened.
    vi.useFakeTimers();
    try {
      const { llm } = fakeLlm([], { hold: true });
      const consulting = modelAdvisor(llm, {
        ...advisorConfig,
        timeoutMs: 1000,
      }).consult(request, target);
      await vi.advanceTimersByTimeAsync(1001);
      expect(await consulting).toEqual({ text: '', finish: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not claim a timeout for a caller abort', async () => {
    const { llm } = fakeLlm([text('partial')], { hold: true });
    const control = new AbortController();
    const consulting = modelAdvisor(llm, advisorConfig).consult(
      request,
      target,
      control.signal,
    );
    control.abort();
    expect(await consulting).toEqual({ text: 'partial' });
  });

  it('propagates a model failure, which the loop treats as no advice', async () => {
    const { llm } = fakeLlm([], { fail: new Error('no adapter') });
    await expect(modelAdvisor(llm, advisorConfig).consult(request, target))
      .rejects.toThrow('no adapter');
  });
});

describe('adviceTarget', () => {
  it('defaults to the calling session’s own route and model', () => {
    expect(
      adviceTarget(advisorConfig, {
        provider: 'deepseek-official',
        model: 'deepseek-v4',
      }),
    )
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-v4' });
  });

  it('lets configuration override either half', () => {
    expect(
      adviceTarget({ ...advisorConfig, model: 'cheap-judge' }, {
        provider: 'p',
        model: 'expensive',
      }),
    )
      .toEqual({ provider: 'p', model: 'cheap-judge' });
    expect(
      adviceTarget({ ...advisorConfig, provider: 'other' }, {
        provider: 'p',
        model: 'm',
      }),
    )
      .toEqual({ provider: 'other', model: 'm' });
  });

  it('works with no session at all when both halves are configured', () => {
    expect(
      adviceTarget({ ...advisorConfig, provider: 'p', model: 'm' }, undefined),
    ).toEqual({ provider: 'p', model: 'm' });
  });

  it.each([
    ['no session and no configuration', undefined],
    ['a session with no route', { model: 'm' }],
    ['a session with no model', { provider: 'p' }],
    ['a session with empty strings', { provider: '', model: '' }],
  ])('reports %s as unusable, so nothing is consulted', (_label, session) => {
    expect(adviceTarget(advisorConfig, session)).toBeUndefined();
  });
});

describe('adviceTarget: where a decision runs', () => {
  const none = new Config({}).autonomy.advisor;

  it('falls back to the composition default, which is the ordinary case', () => {
    // An agent created without an explicit model carries empty options, so the
    // first two sources are blank in a standard deployment. Without this source
    // every autonomy switch became a no-op that still asked the human.
    expect(
      adviceTarget(none, undefined, {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      }),
    ).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  });

  it('prefers the session over the default, and config over both', () => {
    const fallback = { provider: 'fallback-route', model: 'fallback-model' };
    expect(
      adviceTarget(
        none,
        { provider: 'session-route', model: 'session-model' },
        fallback,
      ),
    ).toEqual({ provider: 'session-route', model: 'session-model' });
    expect(
      adviceTarget(
        { ...none, provider: 'configured', model: 'configured-model' },
        { provider: 'session-route', model: 'session-model' },
        fallback,
      ),
    ).toEqual({ provider: 'configured', model: 'configured-model' });
  });

  it('lets configuration override one half of a whole route', () => {
    // Naming one half in `autonomy.advisor` is a deployment instructing this
    // explicitly — "arbitrate on that provider", "on that model" — so it is the
    // one place halves may be combined.
    const base = { provider: 'session-route', model: 'session-model' };
    expect(adviceTarget({ ...none, model: 'cheap' }, base)).toEqual({
      provider: 'session-route',
      model: 'cheap',
    });
    expect(adviceTarget({ ...none, provider: 'other' }, base)).toEqual({
      provider: 'other',
      model: 'session-model',
    });
  });

  it('never combines halves of two different sources', () => {
    // The session naming only a provider and the composition naming only a
    // model used to compose `session-route/fallback-model` — a route neither
    // source ever offered, which fails at the request and reads from outside as
    // autonomy that works only sometimes.
    expect(
      adviceTarget(none, { provider: 'session-route' }, {
        model: 'fallback-model',
      }),
    ).toBeUndefined();
    expect(
      adviceTarget(none, { provider: 'session-route' }, {
        provider: 'fallback-route',
        model: 'fallback-model',
      }),
    ).toEqual({ provider: 'fallback-route', model: 'fallback-model' });
  });

  it('names nothing when no source does', () => {
    expect(adviceTarget(none, undefined, undefined)).toBeUndefined();
    expect(adviceTarget(none, { provider: 'route' }, {})).toBeUndefined();
    expect(adviceTarget(none, {}, { model: 'model-only' })).toBeUndefined();
    expect(
      adviceTarget(none, { provider: '', model: '' }, {
        provider: '',
        model: '',
      }),
    )
      .toBeUndefined();
  });
});

describe('why an answer never arrived', () => {
  it('reports the finish reason, so an empty answer can explain itself', async () => {
    // A reasoning model spends the output budget thinking BEFORE it says
    // anything, so too small a cap yields no prose at all. Without the finish
    // reason that is indistinguishable from a model with nothing to say — and
    // the two want opposite responses.
    const { llm } = fakeLlm([
      { type: 'reasoning-delta', index: 0, text: 'weighing the options…' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]);
    expect(await modelAdvisor(llm, advisorConfig).consult(request, target))
      .toEqual({ text: '', finish: 'max-tokens' });
  });

  it('reports a plain stop with an answer, which needs no remedy', async () => {
    const { llm } = fakeLlm([
      text('keep it'),
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
    expect(await modelAdvisor(llm, advisorConfig).consult(request, target))
      .toEqual({ text: 'keep it', finish: 'stop' });
  });
});

describe('the bound is silence, not duration', () => {
  it('never cuts off a consultation that is still producing', async () => {
    // The decision may require reading the project before it can be made. A
    // total wall-clock deadline would discard the whole consultation exactly
    // when the question was hard enough to need the time; only silence is a
    // symptom of anything being wrong.
    const bound = new Config({ autonomy: { advisor: { timeoutMs: 1000 } } })
      .autonomy.advisor;
    const slowButBusy: LlmPort = {
      stream(): AsyncIterable<StreamChunk> {
        return {
          async *[Symbol.asyncIterator]() {
            // Five gaps of 600ms: three seconds in total, and never 1000ms of
            // silence. Sequential by nature — a stream arrives one chunk at a
            // time, which is the whole point of the test.
            /* oxlint-disable eslint/no-await-in-loop */
            for (const part of ['stu', 'dy', 'ing', ' the', ' project']) {
              await new Promise((resolve) => setTimeout(resolve, 600));
              yield { type: 'text-delta', index: 0, text: part };
            }
            /* oxlint-enable eslint/no-await-in-loop */
          },
        };
      },
    };
    expect(await modelAdvisor(slowButBusy, bound).consult(request, target))
      .toEqual({ text: 'studying the project' });
  }, 15_000);

  it('still ends a consultation that has gone quiet', async () => {
    const bound = new Config({ autonomy: { advisor: { timeoutMs: 1000 } } })
      .autonomy.advisor;
    // Says one thing, then hangs: the delegation must not be held open by it.
    const { llm } = fakeLlm([text('partial')], { hold: true });
    expect(await modelAdvisor(llm, bound).consult(request, target))
      .toMatchObject({ text: 'partial' });
  }, 15_000);
});
