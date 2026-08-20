/**
 * Combining cancellations.
 *
 * A delegation is cancellable from three directions at once — the tool call, the
 * delegation's own stop, and a user direction arriving — and every one of them
 * has to reach the same wait.
 *
 * @module dsh-cli-bridge/runtime/signals
 */

/** A combined signal, and the way to stop listening to its inputs. */
export interface CombinedSignal {
  readonly signal: AbortSignal;
  /** Detach from the inputs; the combined signal keeps whatever state it has. */
  readonly dispose: () => void;
}

/**
 * A signal that fires as soon as any of its inputs does.
 *
 * An input that has ALREADY fired counts: a combinator that only listened for
 * future events would hand back a signal that never fires, which is the bug
 * this exists to prevent.
 * @param signals - the inputs, any of which may already be aborted.
 * @returns the combined signal and its disposer.
 */
export function anySignal(
  signals: readonly (AbortSignal | undefined)[],
): CombinedSignal {
  const controller = new AbortController();
  const inputs = signals.filter((signal): signal is AbortSignal =>
    signal !== undefined
  );
  const abort = (): void => {
    controller.abort();
  };
  for (const input of inputs) {
    if (input.aborted) abort();
    else input.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const input of inputs) input.removeEventListener('abort', abort);
    },
  };
}
