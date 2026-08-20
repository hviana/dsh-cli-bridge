/**
 * The concurrency budget, as a queue rather than a refusal.
 *
 * One call can now ask for several delegations at once, and each of those spends
 * as many rounds as it takes. A budget that REFUSED the surplus would turn "run
 * six tasks" into four results and two failures for a reason that has nothing to
 * do with the work — so a run that arrives with the budget spent waits for a
 * slot instead.
 *
 * The reservation is also atomic, which a check against a list of live runs
 * cannot be: several starts race through their own preparation before any of
 * them registers, so counting registered runs would let every one of them pass a
 * budget of one.
 *
 * @module dsh-cli-bridge/runtime/slots
 */
import { BridgeError } from './errors.ts';

/** Releases the slot it was handed. Calling it twice is harmless. */
export type Slot = () => void;

/** A fixed number of slots, handed out in arrival order. */
export class SlotGate {
  private taken = 0;
  /** Waiters in arrival order; a released slot goes to the one at the front. */
  private readonly waiting = new Set<() => void>();

  /**
   * @param limit - the budget, read on every reservation so configuration is
   *   never captured at construction.
   */
  constructor(private readonly limit: () => number) {}

  /** How many slots are in use, for the deployment's own telemetry. */
  get inUse(): number {
    return this.taken;
  }

  /** How many callers are waiting for a slot. */
  get queued(): number {
    return this.waiting.size;
  }

  /**
   * Reserve a slot if one is free right now.
   *
   * For work that must not sit in a queue: an interactive sign-in draws a prompt
   * and waits for a human, so telling the user the budget is spent beats a
   * terminal that silently never opens.
   * @returns the release, or `undefined` when every slot is taken.
   */
  reserve(): Slot | undefined {
    // A budget of zero would deadlock every run rather than limiting them, so
    // one is the floor whatever the configuration says.
    if (this.taken >= Math.max(1, this.limit())) return undefined;
    this.taken += 1;
    return this.slot();
  }

  /**
   * Reserve a slot, waiting for one when the budget is spent.
   * @param signal - the caller's cancellation, honoured while queued.
   * @returns the release.
   * @throws {BridgeError} `CANCELLED` when the caller gave up while waiting.
   */
  async acquire(signal?: AbortSignal): Promise<Slot> {
    if (signal?.aborted === true) throw cancelled();
    const immediate = this.reserve();
    if (immediate !== undefined) return immediate;

    const slot = await this.queue(signal);
    // The slot was handed over as the caller was giving up: put it back rather
    // than holding a slot for work nobody is waiting for any more.
    if (signal?.aborted ?? false) {
      slot();
      throw cancelled();
    }
    return slot;
  }

  /**
   * Join the queue.
   * @param signal - the caller's cancellation.
   * @returns the release for the slot handed to this waiter.
   */
  private queue(signal?: AbortSignal): Promise<Slot> {
    return new Promise<Slot>((resolve, reject) => {
      const wake = (): void => {
        signal?.removeEventListener('abort', abort);
        resolve(this.slot());
      };
      const abort = (): void => {
        this.waiting.delete(wake);
        reject(cancelled());
      };
      this.waiting.add(wake);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  /** A release that hands its slot on exactly once. */
  private slot(): Slot {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.handOver();
    };
  }

  /**
   * Pass a freed slot to the waiter at the front, or give it back to the budget.
   *
   * Handing it over directly is what makes the queue fair: waking a waiter and
   * letting it re-reserve would lose the slot to whichever caller arrived in
   * between.
   */
  private handOver(): void {
    for (const wake of this.waiting) {
      this.waiting.delete(wake);
      wake();
      return;
    }
    this.taken -= 1;
  }
}

/** The failure a queued caller sees when it gives up. */
function cancelled(): BridgeError {
  return new BridgeError(
    'cancelled while waiting for a delegate slot',
    'CANCELLED',
  );
}
