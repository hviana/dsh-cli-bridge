/**
 * Run classification — the one place a finished delegate becomes something
 * DeepSeek is allowed to read.
 *
 * The rule this module exists to enforce: whatever happened during the run, the
 * model receives a bounded summary, an optional question, and an optional error.
 * Never the transcript, never the tool log, never the raw output. That is what
 * keeps a delegated run from being paid for twice — once by the delegate, and
 * again by every subsequent DeepSeek request that would have carried its mirror.
 *
 * @module dsh-cli-bridge/domain/outcome
 */
import type { RunEnd, TerminalRunStatus } from '../shared/protocol.ts';
import type { DecodedState } from './adapters/contract.ts';
import type { ContractMarkers } from './markers.ts';
import { splitMarkers } from './markers.ts';
import { boundHead, boundTail } from './text.ts';

/** Everything known about a run at the moment its process closed. */
export interface OutcomeInput {
  /** Facts the decoder accumulated from the delegate's own event stream. */
  readonly state: DecodedState;
  /** Process exit code; `null` when the process died from a signal. */
  readonly exitCode: number | null;
  /** Terminating signal; `null` on a normal exit. */
  readonly signal: string | null;
  /** Whether the caller cancelled the run. */
  readonly cancelled: boolean;
  /** Whether the run exceeded its deadline. */
  readonly timedOut: boolean;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** The markers this run's contract stated, and is therefore read back through. */
  readonly markers: ContractMarkers;
  /** Byte budget for the summary handed to the model. */
  readonly summaryMaxBytes: number;
  /** Byte budget for an error message derived from stderr. */
  readonly errorMaxBytes: number;
  /** Whatever the delegate wrote to stderr, already tail-bounded by the caller. */
  readonly stderr: string;
}

/**
 * Classify one finished run.
 *
 * Precedence is fixed and total, so the same inputs always produce the same
 * verdict: cancellation, then a timeout, then failure, then a direction
 * request, then success. A delegate that both failed and asked a question
 * failed — an answer to a question the run can no longer act on would waste a
 * turn. A timeout is kept apart from a failure on purpose: the session survives
 * a deadline, so a timeout is a resumable state, not a dead end.
 * @param input - everything known at process close.
 * @returns the terminal facts, bounded and safe to hand to a model.
 */
export function classifyOutcome(input: OutcomeInput): RunEnd {
  const split = splitMarkers(input.state.finalMessage ?? '', input.markers);
  const question = split.direction;
  const base = {
    summary: boundHead(split.body, input.summaryMaxBytes),
    durationMs: input.durationMs,
    ...split.nextSteps === undefined
      ? {}
      : { nextSteps: boundHead(split.nextSteps, input.summaryMaxBytes) },
    ...input.exitCode === null ? {} : { exitCode: input.exitCode },
    ...input.state.usage === undefined ? {} : { usage: input.state.usage },
  };

  if (input.cancelled && !input.timedOut) {
    return { ...base, status: 'cancelled' };
  }

  // A deadline is not a failure of the work: the delegate session is intact on
  // disk and resumable, and whatever the delegate managed to report — its
  // summary, its declared next steps — is preserved below so a continuation
  // can carry on instead of restudying the project from zero.
  if (input.timedOut) {
    return {
      ...base,
      status: 'timed_out',
      error: boundHead(
        `timed out after ${String(input.durationMs)}ms`,
        input.errorMaxBytes,
      ),
    };
  }

  const failure = failureOf(input);
  if (failure !== undefined) {
    return {
      ...base,
      status: 'failed',
      error: boundHead(failure, input.errorMaxBytes),
    };
  }

  const status: TerminalRunStatus = question === undefined
    ? 'completed'
    : 'needs_direction';
  return question === undefined
    ? { ...base, status }
    : { ...base, status, question };
}

/**
 * Derive the failure reason, if the run failed at all.
 *
 * Sources are consulted best-first: the delegate's own in-band report explains
 * the failure better than an exit code, and an exit code better than silence.
 * @param input - everything known at process close.
 * @returns the reason, or `undefined` when the run did not fail.
 */
function failureOf(input: OutcomeInput): string | undefined {
  if (input.state.failure !== undefined) return input.state.failure;
  if (input.signal !== null) return `terminated by ${input.signal}`;
  if (input.exitCode !== null && input.exitCode !== 0) {
    const stderr = boundTail(input.stderr.trim(), input.errorMaxBytes);
    const code = `exited with code ${String(input.exitCode)}`;
    return stderr.length === 0 ? code : `${code}: ${stderr}`;
  }
  // A clean exit that produced no final message is not a failure of the run,
  // but the model would have nothing to act on, so it is reported as one.
  if (input.state.finalMessage === undefined) {
    return 'the delegate produced no final message';
  }
  return undefined;
}
