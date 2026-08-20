/**
 * The direction ledger — where a human's word outranks every machine's.
 *
 * A direction is a standing instruction for one delegation. Two rules make it
 * an override rather than a suggestion:
 *
 * 1. the loop consumes a pending USER direction before it consults anyone;
 * 2. adding one CANCELS whatever decision is in flight — the question the human
 *    is being asked, or the model request that was about to answer it.
 *
 * A model-origin direction is recorded for context but never consumed as an
 * override: the model already had its turn through the tool call.
 *
 * @module dsh-cli-bridge/runtime/directions
 */
import type { DelegationId, DirectionRecord } from '../shared/protocol.ts';

/** A wait that a new user direction interrupts. */
export interface DirectionWaiter {
  /** Aborts as soon as a user direction is added for this delegation. */
  readonly signal: AbortSignal;
  /** Whether this waiter is the reason the signal fired. */
  readonly interrupted: () => boolean;
  /** Stop listening. */
  readonly dispose: () => void;
}

/** One delegation's directions and the waits they can interrupt. */
interface Entry {
  readonly records: DirectionRecord[];
  readonly waiters: Set<AbortController>;
}

/** Standing instructions per delegation. */
export class DirectionLedger {
  private readonly entries = new Map<DelegationId, Entry>();
  private counter = 0;

  constructor(private readonly now: () => number) {}

  /**
   * Record a direction, and interrupt any decision in flight for that delegation.
   * @param delegation - the delegation it applies to.
   * @param origin - who supplied it; only `user` acts as an override.
   * @param text - the instruction.
   * @returns the stored record.
   */
  add(
    delegation: DelegationId,
    origin: DirectionRecord['origin'],
    text: string,
  ): DirectionRecord {
    this.counter += 1;
    const record: DirectionRecord = {
      id: `dir-${String(this.counter)}`,
      origin,
      text: text.trim(),
      at: this.now(),
    };
    const entry = this.entryOf(delegation);
    entry.records.push(record);
    if (origin === 'user') {
      // The human has spoken; nothing automatic gets to answer first.
      for (const waiter of entry.waiters) waiter.abort();
      entry.waiters.clear();
    }
    return record;
  }

  /**
   * The oldest user direction the delegate has not been given yet.
   * @param delegation - the delegation to read.
   * @returns the pending record, or `undefined` when there is none.
   */
  pending(delegation: DelegationId): DirectionRecord | undefined {
    return this.entries.get(delegation)?.records
      .find((record) =>
        record.origin === 'user' && record.consumedRound === undefined
      );
  }

  /**
   * Mark a direction as delivered to the delegate.
   * @param delegation - the delegation it belongs to.
   * @param id - the record id.
   * @param round - the round that carried it.
   */
  consume(delegation: DelegationId, id: string, round: number): void {
    const entry = this.entries.get(delegation);
    if (entry === undefined) return;
    const index = entry.records.findIndex((record) => record.id === id);
    const record = entry.records[index];
    if (record === undefined) return;
    entry.records[index] = { ...record, consumedRound: round };
  }

  /**
   * Every direction for one delegation, oldest first.
   * @param delegation - the delegation to read.
   * @returns the records, for the snapshot and for an advisor's context.
   */
  all(delegation: DelegationId): readonly DirectionRecord[] {
    return [...this.entries.get(delegation)?.records ?? []];
  }

  /**
   * Open a wait that a new user direction interrupts.
   * @param delegation - the delegation being decided.
   * @returns the signal, an interruption probe, and the disposer.
   */
  waiter(delegation: DelegationId): DirectionWaiter {
    const controller = new AbortController();
    const entry = this.entryOf(delegation);
    entry.waiters.add(controller);
    return {
      signal: controller.signal,
      interrupted: () => controller.signal.aborted,
      dispose: () => {
        entry.waiters.delete(controller);
      },
    };
  }

  /**
   * Copy a delegation's standing instructions onto its continuation.
   *
   * They were given to the WORK, not to one attempt at it. A direction already
   * delivered comes across as context — repeating it to a delegate that already
   * has it would be noise — while one that never reached the delegate stays
   * pending, and still overrides.
   * @param parent - the delegation being continued.
   * @param child - the continuation.
   */
  inherit(parent: DelegationId, child: DelegationId): void {
    const source = this.entries.get(parent);
    if (source === undefined) return;
    this.entryOf(child).records.push(...source.records);
  }

  /**
   * Drop everything about one delegation.
   * @param delegation - the delegation to forget.
   */
  forget(delegation: DelegationId): void {
    const entry = this.entries.get(delegation);
    for (const waiter of entry?.waiters ?? []) waiter.abort();
    this.entries.delete(delegation);
  }

  /** The entry for one delegation, created on first use. */
  private entryOf(delegation: DelegationId): Entry {
    const existing = this.entries.get(delegation);
    if (existing !== undefined) return existing;
    const created: Entry = { records: [], waiters: new Set() };
    this.entries.set(delegation, created);
    return created;
  }
}
