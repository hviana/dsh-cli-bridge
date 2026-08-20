import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Config } from '../../src/config.ts';
import type { Config as ResolvedConfig } from '../../src/config.ts';
import { AccountStore } from '../../src/runtime/accounts.ts';
import { StreamHub } from '../../src/runtime/channel.ts';
import { BridgePaths } from '../../src/runtime/paths.ts';
import { RunRegistry } from '../../src/runtime/registry.ts';
import { Toolchain } from '../../src/runtime/toolchain.ts';
import type { StreamFrame } from '../../src/shared/protocol.ts';
import {
  fakeClock,
  FakeProcessPort,
  MemoryFiles,
  type ProcessScript,
  until,
} from '../support/fakes.ts';

const paths = new BridgePaths('/state');
const NODE = '/usr/bin/node';

/** A claude transcript that finishes cleanly. */
const CLAUDE_DONE = [
  '{"type":"system","subtype":"init","session_id":"sess-77"}\n',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Working."}]}}\n',
  '{"type":"result","subtype":"success","is_error":false,"result":"Renamed 3 files.","session_id":"sess-77",' +
  '"usage":{"input_tokens":10,"output_tokens":4},"total_cost_usd":0.02}\n',
];

function build(options: {
  config?: Partial<ReturnType<typeof configOf>>;
  script?: (argv: readonly string[]) => ProcessScript;
} = {}) {
  const config = { ...configOf(), ...options.config };
  const files = new MemoryFiles();
  const clock = fakeClock();
  const port = new FakeProcessPort((spec) =>
    options.script?.(spec.argv) ?? { stdout: CLAUDE_DONE }
  );
  port.resolvable.add('claude');
  port.resolvable.add('codex');
  const hub = new StreamHub(65_536, clock.now);
  const accounts = new AccountStore(paths, files, clock.now, {
    resolve: async () => 'sk-test',
  });
  const toolchain = new Toolchain(
    paths,
    files,
    port,
    clock.now,
    'linux',
    NODE,
    config.toolchain,
    config.delegates,
  );
  const runs = new RunRegistry({
    hub,
    accounts,
    toolchain,
    process: port,
    config,
    now: clock.now,
  });
  const frames: StreamFrame[] = [];
  hub.subscribe((frame) => frames.push(frame));
  return { config, files, clock, port, hub, accounts, toolchain, runs, frames };
}

function configOf(): ResolvedConfig {
  return new Config({});
}

/** How many delegate TASK processes were spawned, ignoring version probes. */
function tasksSpawned(port: FakeProcessPort): number {
  return port.spawns.filter((spawn) => spawn.spec.argv.includes('--print'))
    .length;
}

const task = {
  cli: 'claude',
  prompt: 'Rename the parser module.',
  cwd: '/repo',
  permission: 'workspace-write',
} as const;

describe('delegating a task', () => {
  it('settles with the delegate’s own summary and usage, and nothing else', async () => {
    const { runs } = build();
    const started = await runs.start(task);
    expect(await started.settled).toEqual({
      status: 'completed',
      summary: 'Renamed 3 files.',
      durationMs: 0,
      exitCode: 0,
      usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.02 },
    });
  });

  it('never returns the transcript to the caller, only streams it', async () => {
    const { runs, frames } = build();
    const started = await runs.start(task);
    const end = await started.settled;
    expect(end.summary).not.toContain('"type"');
    const streamed = frames.filter((frame) => frame.kind === 'output').map(
      (frame) => frame.text,
    ).join('');
    expect(streamed).toContain('"type":"result"');
  });

  it('counts the bytes it kept out of the model’s context', async () => {
    const { runs } = build();
    const started = await runs.start(task);
    await started.settled;
    expect(runs.get(started.snapshot.id).bytes).toBe(
      CLAUDE_DONE.join('').length,
    );
  });

  it('publishes the lifecycle: starting, running, then settled', async () => {
    const { runs, frames } = build();
    const started = await runs.start(task);
    await started.settled;
    const statuses = frames
      .filter((frame) =>
        frame.kind === 'snapshot' && frame.stream === started.snapshot.id
      )
      .map((frame) => (frame.kind === 'snapshot' ? frame.snapshot.status : ''))
      .filter((status, index, all) => status !== all[index - 1]);
    expect(statuses).toEqual(['starting', 'running', 'completed']);
    expect(frames.at(-1)?.kind).toBe('end');
  });

  it('publishes decoded activities beside the raw stream', async () => {
    const { runs, frames } = build();
    await (await runs.start(task)).settled;
    const activities = frames.flatMap(
      (frame) => (frame.kind === 'activity' ? [frame.activity] : []),
    );
    expect(activities).toContainEqual({ type: 'message', text: 'Working.' });
  });

  it('records the delegate’s session so the run can be continued', async () => {
    const { runs } = build();
    const started = await runs.start(task);
    await started.settled;
    expect(runs.get(started.snapshot.id).delegateSessionId).toBe('sess-77');
  });

  it('states the direction contract in the prompt it sends', async () => {
    const { runs, port } = build();
    await (await runs.start(task)).settled;
    const stdin = port.spawns.at(-1)?.spec.stdio.stdin;
    expect(stdin).toMatchObject({
      data: expect.stringContaining('NEEDS_DIRECTION:'),
    });
    expect(stdin).toMatchObject({
      data: expect.stringContaining('Rename the parser module.'),
    });
  });

  it('omits the contract when the deployment turned it off', async () => {
    const config = configOf();
    const { runs, port } = build({
      config: { direction: { ...config.direction, preamble: false } },
    });
    await (await runs.start(task)).settled;
    expect(port.spawns.at(-1)?.spec.stdio.stdin).toEqual({
      data: 'Rename the parser module.',
    });
  });

  it('carries the inherited permission mode into the delegate’s own flags', async () => {
    const { runs, port } = build();
    await (await runs.start({ ...task, permission: 'read-only' })).settled;
    expect(port.spawns.at(-1)?.spec.argv.join(' ')).toContain(
      '--permission-mode dontAsk',
    );
  });

  it('applies the deployment’s default model and effort', async () => {
    const config = configOf();
    const { runs, port } = build({
      config: {
        delegates: {
          ...config.delegates,
          claude: {
            ...config.delegates.claude,
            defaultModel: 'opus',
            defaultEffort: 'high',
          },
        },
      },
    });
    const started = await runs.start(task);
    await started.settled;
    const argv = port.spawns.at(-1)?.spec.argv.join(' ') ?? '';
    expect(argv).toContain('--model opus');
    expect(argv).toContain('--effort high');
    expect(started.snapshot).toMatchObject({ model: 'opus', effort: 'high' });
  });

  it('lets the call override the deployment default', async () => {
    const config = configOf();
    const { runs, port } = build({
      config: {
        delegates: {
          ...config.delegates,
          claude: { ...config.delegates.claude, defaultModel: 'opus' },
        },
      },
    });
    await (await runs.start({ ...task, model: 'sonnet' })).settled;
    expect(port.spawns.at(-1)?.spec.argv.join(' ')).toContain('--model sonnet');
  });

  it('labels the run with the first line of the prompt', async () => {
    const { runs } = build();
    const started = await runs.start({
      ...task,
      prompt: 'Fix the flaky test\n\nDetails follow.',
    });
    expect(started.snapshot.label).toBe('Fix the flaky test');
  });
});

describe('accounts on a run', () => {
  it('uses the ambient account by default and touches nothing', async () => {
    const { runs, port } = build();
    const started = await runs.start(task);
    await started.settled;
    expect(started.snapshot.account).toBe('ambient');
    expect(port.spawns.at(-1)?.spec.env).toEqual({});
  });

  it('pins the private home of a named account', async () => {
    const { runs, accounts, port } = build();
    await accounts.add({ cli: 'claude', id: 'work', auth: 'session' });
    await (await runs.start({ ...task, account: 'work' })).settled;
    expect(port.spawns.at(-1)?.spec.env).toEqual({
      CLAUDE_CONFIG_DIR: join('/state', 'homes', 'claude', 'work'),
      ANTHROPIC_API_KEY: undefined,
    });
  });

  it('records when the account last ran', async () => {
    const { runs, accounts, clock } = build();
    await accounts.add({ cli: 'claude', id: 'work', auth: 'session' });
    clock.advance(1000);
    await (await runs.start({ ...task, account: 'work' })).settled;
    let touched = false;
    await until(() => {
      void accounts.list('claude').then((all) => {
        touched = all.some((account) => account.lastUsedAt !== undefined);
      });
      return touched;
    });
  });

  it('refuses to start under an account that does not exist', async () => {
    const { runs } = build();
    await expect(runs.start({ ...task, account: 'ghost' })).rejects
      .toMatchObject({ code: 'UNKNOWN_ACCOUNT' });
  });

  it('points an endpoint account at its provider and uses its model', async () => {
    const { runs, accounts, port } = build();
    await accounts.add({
      cli: 'claude',
      id: 'deepseek',
      auth: 'endpoint',
      baseUrl: 'https://api.deepseek.com/anthropic',
      credentialRef: 'DEEPSEEK_API_KEY',
      model: 'deepseek-chat',
    });
    const started = await runs.start({ ...task, account: 'deepseek' });
    await started.settled;

    const spawn = port.spawns.at(-1)?.spec;
    const env = spawn?.env ?? {};
    expect(env['ANTHROPIC_BASE_URL']).toBe(
      'https://api.deepseek.com/anthropic',
    );
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe('sk-test');
    expect(spawn?.argv.join(' ')).toContain('--model deepseek-chat');
    expect(started.snapshot.model).toBe('deepseek-chat');
  });

  it('lets the call override an endpoint account’s default model', async () => {
    const { runs, accounts, port } = build();
    await accounts.add({
      cli: 'claude',
      id: 'deepseek',
      auth: 'endpoint',
      baseUrl: 'https://api.deepseek.com/anthropic',
      credentialRef: 'DEEPSEEK_API_KEY',
      model: 'deepseek-chat',
    });
    await (await runs.start({
      ...task,
      account: 'deepseek',
      model: 'deepseek-reasoner',
    })).settled;
    expect(port.spawns.at(-1)?.spec.argv.join(' ')).toContain(
      '--model deepseek-reasoner',
    );
  });
});

describe('failure and cancellation', () => {
  it('settles as failed when the CLI cannot be had, instead of rejecting', async () => {
    const { runs } = build({ script: () => ({}) });
    const port = new FakeProcessPort(() => ({}));
    const files = new MemoryFiles();
    const clock = fakeClock();
    const config = configOf();
    const registry = new RunRegistry({
      hub: new StreamHub(1024, clock.now),
      accounts: new AccountStore(paths, files, clock.now),
      toolchain: new Toolchain(
        paths,
        files,
        port,
        clock.now,
        'linux',
        NODE,
        config.toolchain,
        config.delegates,
      ),
      process: port,
      config,
      now: clock.now,
    });
    const started = await registry.start(task);
    const end = await started.settled;
    expect(end.status).toBe('failed');
    expect(end.error).toMatch(/npmCommand|not available/u);
    expect(runs.list()).toBeDefined();
  });

  it('settles as failed when the delegate exits non-zero', async () => {
    const { runs } = build({
      script: () => ({ exitCode: 2, stderr: ['boom'] }),
    });
    const end = await (await runs.start(task)).settled;
    expect(end).toMatchObject({
      status: 'failed',
      error: 'exited with code 2: boom',
    });
  });

  it('stops a live run on request', async () => {
    const { runs } = build({
      script: (
        argv,
      ) => (argv.includes('--print') ? { hold: true } : { stdout: ['1.0.0'] }),
    });
    const started = await runs.start(task);
    await until(() => runs.get(started.snapshot.id).status === 'running');
    expect(runs.cancel(started.snapshot.id)).toBe('requested');
    expect((await started.settled).status).toBe('cancelled');
  });

  it('reports a second stop as already finished', async () => {
    const { runs } = build();
    const started = await runs.start(task);
    await started.settled;
    expect(runs.cancel(started.snapshot.id)).toBe('already-finished');
  });

  it('queues a run past the configured budget instead of refusing it', async () => {
    const config = configOf();
    const { runs, port } = build({
      config: { limits: { ...config.limits, maxConcurrentRuns: 1 } },
      script: (
        argv,
      ) => (argv.includes('--print') ? { hold: true } : { stdout: ['1.0.0'] }),
    });
    const first = await runs.start(task);
    const second = runs.start(task);
    await until(() => runs.load.queued === 1 && tasksSpawned(port) === 1);
    // The queued round has not spawned anything: the budget bounds delegates
    // that are executing, not calls that happened to arrive together.
    expect(tasksSpawned(port)).toBe(1);
    expect(runs.load).toEqual({ running: 1, queued: 1 });

    runs.cancel(first.snapshot.id);
    await first.settled;
    const admitted = await second;
    expect(admitted.snapshot.id).toBe('claude-2');
    await until(() => tasksSpawned(port) === 2);
    runs.cancel(admitted.snapshot.id);
    await admitted.settled;
  });

  it('enforces the budget atomically, however many starts race', async () => {
    const config = configOf();
    const { runs, port } = build({
      config: { limits: { ...config.limits, maxConcurrentRuns: 2 } },
      script: (
        argv,
      ) => (argv.includes('--print') ? { hold: true } : { stdout: ['1.0.0'] }),
    });
    // Five starts in one tick: a check against the registered runs would let
    // every one of them through, because none of them has registered yet.
    const all = [1, 2, 3, 4, 5].map(async () => runs.start(task));
    await until(() => runs.load.queued === 3 && tasksSpawned(port) === 2);
    expect(tasksSpawned(port)).toBe(2);
    await runs.dispose();
    await Promise.allSettled(all);
  });

  it('lets a caller abandon a run that is still queued, without ever spawning it', async () => {
    const config = configOf();
    const { runs, port } = build({
      config: { limits: { ...config.limits, maxConcurrentRuns: 1 } },
      script: (
        argv,
      ) => (argv.includes('--print') ? { hold: true } : { stdout: ['1.0.0'] }),
    });
    const first = await runs.start(task);
    const giveUp = new AbortController();
    const queued = runs.start({ ...task, signal: giveUp.signal });
    await until(() => runs.load.queued === 1);
    giveUp.abort();
    await expect(queued).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(runs.load.queued).toBe(0);
    // The slot it never used is still there for the next caller.
    runs.cancel(first.snapshot.id);
    await first.settled;
    expect(runs.load).toEqual({ running: 0, queued: 0 });
    expect(tasksSpawned(port)).toBe(1);
  });

  it('refuses a start whose caller had already given up', async () => {
    const { runs } = build();
    await expect(runs.start({ ...task, signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('never admits a queued run once the plugin is unloading', async () => {
    const config = configOf();
    const { runs, port } = build({
      config: { limits: { ...config.limits, maxConcurrentRuns: 1 } },
      script: (
        argv,
      ) => (argv.includes('--print') ? { hold: true } : { stdout: ['1.0.0'] }),
    });
    const first = await runs.start(task);
    await until(() => tasksSpawned(port) === 1);
    const queued = runs.start(task);
    await until(() => runs.load.queued === 1);

    await runs.dispose();
    await expect(queued).rejects.toMatchObject({ code: 'CANCELLED' });
    // Freeing the first run's slot must not spawn the delegate behind it.
    expect(tasksSpawned(port)).toBe(1);
    expect((await first.settled).status).toBe('cancelled');
    await expect(runs.start(task)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('refuses a sign-in rather than queueing it, because it waits on a person', async () => {
    const config = configOf();
    const { runs, accounts } = build({
      config: { limits: { ...config.limits, maxConcurrentRuns: 1 } },
      script: (
        argv,
      ) => (argv.includes('--print') ? { hold: true } : { stdout: ['1.0.0'] }),
    });
    await accounts.add({ cli: 'claude', id: 'work', auth: 'session' });
    const first = await runs.start(task);
    await expect(runs.startLogin('claude', 'work')).rejects.toMatchObject({
      code: 'RUN_LIMIT',
    });
    runs.cancel(first.snapshot.id);
    await first.settled;
    await expect(runs.startLogin('claude', 'work')).resolves.toBeDefined();
  });

  it('settles as cancelled when the stop lands before the delegate even starts', async () => {
    const { runs } = build({
      script: (
        argv,
      ) => (argv.includes('--print') ? { hold: true } : { stdout: ['1.0.0'] }),
    });
    const started = await runs.start(task);
    // Between registration and spawn the run is already visible, and a stop
    // here must not leave a process that nothing is watching.
    expect(runs.cancel(started.snapshot.id)).toBe('requested');
    expect((await started.settled).status).toBe('cancelled');
  });

  it('cancels everything it started when disposed', async () => {
    const { runs } = build({
      script: (
        argv,
      ) => (argv.includes('--print') ? { hold: true } : { stdout: ['1.0.0'] }),
    });
    const started = await runs.start(task);
    await runs.dispose();
    expect((await started.settled).status).toBe('cancelled');
    expect(runs.list()).toEqual([]);
  });
});

describe('continuing a run', () => {
  it('resumes the delegate session under the original conditions', async () => {
    const { runs, accounts, port } = build();
    await accounts.add({ cli: 'claude', id: 'work', auth: 'session' });
    const first = await runs.start({
      ...task,
      account: 'work',
      model: 'opus',
      effort: 'high',
    });
    await first.settled;

    const second = await runs.reply({
      run: first.snapshot.id,
      message: 'Yes, keep the alias.',
    });
    await second.settled;
    const argv = port.spawns.at(-1)?.spec.argv.join(' ') ?? '';
    expect(argv).toContain('--resume sess-77');
    expect(argv).toContain('--model opus');
    expect(argv).toContain('--effort high');
    expect(second.snapshot.account).toBe('work');
    expect(port.spawns.at(-1)?.spec.stdio.stdin).toMatchObject({
      data: expect.stringContaining('Yes, keep the alias.'),
    });
  });

  it('refuses to continue a run that is still going', async () => {
    const { runs } = build({
      script: (
        argv,
      ) => (argv.includes('--print') ? { hold: true } : { stdout: ['1.0.0'] }),
    });
    const started = await runs.start(task);
    await expect(runs.reply({ run: started.snapshot.id, message: 'hurry up' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    runs.cancel(started.snapshot.id);
    await started.settled;
  });

  it('refuses to continue a run the delegate never named a session for', async () => {
    const { runs } = build({
      script: (
        argv,
      ) => (argv.includes('--print')
        ? { stdout: ['{"type":"result","is_error":false,"result":"done"}\n'] }
        : { stdout: ['1.0.0'] }),
    });
    const started = await runs.start(task);
    await started.settled;
    await expect(runs.reply({ run: started.snapshot.id, message: 'more' }))
      .rejects.toThrow(/no delegate session/u);
  });

  it('refuses an unknown run', async () => {
    const { runs } = build();
    await expect(runs.reply({ run: 'claude-99', message: 'hello' })).rejects
      .toMatchObject({ code: 'UNKNOWN_RUN' });
  });
});

describe('session fencing', () => {
  it('hides another session’s runs', async () => {
    const { runs } = build();
    const mine = await runs.start({ ...task, sessionId: 'session-a' });
    await mine.settled;
    expect(runs.list('session-a').map((run) => run.id)).toEqual([
      mine.snapshot.id,
    ]);
    expect(runs.list('session-b')).toEqual([]);
    expect(() => runs.get(mine.snapshot.id, 'session-b')).toThrow(
      /no run named/u,
    );
  });

  it('shows unowned runs to everyone', async () => {
    const { runs } = build();
    const started = await runs.start(task);
    await started.settled;
    expect(runs.list('any-session').map((run) => run.id)).toEqual([
      started.snapshot.id,
    ]);
  });
});

describe('retention', () => {
  it('keeps only the configured number of settled runs', async () => {
    const config = configOf();
    const { runs, hub } = build({
      config: { limits: { ...config.limits, retainedRuns: 2 } },
    });
    const ids: string[] = [];
    // Sequential on purpose: the retention rule is about ORDER of settlement.
    // oxlint-disable-next-line eslint/no-await-in-loop
    for (let index = 0; index < 4; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      const started = await runs.start(task);
      ids.push(started.snapshot.id);
      // oxlint-disable-next-line eslint/no-await-in-loop
      await started.settled;
    }
    expect(runs.list().map((run) => run.id)).toEqual(ids.slice(-2));
    expect(hub.history({ stream: ids[0]! })).toEqual([]);
  });
});

describe('interactive sign-in', () => {
  it('opens a terminal, streams it, and accepts keystrokes', async () => {
    const { runs, accounts, port } = build();
    await accounts.add({ cli: 'claude', id: 'work', auth: 'session' });
    const started = await runs.startLogin('claude', 'work');
    await until(() => port.lastTerminal !== undefined);

    const terminal = port.lastTerminal!;
    expect(port.terminals[0]?.env).toEqual({
      CLAUDE_CONFIG_DIR: join('/state', 'homes', 'claude', 'work'),
    });
    expect(started.snapshot).toMatchObject({
      kind: 'login',
      interactive: true,
    });

    terminal.emit('Open this URL to sign in…');
    await runs.write(started.snapshot.id, 'pasted-code\r');
    expect(terminal.writes).toEqual(['pasted-code\r']);

    terminal.exit(0);
    expect((await started.settled).status).toBe('completed');
  });

  it('reports a failed sign-in', async () => {
    const { runs, port } = build();
    const started = await runs.startLogin('claude', 'ambient');
    await until(() => port.lastTerminal !== undefined);
    port.lastTerminal?.exit(1);
    expect(await started.settled).toMatchObject({
      status: 'failed',
      error: 'exited with code 1',
    });
  });

  it('terminates the terminal when the run is cancelled', async () => {
    const { runs, port } = build();
    const started = await runs.startLogin('claude', 'ambient');
    await until(() => port.lastTerminal !== undefined);
    runs.cancel(started.snapshot.id);
    await until(() => port.lastTerminal?.terminated === true);
    await started.settled;
  });

  it('refuses input to a run without a terminal', async () => {
    const { runs } = build();
    const started = await runs.start(task);
    await started.settled;
    await expect(runs.write(started.snapshot.id, 'x')).rejects.toMatchObject({
      code: 'NOT_INTERACTIVE',
    });
  });

  it('refuses to sign in to an account that does not exist', async () => {
    const { runs } = build();
    await expect(runs.startLogin('claude', 'ghost')).rejects.toMatchObject({
      code: 'UNKNOWN_ACCOUNT',
    });
  });
});
