/**
 * One run's live state.
 *
 * Every mutation is a named transition rather than a generic patch, so the
 * snapshot the surfaces read can never be assembled into a shape the protocol
 * does not describe, and every transition publishes exactly one frame.
 *
 * @module dsh-cli-bridge/runtime/run
 */
import type {
  Activity,
  OutputPipe,
  RunEnd,
  RunSnapshot,
  RunStatus,
  RunUsage,
} from '../shared/protocol.ts';
import { isTerminalStatus } from '../shared/protocol.ts';
import { byteLength } from '../domain/text.ts';
import type { StreamHub } from './channel.ts';

/** Live state of one run, and the only writer of its frames. */
export class RunState {
  private current: RunSnapshot;
  private settledEnd: RunEnd | undefined;

  constructor(private readonly hub: StreamHub, initial: RunSnapshot) {
    this.current = initial;
    this.hub.publish(initial.id, { kind: 'snapshot', snapshot: initial });
  }

  /** The current listing projection. */
  get snapshot(): RunSnapshot {
    return this.current;
  }

  /** The terminal facts, once the run has settled. */
  get end(): RunEnd | undefined {
    return this.settledEnd;
  }

  /** Whether the run has settled. */
  get isSettled(): boolean {
    return isTerminalStatus(this.current.status);
  }

  /** The process is up and the delegate is working. */
  markRunning(): void {
    if (this.current.status !== 'starting') return;
    this.replace({ ...this.current, status: 'running' });
  }

  /**
   * Record the delegate's own session identity, which is what a later reply resumes.
   * @param delegateSessionId - the id the delegate reported for itself.
   */
  bindDelegateSession(delegateSessionId: string): void {
    if (this.current.delegateSessionId === delegateSessionId) return;
    this.replace({ ...this.current, delegateSessionId });
  }

  /**
   * Publish raw delegate output and count it.
   *
   * The byte counter is what the UI shows as "streamed"; it is also the number
   * that would have entered the model's context had this plugin mirrored the
   * output instead of streaming it.
   * @param pipe - which of the child's streams produced the text.
   * @param text - the decoded text.
   */
  output(pipe: OutputPipe, text: string): void {
    if (text.length === 0) return;
    this.hub.publish(this.current.id, { kind: 'output', pipe, text });
    // The counter changes constantly; publishing a snapshot per chunk would
    // double the frame rate for a number the settlement frame carries anyway.
    this.current = {
      ...this.current,
      bytes: this.current.bytes + byteLength(text),
    };
  }

  /**
   * Publish one decoded delegate action.
   * @param activity - the action, already normalized by an adapter.
   */
  activity(activity: Activity): void {
    this.hub.publish(this.current.id, { kind: 'activity', activity });
    if (activity.type === 'usage') {
      this.current = { ...this.current, usage: activity.usage };
    }
  }

  /**
   * Settle the run. Idempotent: the first settlement wins, so a late process
   * exit cannot overwrite the cancellation that caused it.
   * @param end - the terminal facts.
   * @param finishedAt - epoch ms of settlement.
   * @returns the settled end, which may be an earlier one.
   */
  finish(end: RunEnd, finishedAt: number): RunEnd {
    if (this.settledEnd !== undefined) return this.settledEnd;
    this.settledEnd = end;
    this.replace({
      ...this.current,
      status: end.status,
      finishedAt,
      ...end.usage === undefined ? {} : { usage: end.usage },
    });
    this.hub.publish(this.current.id, { kind: 'end', end });
    return end;
  }

  /** Merge a usage update reported outside an activity. */
  mergeUsage(usage: RunUsage): void {
    this.current = { ...this.current, usage };
  }

  /** Commit a new snapshot and announce it. */
  private replace(next: RunSnapshot): void {
    this.current = next;
    this.hub.publish(next.id, { kind: 'snapshot', snapshot: next });
  }
}

/** The subset of a snapshot a caller supplies when a run is created. */
export interface RunSeed
  extends Omit<RunSnapshot, 'status' | 'startedAt' | 'bytes' | 'finishedAt'> {
  readonly status?: RunStatus;
}

/**
 * Build the opening snapshot of a run.
 * @param seed - the identity and parameters the caller chose.
 * @param startedAt - epoch ms of registration.
 * @returns the initial snapshot.
 */
export function seedSnapshot(seed: RunSeed, startedAt: number): RunSnapshot {
  return { ...seed, status: seed.status ?? 'starting', startedAt, bytes: 0 };
}
