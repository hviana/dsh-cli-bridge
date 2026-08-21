import { describe, expect, it } from 'vitest';
import {
  type AdviceContext,
  adviceRequest,
  parseAdvice,
} from '../../src/domain/advice.ts';

const context: AdviceContext = {
  task: 'Port the parser to the new AST.',
  directions: ['keep the public API', 'no new dependencies'],
  summary: 'Ported two of three modules.',
  question: 'Should parse() stay as an alias?',
  evidence: {
    files: ['src/parse.ts', 'src/ast.ts'],
    diffstat: ' src/parse.ts | 40 ++--\n 2 files changed',
  },
  maxBytes: 2048,
};

describe('the prompts', () => {
  it.each(['decide', 'continue', 'review'] as const)(
    'carries the task and the directions into a %s',
    (topic) => {
      const request = adviceRequest(topic, context);
      expect(request.topic).toBe(topic);
      expect(request.prompt).toContain('Port the parser to the new AST.');
      expect(request.prompt).toContain('keep the public API');
      expect(request.prompt).toContain('Ported two of three modules.');
    },
  );

  it.each(['decide', 'continue', 'review'] as const)(
    'tells a %s to answer with one JSON object',
    (topic) => {
      const request = adviceRequest(topic, context);
      expect(request.system).toContain('one JSON object');
      expect(request.prompt).toContain('Reply with {"');
    },
  );

  it('says the engineer’s directions outrank the model’s preference', () => {
    expect(adviceRequest('review', context).prompt).toContain('outrank');
  });

  it('carries the question into a decide, and asks for a verbatim answer', () => {
    const prompt = adviceRequest('decide', context).prompt;
    expect(prompt).toContain('Should parse() stay as an alias?');
    expect(prompt).toContain('verbatim');
  });

  it('carries the evidence into a review only', () => {
    expect(adviceRequest('review', context).prompt).toContain('src/parse.ts');
    expect(adviceRequest('review', context).prompt).toContain(
      '2 files changed',
    );
    expect(adviceRequest('continue', context).prompt).not.toContain(
      '2 files changed',
    );
  });

  it('tells a continue to judge only what the report says', () => {
    expect(adviceRequest('continue', context).prompt).toContain(
      'do not invent work',
    );
  });

  it('renders an absent section as (none) rather than an empty heading', () => {
    const bare = adviceRequest('decide', {
      task: 'x',
      directions: [],
      summary: '',
      maxBytes: 512,
    });
    expect(bare.prompt).toContain('(none)');
  });

  it('bounds every section', () => {
    const huge = adviceRequest('review', {
      ...context,
      task: 'x'.repeat(50_000),
      summary: 'y'.repeat(50_000),
      maxBytes: 256,
    });
    expect(huge.prompt.length).toBeLessThan(4000);
  });
});

describe('parseAdvice: decide', () => {
  it('reads the answer', () => {
    expect(parseAdvice('decide', '{"answer":"keep it as an alias"}'))
      .toEqual({ topic: 'decide', answer: 'keep it as an alias' });
  });

  it('finds the object inside prose and a code fence', () => {
    const reply =
      'Sure — here you go:\n```json\n{"answer": "drop it"}\n```\nHope that helps.';
    expect(parseAdvice('decide', reply)).toEqual({
      topic: 'decide',
      answer: 'drop it',
    });
  });

  it('survives a nested object and a brace inside a string', () => {
    const reply = '{"answer":"use {curly} braces","meta":{"why":"because"}}';
    expect(parseAdvice('decide', reply)).toEqual({
      topic: 'decide',
      answer: 'use {curly} braces',
    });
  });

  it('falls back to the raw text, which is still a usable direction', () => {
    expect(parseAdvice('decide', '  keep the alias  ')).toEqual({
      topic: 'decide',
      answer: 'keep the alias',
    });
  });
});

describe('parseAdvice: continue', () => {
  it('reads a continuation', () => {
    expect(
      parseAdvice(
        'continue',
        '{"finished":false,"instruction":"add the migration"}',
      ),
    )
      .toEqual({
        topic: 'continue',
        finished: false,
        instruction: 'add the migration',
      });
  });

  it('reads a completion', () => {
    expect(parseAdvice('continue', '{"finished":true}')).toEqual({
      topic: 'continue',
      finished: true,
    });
  });

  it.each([
    ['an unparseable reply', 'I think it is done?'],
    ['a missing flag', '{"instruction":"do more"}'],
    ['a rejection with no instruction', '{"finished":false}'],
    ['an empty instruction', '{"finished":false,"instruction":"   "}'],
    ['a wrongly typed flag', '{"finished":"no","instruction":"do more"}'],
  ])('resolves %s toward finished, so nothing can loop', (_label, reply) => {
    expect(parseAdvice('continue', reply)).toEqual({
      topic: 'continue',
      finished: true,
    });
  });
});

describe('parseAdvice: review', () => {
  it('reads a rejection', () => {
    expect(
      parseAdvice('review', '{"accepted":false,"fixes":"the test is missing"}'),
    )
      .toEqual({
        topic: 'review',
        accepted: false,
        fixes: 'the test is missing',
      });
  });

  it('reads an acceptance', () => {
    expect(parseAdvice('review', '{"accepted":true}')).toEqual({
      topic: 'review',
      accepted: true,
    });
  });

  it.each([
    ['an unparseable reply', 'looks good to me'],
    ['a rejection with no fixes', '{"accepted":false}'],
    ['an unterminated object', '{"accepted":false,"fixes":"x"'],
  ])('resolves %s toward accepted, so nothing can loop', (_label, reply) => {
    expect(parseAdvice('review', reply)).toEqual({
      topic: 'review',
      accepted: true,
    });
  });

  it('recovers an answer the model wrapped in an array', () => {
    // Extracting a well-formed object is strictly better than discarding it:
    // the conservative fallback is for replies with no answer in them at all.
    expect(parseAdvice('review', '[{"accepted":false,"fixes":"x"}]'))
      .toEqual({ topic: 'review', accepted: false, fixes: 'x' });
  });
});

describe('what the arbiter is shown', () => {
  const long = 'x'.repeat(20_000);
  const big: AdviceContext = {
    task: `Port the parser. ${long}`,
    directions: [`keep the API ${long}`],
    summary: `Ported it. ${long}`,
    question: `Alias? ${long}`,
    evidence: { files: ['src/parse.ts'], diffstat: `${long} 2 files changed` },
  };

  it('shows everything when no ceiling was configured', () => {
    // The arbiter cannot run a command or open a file: it decides from what it
    // is shown. Cutting that down does not make the decision cheaper, it makes
    // it wrong — a review judging a clipped diff, or a decision taken against
    // half of the task it was delegated.
    for (const topic of ['decide', 'continue', 'review'] as const) {
      const { prompt } = adviceRequest(topic, big);
      expect(prompt).not.toContain('truncated');
    }
    const review = adviceRequest('review', big).prompt;
    expect(review).toContain(long);
    const decide = adviceRequest('decide', big).prompt;
    expect(decide.length).toBeGreaterThan(60_000);
  });

  it('honours a ceiling a deployment configured', () => {
    const capped = adviceRequest('review', { ...big, maxBytes: 512 }).prompt;
    expect(capped).toContain('truncated');
    expect(capped.length).toBeLessThan(10_000);
  });

  it('still says (none) for a section with nothing in it', () => {
    const bare = adviceRequest('review', {
      task: 'Do it.',
      directions: [],
      summary: '',
    }).prompt;
    expect(bare).toContain('(none)');
  });
});
