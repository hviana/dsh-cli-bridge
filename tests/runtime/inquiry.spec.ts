import { describe, expect, it, vi } from 'vitest';
import { Config } from '../../src/config.ts';
import {
  userQuestionsInquiry,
  type UserQuestionsPort,
} from '../../src/runtime/inquiry.ts';

const config = new Config({}).inquiry;

/** A question surface that answers, holds, or refuses. */
function fakeQuestions(options: {
  answer?: { id: string; selected: string[]; custom?: string };
  hold?: boolean;
  fail?: Error;
} = {}) {
  const asked: unknown[] = [];
  const questions: UserQuestionsPort = {
    async ask(request) {
      asked.push(request);
      if (options.fail !== undefined) throw options.fail;
      if (options.hold === true) {
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted === true) resolve();
          else {request.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });}
        });
        throw new Error('ASK_ABORTED');
      }
      return {
        answers: [
          options.answer ?? { id: 'd1', selected: [], custom: 'use postgres' },
        ],
      };
    },
  };
  return { questions, asked };
}

const inquiry = {
  delegation: 'd1',
  question: 'Keep the alias?',
  context: 'Renamed the module.',
};

describe('asking the human', () => {
  it('returns the free-text answer', async () => {
    const { questions } = fakeQuestions();
    expect(await userQuestionsInquiry(questions, config).ask(inquiry)).toBe(
      'use postgres',
    );
  });

  it('returns chosen option labels when a UI offered options', async () => {
    const { questions } = fakeQuestions({
      answer: { id: 'd1', selected: ['keep it', 'log it'] },
    });
    expect(await userQuestionsInquiry(questions, config).ask(inquiry)).toBe(
      'keep it, log it',
    );
  });

  it('prefers typed text over a selected label', async () => {
    const { questions } = fakeQuestions({
      answer: { id: 'd1', selected: ['keep it'], custom: 'actually drop it' },
    });
    expect(await userQuestionsInquiry(questions, config).ask(inquiry)).toBe(
      'actually drop it',
    );
  });

  it('carries the question, its context, and the delegation id', async () => {
    const { questions, asked } = fakeQuestions();
    await userQuestionsInquiry(questions, config).ask(inquiry);
    expect(asked[0]).toMatchObject({
      questions: [{
        id: 'd1',
        question: 'Keep the alias?',
        detail: 'Renamed the module.',
      }],
    });
  });

  it('omits an empty context rather than sending a blank detail', async () => {
    const { questions, asked } = fakeQuestions();
    await userQuestionsInquiry(questions, config).ask({
      ...inquiry,
      context: '',
    });
    expect((asked[0] as { questions: Record<string, unknown>[] }).questions[0])
      .not.toHaveProperty('detail');
  });

  it.each([
    ['an empty answer', { id: 'd1', selected: [], custom: '   ' }],
    ['no selection at all', { id: 'd1', selected: [] }],
  ])('reports %s as unanswered', async (_label, answer) => {
    const { questions } = fakeQuestions({ answer });
    expect(await userQuestionsInquiry(questions, config).ask(inquiry))
      .toBeUndefined();
  });

  it('falls back to the first answer when the id does not match', async () => {
    const { questions } = fakeQuestions({
      answer: { id: 'other', selected: [], custom: 'still mine' },
    });
    expect(await userQuestionsInquiry(questions, config).ask(inquiry)).toBe(
      'still mine',
    );
  });
});

describe('when nobody answers', () => {
  it('reports a refused ask as unanswered rather than a failure', async () => {
    const { questions } = fakeQuestions({ fail: new Error('NO_PROVIDER') });
    expect(await userQuestionsInquiry(questions, config).ask(inquiry))
      .toBeUndefined();
  });

  it('stops when a user direction arrives instead', async () => {
    const { questions } = fakeQuestions({ hold: true });
    const control = new AbortController();
    const asking = userQuestionsInquiry(questions, config).ask({
      ...inquiry,
      signal: control.signal,
    });
    control.abort();
    expect(await asking).toBeUndefined();
  });

  it('stops on a signal that already fired', async () => {
    const { questions } = fakeQuestions({ hold: true });
    const control = new AbortController();
    control.abort();
    expect(
      await userQuestionsInquiry(questions, config).ask({
        ...inquiry,
        signal: control.signal,
      }),
    ).toBeUndefined();
  });

  it('waits indefinitely by default, because nothing is being billed', async () => {
    vi.useFakeTimers();
    try {
      const { questions } = fakeQuestions({ hold: true });
      const control = new AbortController();
      const asking = userQuestionsInquiry(questions, config).ask({
        ...inquiry,
        signal: control.signal,
      });
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      let settled = false;
      void asking.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      control.abort();
      await asking;
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up at a configured deadline', async () => {
    vi.useFakeTimers();
    try {
      const { questions } = fakeQuestions({ hold: true });
      const asking = userQuestionsInquiry(questions, {
        ...config,
        timeoutMs: 5000,
      }).ask(inquiry);
      await vi.advanceTimersByTimeAsync(5001);
      expect(await asking).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
