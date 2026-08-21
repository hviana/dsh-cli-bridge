import { describe, expect, it, vi } from 'vitest';
import {
  createStore,
  type EventSourceLike,
  looseRuns,
  roundsOf,
  type StreamEvent,
} from '../../src/client/store.ts';
import type {
  BridgeState,
  DelegationSnapshot,
  RunSnapshot,
} from '../../src/shared/protocol.ts';

/** A scripted event stream the test drives by hand. */
class FakeSource implements EventSourceLike {
  closed = false;
  private readonly messages: ((event: StreamEvent) => void)[] = [];
  private readonly opens: ((event: StreamEvent) => void)[] = [];
  private readonly errors: ((event: StreamEvent) => void)[] = [];

  addEventListener(
    type: 'message' | 'open' | 'error',
    listener: (event: StreamEvent) => void,
  ): void {
    if (type === 'message') this.messages.push(listener);
    if (type === 'open') this.opens.push(listener);
    if (type === 'error') this.errors.push(listener);
  }

  close(): void {
    this.closed = true;
  }

  /** Deliver one frame, exactly as the host would encode it. */
  emit(frame: unknown): void {
    for (const listener of this.messages) {
      listener({ data: JSON.stringify(frame) });
    }
  }

  /** Deliver a raw payload, to exercise the parser's tolerance. */
  emitRaw(data: string): void {
    for (const listener of this.messages) listener({ data });
  }

  open(): void {
    for (const listener of this.opens) listener({});
  }

  fail(): void {
    for (const listener of this.errors) listener({});
  }
}

const snapshot: RunSnapshot = {
  id: 'claude-1',
  cli: 'claude',
  kind: 'task',
  account: 'work',
  label: 'rename the parser',
  permission: 'workspace-write',
  cwd: '/repo',
  status: 'running',
  startedAt: 1000,
  bytes: 0,
  interactive: false,
  callId: 'call-7',
};

const AUTONOMY_OFF = { decide: false, continue: false, review: false } as const;

const emptyState: BridgeState = {
  runs: [],
  delegations: [],
  accounts: [],
  toolchain: [],
  autonomy: AUTONOMY_OFF,
};

const delegation: DelegationSnapshot = {
  id: 'd1',
  batch: 'b1',
  label: 'rename the parser',
  cli: 'claude',
  account: 'work',
  permission: 'workspace-write',
  status: 'running',
  rounds: ['claude-1'],
  workspace: { mode: 'inline', path: '/repo', merge: 'not-required' },
  directions: [],
  decisions: [],
  notes: [],
  startedAt: 1000,
  callId: 'call-7',
};

function build(options: { state?: BridgeState; controlStatus?: number } = {}) {
  const source = new FakeSource();
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...init === undefined ? {} : { init } });
    if (url.endsWith('/state')) {
      return new Response(JSON.stringify(options.state ?? emptyState), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({ ok: true, state: options.state ?? emptyState }),
      { status: options.controlStatus ?? 200 },
    );
  });
  const store = createStore({
    basePath: '/dsh-cli-bridge/',
    open: () => source,
    fetch: fetch as unknown as typeof globalThis.fetch,
    maxActivities: 3,
    maxOutputChars: 20,
  });
  return { store, source, fetch, calls };
}

describe('createStore', () => {
  it('subscribes to the channel under the configured base path', () => {
    const { calls } = build();
    expect(calls[0]?.url).toBe('/dsh-cli-bridge/state');
  });

  it('starts empty and disconnected', () => {
    const { store } = build();
    expect(store.getSnapshot()).toMatchObject({ runs: [], connected: false });
  });

  it('reports the connection opening, and re-reads the state', async () => {
    const { store, source, fetch } = build();
    source.open();
    expect(store.getSnapshot().connected).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports the connection dropping without losing what it knows', () => {
    const { store, source } = build();
    source.open();
    source.emit({
      seq: 1,
      at: 1,
      stream: 'claude-1',
      kind: 'snapshot',
      snapshot,
    });
    source.fail();
    expect(store.getSnapshot().connected).toBe(false);
    expect(store.getSnapshot().runs).toHaveLength(1);
  });

  it('notifies subscribers on every committed change', () => {
    const { store, source } = build();
    const listener = vi.fn();
    store.subscribe(listener);
    source.emit({
      seq: 1,
      at: 1,
      stream: 'claude-1',
      kind: 'snapshot',
      snapshot,
    });
    expect(listener).toHaveBeenCalled();
  });

  it('keeps a stable snapshot reference between changes', () => {
    const { store, source } = build();
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    source.emit({
      seq: 1,
      at: 1,
      stream: 'claude-1',
      kind: 'snapshot',
      snapshot,
    });
    expect(store.getSnapshot()).not.toBe(before);
  });

  it('contains a throwing subscriber', () => {
    const { store, source } = build();
    const survivor = vi.fn();
    store.subscribe(() => {
      throw new Error('render failed');
    });
    store.subscribe(survivor);
    expect(() =>
      source.emit({
        seq: 1,
        at: 1,
        stream: 'claude-1',
        kind: 'snapshot',
        snapshot,
      })
    ).not.toThrow();
    expect(survivor).toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', () => {
    const { store, source } = build();
    const listener = vi.fn();
    store.subscribe(listener)();
    source.emit({
      seq: 1,
      at: 1,
      stream: 'claude-1',
      kind: 'snapshot',
      snapshot,
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it('closes the stream when disposed', () => {
    const { store, source } = build();
    store.dispose();
    expect(source.closed).toBe(true);
  });
});

describe('folding frames', () => {
  it('indexes a run by id and by the tool call that started it', () => {
    const { store, source } = build();
    source.emit({
      seq: 1,
      at: 1,
      stream: 'claude-1',
      kind: 'snapshot',
      snapshot,
    });
    const state = store.getSnapshot();
    expect(state.byRun.get('claude-1')?.snapshot?.label).toBe(
      'rename the parser',
    );
    expect(state.byCall.get('call-7')?.id).toBe('claude-1');
  });

  it('accumulates raw output in arrival order', () => {
    const { store, source } = build();
    source.emit({
      seq: 1,
      at: 1,
      stream: 'claude-1',
      kind: 'output',
      pipe: 'stdout',
      text: 'ab',
    });
    source.emit({
      seq: 2,
      at: 2,
      stream: 'claude-1',
      kind: 'output',
      pipe: 'stderr',
      text: 'cd',
    });
    expect(store.getSnapshot().byRun.get('claude-1')?.output).toBe('abcd');
  });

  it('keeps only the newest output within its budget', () => {
    const { store, source } = build();
    for (let index = 0; index < 5; index += 1) {
      source.emit({
        seq: index + 1,
        at: index,
        stream: 'claude-1',
        kind: 'output',
        pipe: 'stdout',
        text: 'xxxxxxxx',
      });
    }
    const output = store.getSnapshot().byRun.get('claude-1')?.output ?? '';
    expect(output).toHaveLength(20);
  });

  it('keeps only the newest activities within its budget', () => {
    const { store, source } = build();
    for (const text of ['one', 'two', 'three', 'four']) {
      source.emit({
        seq: 1,
        at: 1,
        stream: 'claude-1',
        kind: 'activity',
        activity: { type: 'message', text },
      });
    }
    const activities = store.getSnapshot().byRun.get('claude-1')?.activities ??
      [];
    expect(
      activities.map(
        (activity) => (activity.type === 'message' ? activity.text : ''),
      ),
    ).toEqual(['two', 'three', 'four']);
  });

  it('records the settlement', () => {
    const { store, source } = build();
    source.emit({
      seq: 1,
      at: 1,
      stream: 'claude-1',
      kind: 'end',
      end: {
        status: 'needs_direction',
        summary: 'partly done',
        question: 'which one?',
        durationMs: 12,
      },
    });
    expect(store.getSnapshot().byRun.get('claude-1')?.end).toMatchObject({
      question: 'which one?',
    });
  });

  it('tracks a synthetic stream that has no snapshot, such as an install', () => {
    const { store, source } = build();
    source.emit({
      seq: 1,
      at: 1,
      stream: 'claude-install',
      kind: 'output',
      pipe: 'stdout',
      text: 'added 1 package',
    });
    const view = store.getSnapshot().byRun.get('claude-install');
    expect(view).toMatchObject({
      id: 'claude-install',
      output: 'added 1 package',
    });
    expect(view?.snapshot).toBeUndefined();
  });

  it('indexes a delegation by id and by the call that started it', () => {
    const { store, source } = build();
    source.emit({
      seq: 1,
      at: 1,
      stream: 'd1',
      kind: 'delegation',
      delegation,
    });
    const state = store.getSnapshot();
    expect(state.byDelegation.get('d1')?.label).toBe('rename the parser');
    expect(state.callDelegations.get('call-7')?.map((entry) => entry.id))
      .toEqual(['d1']);
  });

  it('replaces a delegation rather than accumulating its versions', () => {
    const { store, source } = build();
    source.emit({
      seq: 1,
      at: 1,
      stream: 'd1',
      kind: 'delegation',
      delegation,
    });
    source.emit({
      seq: 2,
      at: 2,
      stream: 'd1',
      kind: 'delegation',
      delegation: { ...delegation, status: 'completed' },
    });
    expect(store.getSnapshot().delegations).toHaveLength(1);
    expect(store.getSnapshot().byDelegation.get('d1')?.status).toBe(
      'completed',
    );
  });

  it('keeps the delegations of one call in start order', () => {
    const { store, source } = build();
    const second: DelegationSnapshot = {
      ...delegation,
      id: 'd2',
      startedAt: 900,
      rounds: ['codex-1'],
    };
    source.emit({
      seq: 1,
      at: 1,
      stream: 'd1',
      kind: 'delegation',
      delegation,
    });
    source.emit({
      seq: 2,
      at: 2,
      stream: 'd2',
      kind: 'delegation',
      delegation: second,
    });
    expect(
      store.getSnapshot().callDelegations.get('call-7')?.map((entry) =>
        entry.id
      ),
    ).toEqual(['d2', 'd1']);
  });

  it.each([
    ['a non-JSON payload', 'not json'],
    ['a JSON scalar', '42'],
    ['a frame with no stream', '{"kind":"output"}'],
    ['a frame with no kind', '{"stream":"claude-1"}'],
  ])('ignores %s', (_label, data) => {
    const { store, source } = build();
    source.emitRaw(data);
    expect(store.getSnapshot().runs).toEqual([]);
  });
});

describe('reading the state', () => {
  const state: BridgeState = {
    runs: [{ ...snapshot, status: 'completed', finishedAt: 2000 }],
    delegations: [],
    accounts: [{
      id: 'work',
      cli: 'claude',
      label: 'Work',
      auth: 'session',
      home: '/state/homes/claude/work',
      isDefault: true,
      createdAt: 0,
    }],
    toolchain: [{ cli: 'claude', source: 'managed', version: '2.0.0' }],
    autonomy: { decide: true, continue: false, review: false },
  };

  it('folds the autonomy the user switched on', async () => {
    const { store } = build({ state });
    await store.refresh();
    expect(store.getSnapshot().autonomy).toEqual({
      decide: true,
      continue: false,
      review: false,
    });
  });

  it('folds accounts, toolchain and run listings', async () => {
    const { store } = build({ state });
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({
      accounts: [{ id: 'work' }],
      toolchain: [{ cli: 'claude', version: '2.0.0' }],
    });
    expect(store.getSnapshot().byRun.get('claude-1')?.snapshot?.status).toBe(
      'completed',
    );
  });

  it('never discards streamed output when the listing refreshes', async () => {
    const { store, source } = build({ state });
    source.emit({
      seq: 1,
      at: 1,
      stream: 'claude-1',
      kind: 'output',
      pipe: 'stdout',
      text: 'kept',
    });
    await store.refresh();
    expect(store.getSnapshot().byRun.get('claude-1')?.output).toBe('kept');
  });

  it('reports a failed read without clearing what it has', async () => {
    const source = new FakeSource();
    const store = createStore({
      basePath: '/dsh-cli-bridge',
      open: () => source,
      fetch: (async () =>
        new Response('nope', {
          status: 500,
        })) as unknown as typeof globalThis.fetch,
    });
    await store.refresh();
    expect(store.getSnapshot().error).toMatch(/500/u);
  });

  it('reports a transport rejection', async () => {
    const source = new FakeSource();
    const store = createStore({
      basePath: '/dsh-cli-bridge',
      open: () => source,
      fetch: (async () => {
        throw new Error('offline');
      }) as unknown as typeof globalThis.fetch,
    });
    await store.refresh();
    expect(store.getSnapshot().error).toBe('offline');
  });
});

describe('sending control operations', () => {
  it('posts the operation and folds the state it answers with', async () => {
    const { store, calls } = build({
      state: {
        runs: [],
        delegations: [],
        accounts: [],
        toolchain: [{ cli: 'codex', source: 'managed' }],
        autonomy: AUTONOMY_OFF,
      },
    });
    const answer = await store.send({ op: 'toolchain.install', cli: 'codex' });
    expect(answer.ok).toBe(true);
    const control = calls.find((call) => call.url.endsWith('/control'));
    expect(control?.init?.method).toBe('POST');
    expect(control?.init?.body).toBe(
      '{"op":"toolchain.install","cli":"codex"}',
    );
    expect(store.getSnapshot().toolchain).toEqual([{
      cli: 'codex',
      source: 'managed',
    }]);
  });

  it('records a refusal as an error the panel can show', async () => {
    const source = new FakeSource();
    const store = createStore({
      basePath: '/dsh-cli-bridge',
      open: () => source,
      fetch: (async () =>
        new Response(
          JSON.stringify({ ok: false, error: 'no such account' }),
        )) as unknown as typeof globalThis.fetch,
    });
    const answer = await store.send({
      op: 'account.remove',
      cli: 'claude',
      id: 'ghost',
    });
    expect(answer).toEqual({ ok: false, error: 'no such account' });
    expect(store.getSnapshot().error).toBe('no such account');
  });

  it('records a transport failure as a refusal', async () => {
    const source = new FakeSource();
    const store = createStore({
      basePath: '/dsh-cli-bridge',
      open: () => source,
      fetch: (async () => {
        throw new Error('offline');
      }) as unknown as typeof globalThis.fetch,
    });
    expect(await store.send({ op: 'run.cancel', run: 'claude-1' })).toEqual({
      ok: false,
      error: 'offline',
    });
  });
});

describe('selecting what a view renders', () => {
  it('resolves a delegation’s rounds in order, skipping streams the page never saw', () => {
    const { store, source } = build();
    source.emit({
      seq: 1,
      at: 1,
      stream: 'claude-1',
      kind: 'snapshot',
      snapshot,
    });
    const state = store.getSnapshot();
    expect(roundsOf(state, ['claude-1', 'claude-9']).map((view) => view.id))
      .toEqual(['claude-1']);
  });

  it('leaves a delegation’s own rounds out of the loose runs, so no stream is shown twice', () => {
    const { store, source } = build();
    source.emit({
      seq: 1,
      at: 1,
      stream: 'claude-1',
      kind: 'snapshot',
      snapshot,
    });
    source.emit({
      seq: 2,
      at: 2,
      stream: 'claude-install',
      kind: 'output',
      pipe: 'stdout',
      text: 'added',
    });
    source.emit({
      seq: 3,
      at: 3,
      stream: 'd1',
      kind: 'delegation',
      delegation,
    });
    expect(looseRuns(store.getSnapshot()).map((view) => view.id)).toEqual([
      'claude-install',
    ]);
  });
});

describe('the route autonomy would consult', () => {
  it('carries the route the host reports', async () => {
    const { store } = build({
      state: {
        ...emptyState,
        autonomy: { decide: true, continue: false, review: false },
        advice: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      },
    });
    await store.refresh();
    expect(store.getSnapshot().advice).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    });
    store.dispose();
  });

  it('forgets a route the host stops reporting', async () => {
    // Otherwise the panel keeps claiming autonomy can act after the
    // composition's default model is gone.
    const options: { state?: BridgeState } = {
      state: {
        ...emptyState,
        advice: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      },
    };
    const { store } = build(options);
    await store.refresh();
    expect(store.getSnapshot().advice).toBeDefined();

    options.state = { ...emptyState };
    await store.refresh();
    expect(store.getSnapshot().advice).toBeUndefined();
    store.dispose();
  });
});
