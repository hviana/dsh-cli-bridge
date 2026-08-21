/**
 * The browser half's single source of truth.
 *
 * ONE subscription per page, not one per card. Every view reads this store, so
 * a conversation with a dozen delegated runs still holds one connection and one
 * copy of each run's stream. The transport is injected, which is what makes the
 * whole reducer testable without a browser.
 *
 * @module dsh-cli-bridge/client/store
 */
import type {
  AccountSnapshot,
  Activity,
  AdviceRoute,
  AutonomySwitches,
  BridgeState,
  ControlRequest,
  ControlResponse,
  DelegationId,
  DelegationSnapshot,
  RunEnd,
  RunId,
  RunSnapshot,
  StreamFrame,
  StreamKey,
  ToolchainStatus,
} from '../shared/protocol.ts';
import { CHANNEL_ROUTES } from '../shared/protocol.ts';
import { boundTailChars } from './format.ts';

/** One event delivered on the stream; only a message carries data. */
export interface StreamEvent {
  readonly data?: string;
}

/**
 * The part of `EventSource` this store uses.
 *
 * One signature rather than per-type overloads: the platform delivers an event
 * object to every listener, and only `message` fills in `data`.
 */
export interface EventSourceLike {
  addEventListener(
    type: 'message' | 'open' | 'error',
    listener: (event: StreamEvent) => void,
  ): void;
  close(): void;
}

/** One stream as the views read it. */
export interface RunView {
  readonly id: StreamKey;
  /** Listing state; absent for a synthetic stream such as an installer. */
  readonly snapshot?: RunSnapshot;
  readonly activities: readonly Activity[];
  /** Raw delegate output, newest-bounded. */
  readonly output: string;
  readonly end?: RunEnd;
}

/** Everything the views render. */
export interface StoreState {
  /** Streams in first-seen order. */
  readonly runs: readonly RunView[];
  readonly byRun: ReadonlyMap<StreamKey, RunView>;
  /** Runs indexed by the tool call that started them. */
  readonly byCall: ReadonlyMap<string, RunView>;
  /** Delegations in first-seen order. */
  readonly delegations: readonly DelegationSnapshot[];
  readonly byDelegation: ReadonlyMap<DelegationId, DelegationSnapshot>;
  /**
   * Delegations of one tool call, in start order — how a card finds its own
   * work. A batch call has several; an ordinary delegation has one.
   */
  readonly callDelegations: ReadonlyMap<string, readonly DelegationSnapshot[]>;
  readonly accounts: readonly AccountSnapshot[];
  readonly toolchain: readonly ToolchainStatus[];
  /** Which automatic decisions the user has switched on. */
  readonly autonomy: AutonomySwitches;
  /**
   * The route an automatic decision would run on; absent when none can be
   * resolved, in which case the switches cannot act however they are set.
   */
  readonly advice?: AdviceRoute;
  /** Whether the event stream is currently open. */
  readonly connected: boolean;
  /** Last transport or control failure, for the panel to show. */
  readonly error?: string;
}

/** How to reach the channel, and how much to keep. */
export interface StoreOptions {
  /** The channel's base path, as configured on the host. */
  readonly basePath: string;
  /** Opens the event stream; defaults to the platform `EventSource`. */
  readonly open?: (url: string) => EventSourceLike;
  /** Performs control and state requests; defaults to the platform `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Activities retained per run. */
  readonly maxActivities?: number;
  /** Characters of raw output retained per run. */
  readonly maxOutputChars?: number;
}

const DEFAULT_MAX_ACTIVITIES = 300;
const DEFAULT_MAX_OUTPUT_CHARS = 200_000;

const EMPTY: StoreState = {
  runs: [],
  byRun: new Map(),
  byCall: new Map(),
  delegations: [],
  byDelegation: new Map(),
  callDelegations: new Map(),
  accounts: [],
  toolchain: [],
  autonomy: { decide: false, continue: false, review: false },
  connected: false,
};

/** The store's outward face — deliberately `useSyncExternalStore`-shaped. */
export interface BridgeStore {
  /**
   * Subscribe to state changes.
   * @param listener - called after every committed change.
   * @returns the unsubscriber.
   */
  subscribe(listener: () => void): () => void;
  /** The current state; a stable reference between changes. */
  getSnapshot(): StoreState;
  /**
   * Send one control operation and fold the state it answers with.
   * @param request - the operation.
   * @returns the host's response.
   */
  send(request: ControlRequest): Promise<ControlResponse>;
  /** Re-read the whole state from the host. */
  refresh(): Promise<void>;
  /** Close the subscription. */
  dispose(): void;
}

/**
 * Create the store and open its subscription.
 * @param options - transport and retention.
 * @returns the live store.
 */
export function createStore(options: StoreOptions): BridgeStore {
  const base = options.basePath.replace(/\/+$/u, '');
  const maxActivities = options.maxActivities ?? DEFAULT_MAX_ACTIVITIES;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const request = options.fetch ??
    ((input, init) => globalThis.fetch(input, init));
  const listeners = new Set<() => void>();
  let state = EMPTY;

  const commit = (next: StoreState): void => {
    state = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A failing view must not stop the stream or the other views.
      }
    }
  };

  const foldFrame = (frame: StreamFrame): void => {
    if (frame.kind === 'delegation') {
      commit(indexDelegations(state, frame.delegation));
      return;
    }
    const views = new Map(state.byRun);
    const existing = views.get(frame.stream) ??
      { id: frame.stream, activities: [], output: '' };
    views.set(
      frame.stream,
      applyFrame(existing, frame, { maxActivities, maxOutputChars }),
    );
    commit(index(state, views));
  };

  const foldState = (next: BridgeState): void => {
    // Snapshots from the state read are authoritative for listing fields, but
    // must not discard streamed output a card is already showing.
    const views = new Map(state.byRun);
    for (const snapshot of next.runs) {
      const existing = views.get(snapshot.id) ??
        { id: snapshot.id, activities: [], output: '' };
      views.set(snapshot.id, { ...existing, snapshot });
    }
    // `advice` is dropped from the carried-over state before the fresh read is
    // applied: a route the host can no longer name must VANISH, not linger as a
    // stale promise that autonomy is able to act.
    const { advice: _previous, ...carried } = state;
    let folded = index(
      {
        ...carried,
        accounts: next.accounts,
        toolchain: next.toolchain,
        autonomy: next.autonomy,
        ...next.advice === undefined ? {} : { advice: next.advice },
      },
      views,
    );
    for (const delegation of next.delegations) {
      folded = indexDelegations(folded, delegation);
    }
    commit(folded);
  };

  const refresh = async (): Promise<void> => {
    try {
      const response = await request(`${base}/${CHANNEL_ROUTES.state}`, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`state request failed with ${String(response.status)}`);
      }
      foldState(await response.json() as BridgeState);
    } catch (error) {
      commit({ ...state, error: messageOf(error) });
    }
  };

  const source = (options.open ?? defaultOpen)(
    `${base}/${CHANNEL_ROUTES.events}`,
  );
  source.addEventListener('message', (event) => {
    const frame = event.data === undefined ? undefined : parseFrame(event.data);
    if (frame !== undefined) foldFrame(frame);
  });
  source.addEventListener('open', () => {
    // A fresh connection clears the last transport failure: the key is dropped
    // rather than set to undefined, because the state type says a present
    // `error` is a string.
    const { error: _cleared, ...rest } = state;
    commit({ ...rest, connected: true });
    // A reconnect may have missed frames; the state read repairs the listing.
    void refresh();
  });
  source.addEventListener('error', () => {
    commit({ ...state, connected: false });
  });
  void refresh();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    async send(control) {
      try {
        const response = await request(`${base}/${CHANNEL_ROUTES.control}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(control),
        });
        const answer = await response.json() as ControlResponse;
        if (answer.ok) foldState(answer.state);
        else commit({ ...state, error: answer.error });
        return answer;
      } catch (error) {
        const failure: ControlResponse = { ok: false, error: messageOf(error) };
        commit({ ...state, error: failure.error });
        return failure;
      }
    },
    refresh,
    dispose() {
      listeners.clear();
      source.close();
    },
  };
}

/**
 * The views for a delegation's rounds, in order.
 *
 * A round the page has not seen — one that scrolled out of retention, or that
 * arrived before this tab connected — is left out rather than rendered as an
 * empty frame.
 * @param state - the store state.
 * @param rounds - the delegation's run ids.
 * @returns the views that exist, oldest first.
 */
export function roundsOf(
  state: StoreState,
  rounds: readonly RunId[],
): RunView[] {
  return rounds
    .map((run) => state.byRun.get(run))
    .filter((view): view is RunView => view !== undefined);
}

/**
 * The streams no delegation owns.
 *
 * Installs, interactive sign-ins and `/cli` runs have no delegation around them,
 * and a delegation's own rounds are already rendered inside it — listing them
 * again would show the same stream twice.
 * @param state - the store state.
 * @returns the unowned views, in first-seen order.
 */
export function looseRuns(state: StoreState): RunView[] {
  const owned = new Set<StreamKey>();
  for (const delegation of state.delegations) {
    for (const round of delegation.rounds) {
      owned.add(round);
    }
  }
  return state.runs.filter((view) => !owned.has(view.id));
}

/** Fold one frame into a run's view. */
function applyFrame(
  view: RunView,
  frame: StreamFrame,
  bounds: { maxActivities: number; maxOutputChars: number },
): RunView {
  switch (frame.kind) {
    case 'snapshot':
      return { ...view, snapshot: frame.snapshot };
    case 'output':
      return {
        ...view,
        output: boundTailChars(view.output + frame.text, bounds.maxOutputChars),
      };
    case 'activity': {
      const activities = [...view.activities, frame.activity];
      return {
        ...view,
        activities: activities.slice(
          Math.max(0, activities.length - bounds.maxActivities),
        ),
      };
    }
    case 'end':
      return { ...view, end: frame.end };
    default:
      // A delegation frame is folded by the caller, which owns that index.
      return view;
  }
}

/** Rebuild the derived indexes after a change. */
function index(previous: StoreState, views: Map<RunId, RunView>): StoreState {
  const byCall = new Map<string, RunView>();
  for (const view of views.values()) {
    const callId = view.snapshot?.callId;
    if (callId !== undefined) byCall.set(callId, view);
  }
  return { ...previous, runs: [...views.values()], byRun: views, byCall };
}

/**
 * Fold one delegation snapshot and rebuild the delegation indexes.
 * @param previous - the state to fold into.
 * @param delegation - the snapshot to store.
 * @returns the next state.
 */
function indexDelegations(
  previous: StoreState,
  delegation: DelegationSnapshot,
): StoreState {
  const byDelegation = new Map(previous.byDelegation);
  byDelegation.set(delegation.id, delegation);
  const callDelegations = new Map<string, DelegationSnapshot[]>();
  for (const entry of byDelegation.values()) {
    const call = entry.callId;
    if (call === undefined) continue;
    const bucket = callDelegations.get(call) ?? [];
    bucket.push(entry);
    callDelegations.set(call, bucket);
  }
  for (const bucket of callDelegations.values()) {
    bucket.sort((left, right) => left.startedAt - right.startedAt);
  }
  return {
    ...previous,
    delegations: [...byDelegation.values()],
    byDelegation,
    callDelegations,
  };
}

/** Parse one frame, ignoring anything that is not one. */
function parseFrame(data: string): StreamFrame | undefined {
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value !== 'object' || value === null) return undefined;
    const frame = value as Partial<StreamFrame>;
    return typeof frame.stream === 'string' && typeof frame.kind === 'string'
      ? value as StreamFrame
      : undefined;
  } catch {
    return undefined;
  }
}

/** Open the platform event stream. */
function defaultOpen(url: string): EventSourceLike {
  return new EventSource(url) as unknown as EventSourceLike;
}

/** One readable line for a caught value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
