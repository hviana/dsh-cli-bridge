import { describe, expect, it } from 'vitest';
import { Config } from '../../src/config.ts';
import type { AutonomyConfig } from '../../src/config.ts';
import {
  applyAdvice,
  applyAnswer,
  nextStep,
  type RoundFacts,
} from '../../src/domain/continuation.ts';
import type { DirectionRecord, RunEnd } from '../../src/shared/protocol.ts';

const OFF: AutonomyConfig = new Config({}).autonomy;
const ON = (patch: Partial<AutonomyConfig>): AutonomyConfig => ({
  ...OFF,
  ...patch,
});

const completed: RunEnd = {
  status: 'completed',
  summary: 'Renamed 3 files.',
  durationMs: 10,
};
const asked: RunEnd = {
  status: 'needs_direction',
  summary: 'Renamed it.',
  question: 'Keep the alias?',
  durationMs: 10,
};

const facts = (patch: Partial<RoundFacts> = {}): RoundFacts => ({
  round: 1,
  end: completed,
  reviews: 0,
  continueJudged: false,
  autonomy: OFF,
  canAskHuman: true,
  canAdvise: true,
  ...patch,
});

const direction = (text: string): DirectionRecord => ({
  id: 'dir-1',
  origin: 'user',
  text,
  at: 0,
});

describe('the default: nothing decides anything', () => {
  it('finishes a completed round', () => {
    expect(nextStep(facts())).toMatchObject({ kind: 'finish' });
  });

  it('asks the human when the delegate needs a decision', () => {
    expect(nextStep(facts({ end: asked }))).toEqual({
      kind: 'ask',
      question: 'Keep the alias?',
      reason: 'the delegate needs a decision and autonomy.decide is off',
    });
  });

  it('returns the question to the caller when no human can be reached', () => {
    expect(nextStep(facts({ end: asked, canAskHuman: false }))).toMatchObject({
      kind: 'finish',
    });
  });

  it('ignores declared remaining work', () => {
    expect(nextStep(facts({ end: { ...completed, nextSteps: 'write docs' } })))
      .toMatchObject({ kind: 'finish' });
  });

  it('does not review', () => {
    expect(nextStep(facts({ autonomy: OFF }))).toMatchObject({
      kind: 'finish',
    });
  });
});

describe('a user direction outranks everything', () => {
  it.each([
    ['a question', asked],
    ['a completion', completed],
    ['declared work', { ...completed, nextSteps: 'more' }],
  ])('overrides %s', (_label, end) => {
    expect(
      nextStep(facts({ end, pendingDirection: direction('use postgres') })),
    ).toEqual({
      kind: 'resume',
      message: 'use postgres',
      source: 'direction',
      reason: 'a user direction was waiting',
    });
  });

  it('overrides the model, even with every autonomy setting on', () => {
    const step = nextStep(facts({
      end: asked,
      autonomy: ON({ decide: true, continue: true, review: true }),
      pendingDirection: direction('use postgres'),
    }));
    expect(step).toMatchObject({ kind: 'resume', source: 'direction' });
  });
});

describe('failures are reported, not answered', () => {
  it.each(['failed', 'cancelled'] as const)('finishes a %s round', (status) => {
    const end: RunEnd = { status, summary: '', durationMs: 1 };
    expect(
      nextStep(facts({ end, autonomy: ON({ decide: true, review: true }) })),
    ).toMatchObject({ kind: 'finish' });
  });

  it('does not answer a question a dead round asked', () => {
    const end: RunEnd = {
      status: 'failed',
      summary: '',
      question: 'which one?',
      durationMs: 1,
    };
    expect(nextStep(facts({ end, autonomy: ON({ decide: true }) })).kind).toBe(
      'finish',
    );
  });
});

describe('the round budget is a hard stop', () => {
  it('finishes at the budget whatever else is true', () => {
    const step = nextStep(facts({
      round: OFF.maxRounds,
      end: asked,
      autonomy: ON({ decide: true, continue: true, review: true }),
    }));
    expect(step).toMatchObject({
      kind: 'finish',
      reason: expect.stringContaining('budget'),
    });
  });

  it('still lets a waiting user direction through', () => {
    const step = nextStep(
      facts({ round: 99, pendingDirection: direction('stop and summarize') }),
    );
    expect(step).toMatchObject({ kind: 'resume', source: 'direction' });
  });
});

describe('autonomy.decide', () => {
  it('consults the model instead of the human', () => {
    expect(nextStep(facts({ end: asked, autonomy: ON({ decide: true }) })))
      .toMatchObject({ kind: 'consult', topic: 'decide' });
  });

  it('falls back to the human when no model can be consulted', () => {
    expect(
      nextStep(
        facts({ end: asked, autonomy: ON({ decide: true }), canAdvise: false }),
      ),
    )
      .toMatchObject({ kind: 'ask' });
  });
});

describe('autonomy.continue', () => {
  const on = ON({ continue: true });

  it('resumes from the marker without consulting anyone', () => {
    expect(
      nextStep(
        facts({ end: { ...completed, nextSteps: 'write docs' }, autonomy: on }),
      ),
    )
      .toMatchObject({
        kind: 'resume',
        source: 'policy',
        message: expect.stringContaining('write docs'),
      });
  });

  it('consults the model when the delegate left no marker', () => {
    expect(nextStep(facts({ autonomy: on }))).toMatchObject({
      kind: 'consult',
      topic: 'continue',
    });
  });

  it('does not consult twice about the same round', () => {
    expect(nextStep(facts({ autonomy: on, continueJudged: true })))
      .toMatchObject({ kind: 'finish' });
  });

  it('finishes rather than looping when no model can be consulted', () => {
    expect(nextStep(facts({ autonomy: on, canAdvise: false }))).toMatchObject({
      kind: 'finish',
    });
  });
});

describe('autonomy.review', () => {
  const on = ON({ review: true });

  it('reviews a finished round', () => {
    expect(nextStep(facts({ autonomy: on }))).toMatchObject({
      kind: 'consult',
      topic: 'review',
    });
  });

  it('stops reviewing at the review budget', () => {
    expect(nextStep(facts({ autonomy: on, reviews: on.maxReviews })))
      .toMatchObject({ kind: 'finish' });
  });

  it('runs after continue has settled the same round', () => {
    const both = ON({ continue: true, review: true });
    expect(nextStep(facts({ autonomy: both, continueJudged: true })))
      .toMatchObject({ kind: 'consult', topic: 'review' });
  });
});

describe('applyAdvice', () => {
  it('resumes with the model’s answer to a question', () => {
    expect(
      applyAdvice(
        { topic: 'decide', answer: 'keep the alias' },
        facts({ end: asked }),
      ),
    ).toEqual({
      kind: 'resume',
      message: 'keep the alias',
      source: 'advisor',
      reason: 'the session model answered',
    });
  });

  it('finishes when the model had no answer', () => {
    expect(
      applyAdvice({ topic: 'decide', answer: '   ' }, facts({ end: asked })),
    ).toMatchObject({ kind: 'finish' });
  });

  it('resumes with the model’s continuation', () => {
    const step = applyAdvice(
      { topic: 'continue', finished: false, instruction: 'add the migration' },
      facts({ autonomy: ON({ continue: true }) }),
    );
    expect(step).toMatchObject({
      kind: 'resume',
      source: 'advisor',
      message: expect.stringContaining('add the migration'),
    });
  });

  it('re-enters the policy when the model says it is finished, so a review still runs', () => {
    const step = applyAdvice(
      { topic: 'continue', finished: true },
      facts({ autonomy: ON({ continue: true, review: true }) }),
    );
    expect(step).toMatchObject({ kind: 'consult', topic: 'review' });
  });

  it('treats "not finished" with no instruction as finished', () => {
    const step = applyAdvice(
      { topic: 'continue', finished: false },
      facts({ autonomy: ON({ continue: true }) }),
    );
    expect(step).toMatchObject({ kind: 'finish' });
  });

  it('resumes with the fixes a review asked for', () => {
    const step = applyAdvice({
      topic: 'review',
      accepted: false,
      fixes: 'the test is missing',
    }, facts());
    expect(step).toMatchObject({
      kind: 'resume',
      source: 'advisor',
      message: expect.stringContaining('test is missing'),
    });
  });

  it('finishes on an accepted review', () => {
    expect(applyAdvice({ topic: 'review', accepted: true }, facts()))
      .toMatchObject({ kind: 'finish' });
  });

  it('finishes when a rejection names no fix', () => {
    expect(applyAdvice({ topic: 'review', accepted: false }, facts()))
      .toMatchObject({ kind: 'finish' });
  });
});

describe('applyAnswer', () => {
  it('resumes with the human’s answer', () => {
    expect(applyAnswer('use postgres')).toEqual({
      kind: 'resume',
      message: 'use postgres',
      source: 'human',
      reason: 'the human answered',
    });
  });

  it('finishes when the human said nothing', () => {
    expect(applyAnswer('  ')).toMatchObject({ kind: 'finish' });
  });
});
