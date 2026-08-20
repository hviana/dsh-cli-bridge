import { describe, expect, it } from 'vitest';
import {
  classifyOutcome,
  type OutcomeInput,
} from '../../src/domain/outcome.ts';
import {
  DEFAULT_DIRECTION_MARKER,
  DEFAULT_NEXT_STEPS_MARKER,
} from '../../src/domain/markers.ts';

const base: OutcomeInput = {
  state: { finalMessage: 'Done.' },
  exitCode: 0,
  signal: null,
  cancelled: false,
  timedOut: false,
  durationMs: 1234,
  markers: { direction: DEFAULT_DIRECTION_MARKER },
  summaryMaxBytes: 8192,
  errorMaxBytes: 2048,
  stderr: '',
};

const classify = (patch: Partial<OutcomeInput> = {}) =>
  classifyOutcome({ ...base, ...patch });

describe('classifyOutcome', () => {
  it('reports a clean run as completed', () => {
    expect(classify()).toEqual({
      status: 'completed',
      summary: 'Done.',
      durationMs: 1234,
      exitCode: 0,
    });
  });

  it('reports a marked question as needing direction', () => {
    const outcome = classify({
      state: {
        finalMessage:
          `Renamed it.\n${DEFAULT_DIRECTION_MARKER} Keep the alias?`,
      },
    });
    expect(outcome.status).toBe('needs_direction');
    expect(outcome.summary).toBe('Renamed it.');
    expect(outcome.question).toBe('Keep the alias?');
  });

  it('carries the delegate usage through, and never anything larger', () => {
    const usage = { inputTokens: 10, outputTokens: 2, costUsd: 0.01 };
    expect(classify({ state: { finalMessage: 'ok', usage } }).usage).toEqual(
      usage,
    );
  });

  it('bounds the summary', () => {
    const outcome = classify({
      state: { finalMessage: 'x'.repeat(10_000) },
      summaryMaxBytes: 512,
    });
    expect(outcome.summary.length).toBeLessThanOrEqual(512);
    expect(outcome.summary).toContain('truncated');
  });
});

describe('declared remaining work', () => {
  it('is reported when the contract stated the marker', () => {
    const outcome = classify({
      state: {
        finalMessage:
          `Step one done.\n${DEFAULT_NEXT_STEPS_MARKER} wire the router`,
      },
      markers: {
        direction: DEFAULT_DIRECTION_MARKER,
        nextSteps: DEFAULT_NEXT_STEPS_MARKER,
      },
    });
    expect(outcome).toMatchObject({
      status: 'completed',
      summary: 'Step one done.',
      nextSteps: 'wire the router',
    });
  });

  it('stays in the summary when the contract did not state the marker', () => {
    const outcome = classify({
      state: {
        finalMessage:
          `Step one done.\n${DEFAULT_NEXT_STEPS_MARKER} wire the router`,
      },
    });
    expect(outcome.nextSteps).toBeUndefined();
    expect(outcome.summary).toContain('wire the router');
  });

  it('is reported beside a question', () => {
    const outcome = classify({
      state: {
        finalMessage:
          `Did it.\n${DEFAULT_NEXT_STEPS_MARKER} docs\n${DEFAULT_DIRECTION_MARKER} which format?`,
      },
      markers: {
        direction: DEFAULT_DIRECTION_MARKER,
        nextSteps: DEFAULT_NEXT_STEPS_MARKER,
      },
    });
    expect(outcome).toMatchObject({
      status: 'needs_direction',
      question: 'which format?',
      nextSteps: 'docs',
    });
  });
});

describe('classifyOutcome precedence', () => {
  it('puts cancellation first', () => {
    const outcome = classify({
      cancelled: true,
      exitCode: 143,
      state: { finalMessage: `partial\n${DEFAULT_DIRECTION_MARKER} what now?` },
    });
    expect(outcome.status).toBe('cancelled');
    expect(outcome.question).toBeUndefined();
    expect(outcome.summary).toBe('partial');
  });

  it('puts failure ahead of a question, because an answer could not be acted on', () => {
    const outcome = classify({
      exitCode: 1,
      state: { finalMessage: `broke\n${DEFAULT_DIRECTION_MARKER} retry?` },
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.question).toBeUndefined();
  });

  it('treats a timeout as a failure even though it cancels the process', () => {
    const outcome = classify({
      cancelled: true,
      timedOut: true,
      durationMs: 60_000,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('timed out after 60000ms');
  });
});

describe('classifyOutcome failure reasons', () => {
  it('prefers the delegate’s own report', () => {
    expect(
      classify({
        exitCode: 1,
        state: { failure: 'credit exhausted' },
        stderr: 'noise',
      }).error,
    )
      .toBe('credit exhausted');
  });

  it('reports a signal death', () => {
    expect(classify({ exitCode: null, signal: 'SIGKILL' }).error).toBe(
      'terminated by SIGKILL',
    );
  });

  it('quotes stderr behind a non-zero exit code', () => {
    expect(
      classify({ exitCode: 2, stderr: '  ENOENT: claude not found  ' }).error,
    )
      .toBe('exited with code 2: ENOENT: claude not found');
  });

  it('reports a bare exit code when stderr said nothing', () => {
    expect(classify({ exitCode: 2 }).error).toBe('exited with code 2');
  });

  it('bounds the error', () => {
    const outcome = classify({
      exitCode: 2,
      stderr: 'y'.repeat(10_000),
      errorMaxBytes: 256,
    });
    expect(outcome.error?.length).toBeLessThanOrEqual(256);
  });

  it('treats a silent clean exit as a failure the caller can act on', () => {
    expect(classify({ state: {} })).toMatchObject({
      status: 'failed',
      error: 'the delegate produced no final message',
      summary: '',
    });
  });

  it('does not invent a failure for a cancelled silent run', () => {
    expect(classify({ state: {}, cancelled: true }).status).toBe('cancelled');
  });
});
