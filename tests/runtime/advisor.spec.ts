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
      .toBe('{"answer":"keep it"}');
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

  it('caps its own output, because a decision is a sentence', async () => {
    const { llm, calls } = fakeLlm([text('ok')]);
    await modelAdvisor(llm, advisorConfig).consult(request, target);
    expect(calls[0]?.maxTokens).toBe(advisorConfig.maxTokens);
  });

  it('ignores the model’s reasoning and keeps its conclusion', async () => {
    const { llm } = fakeLlm([
      { type: 'reasoning-delta', index: 0, text: 'hmm, the alias…' },
      text('{"answer":"keep it"}'),
    ]);
    expect(await modelAdvisor(llm, advisorConfig).consult(request, target))
      .toBe('{"answer":"keep it"}');
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
    expect(await consulting).toBe('partial');
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
    ).toBe('');
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
