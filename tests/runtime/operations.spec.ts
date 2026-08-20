import { describe, expect, it } from 'vitest';
import type { StreamFrame } from '../../src/shared/protocol.ts';
import { buildOperations } from '../support/host.ts';
import { until } from '../support/fakes.ts';

const CLAUDE_DONE = [
  '{"type":"result","is_error":false,"result":"Done.","session_id":"s1"}\n',
];

function build(options: Parameters<typeof buildOperations>[0] = {}) {
  const built = buildOperations({
    script: (
      argv,
    ) => (argv.includes('--version')
      ? { stdout: ['1.0.0'] }
      : { stdout: CLAUDE_DONE }),
    ...options,
  });
  const frames: StreamFrame[] = [];
  built.operations.hub.subscribe((frame) => frames.push(frame));
  return { ...built, frames };
}

describe('state', () => {
  it('reads runs, accounts and toolchain in one call', async () => {
    const { operations } = build();
    await operations.accounts.add({
      cli: 'claude',
      id: 'work',
      auth: 'session',
    });
    const state = await operations.state();
    expect(state.accounts).toHaveLength(3);
    expect(state.toolchain).toHaveLength(2);
  });

  it('scopes the run list to the asking session', async () => {
    const { operations } = build();
    const started = await operations.startTask({
      cli: 'claude',
      prompt: 'x',
      cwd: '/repo',
      permission: 'read-only',
      sessionId: 'session-a',
    });
    await started.settled;
    expect((await operations.state('session-a')).runs).toHaveLength(1);
    expect((await operations.state('session-b')).runs).toHaveLength(0);
  });
});

describe('control', () => {
  it('answers every success with the refreshed state', async () => {
    const { operations } = build();
    const response = await operations.control({
      op: 'account.add',
      cli: 'claude',
      id: 'work',
      auth: 'session',
    });
    expect(
      response.ok &&
        response.state.accounts.some((account) => account.id === 'work'),
    ).toBe(true);
  });

  it('turns a refusal into a message instead of a throw', async () => {
    const { operations } = build();
    expect(
      await operations.control({
        op: 'account.remove',
        cli: 'claude',
        id: 'ghost',
      }),
    )
      .toEqual({ ok: false, error: 'no claude account named "ghost"' });
  });

  it('names the run an operation started', async () => {
    const { operations } = build();
    await operations.accounts.add({
      cli: 'claude',
      id: 'work',
      auth: 'session',
    });
    const response = await operations.control({
      op: 'account.login',
      cli: 'claude',
      id: 'work',
    });
    expect(response.ok && response.run).toBe('claude-1');
  });

  it('sets a default account', async () => {
    const { operations } = build();
    await operations.accounts.add({ cli: 'codex', id: 'ci', auth: 'session' });
    await operations.control({
      op: 'account.default',
      cli: 'codex',
      id: 'ambient',
    });
    expect(await operations.accounts.resolve('codex')).toBeUndefined();
  });

  it('cancels a live run', async () => {
    const { operations } = build({
      script: (
        argv,
      ) => (argv.includes('--print') ? { hold: true } : { stdout: ['1.0.0'] }),
    });
    const started = await operations.startTask({
      cli: 'claude',
      prompt: 'x',
      cwd: '/repo',
      permission: 'read-only',
    });
    const response = await operations.control({
      op: 'run.cancel',
      run: started.snapshot.id,
    });
    expect(response.ok).toBe(true);
    expect((await started.settled).status).toBe('cancelled');
  });

  it('writes to an interactive run', async () => {
    const { operations, process } = build();
    const started = await operations.runs.startLogin('claude', 'ambient');
    await until(() => process.lastTerminal !== undefined);
    const response = await operations.control({
      op: 'run.input',
      run: started.snapshot.id,
      data: 'code\r',
    });
    expect(response.ok).toBe(true);
    expect(process.lastTerminal?.writes).toEqual(['code\r']);
    process.lastTerminal?.exit(0);
    await started.settled;
  });

  it('refuses to write to a run with no terminal', async () => {
    const { operations } = build();
    const started = await operations.startTask({
      cli: 'claude',
      prompt: 'x',
      cwd: '/repo',
      permission: 'read-only',
    });
    await started.settled;
    const response = await operations.control({
      op: 'run.input',
      run: started.snapshot.id,
      data: 'x',
    });
    expect(response).toMatchObject({ ok: false });
  });
});

describe('installing through the channel', () => {
  it('streams the installer output and then says it is done', async () => {
    const { operations, frames } = build({
      script: (
        argv,
      ) => (argv.includes('install')
        ? { stdout: ['added 1 package\n'] }
        : { stdout: ['2.0.0'] }),
      onPath: ['npm'],
    });
    const response = await operations.control({
      op: 'toolchain.install',
      cli: 'claude',
    });
    expect(response.ok).toBe(false); // no binary appears in the in-memory prefix
    const install = frames.filter((frame) => frame.stream === 'claude-install');
    expect(
      install.some((frame) =>
        frame.kind === 'output' && frame.text.includes('added 1 package')
      ),
    ).toBe(true);
    expect(
      install.some((frame) =>
        frame.kind === 'activity' && frame.activity.type === 'notice' &&
        frame.activity.level === 'error'
      ),
    ).toBe(true);
  });

  it('reports a successful install as a notice on the same stream', async () => {
    const built = buildOperations({
      script: (
        argv,
      ) => (argv.includes('--version')
        ? { stdout: ['2.0.0'] }
        : { stdout: [''] }),
      onPath: ['npm', 'claude', 'codex'],
    });
    const frames: StreamFrame[] = [];
    built.operations.hub.subscribe((frame) => frames.push(frame));
    // The prefix binary is staged so the install can find what it "installed".
    built.files.directories.add(
      `${built.operations.paths.toolchainPrefix('claude')}/bin/claude`,
    );
    const response = await built.operations.control({
      op: 'toolchain.install',
      cli: 'claude',
    });
    expect(response.ok).toBe(true);
    expect(
      frames.some((frame) =>
        frame.kind === 'activity' && frame.activity.type === 'notice' &&
        frame.activity.text.includes('up to date')
      ),
    )
      .toBe(true);
  });

  it('forgets the synthetic install stream afterwards', async () => {
    const { operations } = build({ onPath: ['npm'] });
    await operations.control({ op: 'toolchain.install', cli: 'claude' });
    expect(operations.hub.history({ stream: 'claude-install' })).toEqual([]);
  });
});

describe('refreshing the toolchain', () => {
  it('does nothing when no delegate is managed', async () => {
    const { operations, frames } = build();
    expect(await operations.refreshToolchain()).toEqual([]);
    expect(
      frames.some((frame) =>
        frame.stream === 'toolchain-update' && frame.kind === 'activity'
      ),
    ).toBe(true);
  });

  it('reports its own failure on the channel rather than throwing at the timer', async () => {
    const { operations } = build({
      config: { toolchain: { mode: 'path', updateIntervalMs: 1000 } },
    });
    await expect(operations.refreshToolchain()).resolves.toEqual([]);
  });
});

const never = new AbortController().signal;

/** Start one delegation and wait for it, the way a tool call does. */
async function delegate(
  operations: ReturnType<typeof build>['operations'],
  overrides: Partial<Parameters<typeof operations.startBatch>[0]> = {},
) {
  const [entry] = await operations.startBatch({
    tasks: [{ cli: 'claude', prompt: 'Port the parser.' }],
    permission: 'workspace-write',
    base: '/repo',
    signal: never,
    ...overrides,
  });
  return entry!;
}

describe('delegations', () => {
  it('carries a batch of one to a terminus and remembers it', async () => {
    const { operations } = build();
    const entry = await delegate(operations);
    expect(entry.snapshot).toMatchObject({
      id: 'd1',
      batch: 'b1',
      status: 'completed',
      permission: 'workspace-write',
    });
    expect(operations.listDelegations().map((snapshot) => snapshot.id)).toEqual(
      ['d1'],
    );
    expect((await operations.state()).delegations).toHaveLength(1);
  });

  it('numbers batches and delegations across calls', async () => {
    const { operations } = build();
    await delegate(operations);
    const [second, third] = await operations.startBatch({
      tasks: [{ cli: 'claude', prompt: 'a' }, { cli: 'claude', prompt: 'b' }],
      permission: 'read-only',
      base: '/repo',
      signal: never,
    });
    expect([second?.snapshot.id, third?.snapshot.id]).toEqual(['d2', 'd3']);
    expect([second?.snapshot.batch, third?.snapshot.batch]).toEqual([
      'b2',
      'b2',
    ]);
  });

  it('scopes the delegation list to the asking session', async () => {
    const { operations } = build();
    await delegate(operations, { sessionId: 'session-a' });
    expect((await operations.state('session-a')).delegations).toHaveLength(1);
    expect((await operations.state('session-b')).delegations).toHaveLength(0);
  });

  it('forgets the oldest settled delegations beyond the retention budget', async () => {
    const { operations } = build({ config: { limits: { retainedRuns: 2 } } });
    await delegate(operations);
    await delegate(operations);
    await delegate(operations);
    expect(operations.listDelegations().map((snapshot) => snapshot.id)).toEqual(
      ['d2', 'd3'],
    );
  });
});

describe('continuing a delegation', () => {
  it('resumes the delegate session as a new delegation that names its parent', async () => {
    const { operations, process } = build();
    const first = await delegate(operations);
    const second = await operations.replyToDelegation(
      first.snapshot.id,
      'Now add the tests.',
      { signal: never },
    );
    expect(second.snapshot).toMatchObject({
      id: 'd2',
      batch: 'b1',
      parent: 'd1',
      status: 'completed',
    });
    expect(process.spawns.at(-1)?.spec.argv.join(' ')).toContain('--resume s1');
  });

  it('carries the standing directions of the delegation it continues', async () => {
    const { operations } = build();
    const first = await delegate(operations);
    operations.direct(first.snapshot.id, 'Keep the public API stable.');
    const second = await operations.replyToDelegation(
      first.snapshot.id,
      'Carry on.',
      { signal: never },
    );
    expect(second.snapshot.directions.map((direction) => direction.text))
      .toContain('Keep the public API stable.');
  });

  it('refuses a delegation nobody started', async () => {
    const { operations } = build();
    await expect(operations.replyToDelegation('d9', 'hi', { signal: never }))
      .rejects.toMatchObject({ code: 'UNKNOWN_RUN' });
  });

  it('refuses one whose delegate never named a session, before cutting a workspace', async () => {
    // No session_id in the transcript: there is nothing to resume.
    const { operations } = build({
      script: (argv) => (argv.includes('--version') ? { stdout: ['1.0.0'] } : {
        stdout: ['{"type":"result","is_error":false,"result":"Done."}\n'],
      }),
    });
    const first = await delegate(operations);
    expect(first.snapshot.status).toBe('completed');
    await expect(
      operations.replyToDelegation(first.snapshot.id, 'carry on', {
        signal: never,
      }),
    )
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    // Nothing was started for it: the refusal came before any work.
    expect(operations.listDelegations()).toHaveLength(1);
  });

  it('refuses one whose rounds retention has already dropped', async () => {
    const { operations } = build({ config: { limits: { retainedRuns: 1 } } });
    const first = await delegate(operations);
    await delegate(operations);
    await delegate(operations);
    // The first delegation is gone with its rounds; the second is still tracked
    // but its round has been evicted from the registry.
    await expect(
      operations.replyToDelegation(first.snapshot.id, 'carry on', {
        signal: never,
      }),
    )
      .rejects.toMatchObject({ code: 'UNKNOWN_RUN' });
  });

  it('refuses a delegation belonging to another session', async () => {
    const { operations } = build();
    const first = await delegate(operations, { sessionId: 'session-a' });
    await expect(
      operations.replyToDelegation(first.snapshot.id, 'hi', {
        signal: never,
        sessionId: 'session-b',
      }),
    )
      .rejects.toMatchObject({ code: 'UNKNOWN_RUN' });
  });
});

describe('autonomy', () => {
  it('is off until a person switches it on', async () => {
    const { operations } = build();
    expect((await operations.state()).autonomy).toEqual({
      decide: false,
      continue: false,
      review: false,
    });
    expect(operations.autonomy.decide).toBe(false);
  });

  it('takes the configured defaults when a deployment sets them', async () => {
    const { operations } = build({ config: { autonomy: { review: true } } });
    expect((await operations.state()).autonomy.review).toBe(true);
  });

  it('switches through the control channel, and reaches the next delegate run', async () => {
    const { operations, process } = build();
    await operations.control({
      op: 'autonomy.set',
      switch: 'continue',
      on: true,
    });
    expect((await operations.state()).autonomy.continue).toBe(true);

    await delegate(operations);
    // The contract asks for the next-steps marker exactly when something is
    // allowed to act on it, so the switch is visible in the delegate's prompt.
    expect(process.spawns.at(-1)?.spec.stdio.stdin)
      .toMatchObject({ data: expect.stringContaining('NEXT_STEPS:') });
  });

  it('switches back off again', async () => {
    const { operations } = build({ config: { autonomy: { decide: true } } });
    operations.setAutonomy('decide', false);
    expect(operations.autonomy.decide).toBe(false);
  });
});

describe('directing a delegation', () => {
  it('records the instruction against the delegation', async () => {
    const { operations } = build();
    const entry = await delegate(operations);
    operations.direct(entry.snapshot.id, 'Prefer the smaller diff.');
    expect(
      operations.directions.all(entry.snapshot.id).map((direction) =>
        direction.origin
      ),
    ).toEqual(['user']);
  });

  it('refuses an empty instruction and an unknown delegation', async () => {
    const { operations } = build();
    const entry = await delegate(operations);
    expect(() => operations.direct(entry.snapshot.id, '   ')).toThrow(
      /needs something in it/u,
    );
    expect(() => operations.direct('d9', 'hi')).toThrow(/no delegation named/u);
  });

  it('is fenced to the session that started the delegation', async () => {
    const { operations } = build();
    const entry = await delegate(operations, { sessionId: 'session-a' });
    expect(() => operations.direct(entry.snapshot.id, 'go', 'session-b'))
      .toThrow(/no delegation named/u);
    expect(() => operations.cancelDelegation(entry.snapshot.id, 'session-b'))
      .toThrow(/no delegation named/u);
    // Its own session reaches it.
    operations.direct(entry.snapshot.id, 'go', 'session-a');
    expect(operations.directions.pending(entry.snapshot.id)?.text).toBe('go');
  });

  it('is fenced through the control channel too', async () => {
    const { operations } = build();
    const entry = await delegate(operations, { sessionId: 'session-a' });
    expect(
      await operations.control(
        { op: 'delegation.direct', delegation: entry.snapshot.id, text: 'go' },
        'session-b',
      ),
    ).toMatchObject({ ok: false });
    expect(
      await operations.control(
        { op: 'delegation.cancel', delegation: entry.snapshot.id },
        'session-b',
      ),
    ).toMatchObject({ ok: false });
  });

  it('reaches the same delegation through the control channel', async () => {
    const { operations } = build();
    const entry = await delegate(operations);
    const response = await operations.control({
      op: 'delegation.direct',
      delegation: entry.snapshot.id,
      text: 'go',
    });
    expect(response.ok).toBe(true);
    expect(operations.directions.pending(entry.snapshot.id)?.text).toBe('go');
  });
});

describe('cancelling a delegation', () => {
  it('stops the rounds it had left', async () => {
    const { operations } = build({
      script: (
        argv,
      ) => (argv.includes('--print') ? { hold: true } : { stdout: ['1.0.0'] }),
    });
    const running = operations.startBatch({
      tasks: [{ cli: 'claude', prompt: 'x' }],
      permission: 'read-only',
      base: '/repo',
      signal: never,
    });
    await until(() => operations.listDelegations().length === 1);
    operations.cancelDelegation('d1');
    const [entry] = await running;
    expect(entry?.snapshot.status).toBe('cancelled');
  });

  it('refuses a delegation nobody started', async () => {
    const { operations } = build();
    expect(() => operations.cancelDelegation('d9')).toThrow(
      /no delegation named/u,
    );
    await expect(
      operations.control({ op: 'delegation.cancel', delegation: 'd9' }),
    )
      .resolves.toMatchObject({ ok: false });
  });
});

describe('disposal', () => {
  it('cancels live runs', async () => {
    const { operations } = build({
      script: (
        argv,
      ) => (argv.includes('--print') ? { hold: true } : { stdout: ['1.0.0'] }),
    });
    const started = await operations.startTask({
      cli: 'claude',
      prompt: 'x',
      cwd: '/repo',
      permission: 'read-only',
    });
    await operations.dispose();
    expect((await started.settled).status).toBe('cancelled');
  });

  it('stops live delegations too, and lets their merges finish', async () => {
    const { operations } = build({
      script: (
        argv,
      ) => (argv.includes('--print') ? { hold: true } : { stdout: ['1.0.0'] }),
    });
    const running = operations.startBatch({
      tasks: [{ cli: 'claude', prompt: 'x' }],
      permission: 'read-only',
      base: '/repo',
      signal: never,
    });
    await until(() => operations.listDelegations().length === 1);
    await operations.dispose();
    const [entry] = await running;
    expect(entry?.snapshot.status).toBe('cancelled');
    expect(operations.listDelegations()).toEqual([]);
  });
});
