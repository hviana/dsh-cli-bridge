import { describe, expect, it } from 'vitest';
import { Config } from '../../src/config.ts';
import type { IsolationConfig } from '../../src/config.ts';
import { AccountStore } from '../../src/runtime/accounts.ts';
import { Batch, type BatchTask } from '../../src/runtime/batch.ts';
import { StreamHub } from '../../src/runtime/channel.ts';
import { DirectionLedger } from '../../src/runtime/directions.ts';
import { MergeQueue } from '../../src/runtime/merge.ts';
import type { GitPort, MergeOutcome } from '../../src/runtime/git.ts';
import { BridgePaths } from '../../src/runtime/paths.ts';
import { RunRegistry } from '../../src/runtime/registry.ts';
import { Toolchain } from '../../src/runtime/toolchain.ts';
import { Workspaces } from '../../src/runtime/workspace.ts';
import type { StreamFrame } from '../../src/shared/protocol.ts';
import {
  fakeClock,
  FakeProcessPort,
  MemoryFiles,
  type ProcessScript,
} from '../support/fakes.ts';
import { transcriptFor } from '../support/delegation.ts';

const never = new AbortController().signal;

/** A git repository that records the order it was driven in. */
class OrderedGit implements GitPort {
  readonly calls: string[] = [];
  merges: MergeOutcome = { ok: true, commit: 'merged' };
  /** Branch whose worktree this repository refuses to create. */
  refuseWorktree: string | undefined;
  /** Resolves when the test lets a merge finish, to expose ordering. */
  gate: ((release: () => void) => void) | undefined;

  async isRepository(): Promise<boolean> {
    return true;
  }

  async currentBranch(): Promise<string | undefined> {
    return 'main';
  }

  async addWorktree(_cwd: string, path: string, branch: string): Promise<void> {
    this.calls.push(`add ${path}`);
    if (branch === this.refuseWorktree) throw new Error(`refusing ${branch}`);
  }

  async removeWorktree(_cwd: string, path: string): Promise<void> {
    this.calls.push(`remove ${path}`);
  }

  async hasChanges(): Promise<boolean> {
    return true;
  }

  async commitAll(cwd: string): Promise<string | undefined> {
    this.calls.push(`commit ${cwd}`);
    return `commit-${this.calls.length}`;
  }

  async merge(_cwd: string, branch: string): Promise<MergeOutcome> {
    this.calls.push(`merge:start ${branch}`);
    if (this.gate !== undefined) {
      await new Promise<void>((resolve) => {
        this.gate?.(resolve);
      });
    }
    this.calls.push(`merge:end ${branch}`);
    return this.merges;
  }

  async deleteBranch(_cwd: string, branch: string): Promise<void> {
    this.calls.push(`delete ${branch}`);
  }

  async diffstat(): Promise<string> {
    return ' a.ts | 1 +';
  }
}

function build(options: {
  tasks?: readonly BatchTask[];
  isolation?: Partial<IsolationConfig>;
  limits?: { maxConcurrentRuns?: number };
  script?: (argv: readonly string[]) => ProcessScript;
  git?: OrderedGit;
} = {}) {
  const config = new Config({
    isolation: options.isolation ?? {},
    ...options.limits === undefined ? {} : { limits: options.limits },
  });
  const paths = new BridgePaths('/state');
  const files = new MemoryFiles();
  const clock = fakeClock();
  const process = new FakeProcessPort((spec) =>
    options.script?.(spec.argv) ?? { stdout: transcriptFor(spec.argv, 'Done.') }
  );
  process.resolvable.add('claude');
  process.resolvable.add('codex');

  const hub = new StreamHub(65_536, clock.now);
  const frames: StreamFrame[] = [];
  hub.subscribe((frame) => frames.push(frame));
  const directions = new DirectionLedger(clock.now);
  const accounts = new AccountStore(paths, files, clock.now);
  const toolchain = new Toolchain(
    paths,
    files,
    process,
    clock.now,
    'linux',
    '/usr/bin/node',
    config.toolchain,
    config.delegates,
  );
  const runs = new RunRegistry({
    hub,
    accounts,
    toolchain,
    process,
    config,
    now: clock.now,
  });
  const git = options.git ?? new OrderedGit();
  const workspaces = new Workspaces(paths, files, git, config.isolation);

  let counter = 0;
  const batch = new Batch({
    id: 'b1',
    tasks: options.tasks ?? [{ cli: 'claude', prompt: 'Port the parser.' }],
    permission: 'workspace-write',
    base: '/repo',
  }, {
    runs,
    hub,
    directions,
    config,
    now: clock.now,
    workspaces,
    merges: new MergeQueue(),
    nextDelegationId: () => {
      counter += 1;
      return `d${String(counter)}`;
    },
  });

  return { batch, git, accounts, frames, process, config, runs };
}

describe('a batch of one', () => {
  it('runs inline, with nothing to merge', async () => {
    const { batch, git } = build();
    const [entry] = await batch.run(never);
    expect(entry?.snapshot).toMatchObject({
      status: 'completed',
      workspace: { mode: 'inline', path: '/repo', merge: 'not-required' },
    });
    expect(git.calls).toEqual([]);
  });

  it('isolates when the deployment asks for it, and merges back', async () => {
    const { batch, git } = build({ isolation: { mode: 'worktree' } });
    const [entry] = await batch.run(never);
    expect(entry?.snapshot.workspace).toMatchObject({
      mode: 'worktree',
      branch: 'cli-bridge/d1',
      merge: 'merged',
    });
    expect(git.calls.join(' ')).toContain('merge:start cli-bridge/d1');
    expect(git.calls.at(-1)).toBe('delete cli-bridge/d1');
  });
});

/** Register the two accounts the parallel tasks name. */
async function withAccounts(context: ReturnType<typeof build>) {
  await context.accounts.add({ cli: 'claude', id: 'work', auth: 'session' });
  await context.accounts.add({
    cli: 'codex',
    id: 'analytics',
    auth: 'session',
  });
  return context;
}

describe('several delegations at once', () => {
  const tasks: BatchTask[] = [
    { cli: 'claude', prompt: 'Build the auth stack.', account: 'work' },
    { cli: 'codex', prompt: 'Build the BI stack.', account: 'analytics' },
  ];

  it('gives each its own worktree, account and branch', async () => {
    const context = await withAccounts(build({ tasks }));
    const entries = await context.batch.run(never);
    expect(entries.map((entry) => entry.snapshot.account)).toEqual([
      'work',
      'analytics',
    ]);
    expect(entries.map((entry) => entry.snapshot.workspace.branch)).toEqual([
      'cli-bridge/d1',
      'cli-bridge/d2',
    ]);
    expect(entries.map((entry) => entry.snapshot.cli)).toEqual([
      'claude',
      'codex',
    ]);
    expect(
      entries.every((entry) => entry.snapshot.workspace.mode === 'worktree'),
    ).toBe(true);
  });

  it('runs them in parallel but merges them one at a time', async () => {
    const git = new OrderedGit();
    const releases: (() => void)[] = [];
    git.gate = (release) => releases.push(release);
    const context = await withAccounts(build({ tasks, git }));

    const running = context.batch.run(never);
    // Let both delegations finish and queue their merges.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(git.calls.filter((call) => call.startsWith('merge:start')))
      .toHaveLength(1);

    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    releases.shift()?.();
    await running;

    const merges = git.calls.filter((call) => call.startsWith('merge:'));
    // Each merge ends before the next one starts.
    expect(merges).toEqual([
      'merge:start cli-bridge/d1',
      'merge:end cli-bridge/d1',
      'merge:start cli-bridge/d2',
      'merge:end cli-bridge/d2',
    ]);
  });

  it('merges the second even when the first conflicts', async () => {
    const git = new OrderedGit();
    git.merges = { ok: false, conflict: true, detail: 'CONFLICT' };
    const context = await withAccounts(build({ tasks, git }));
    const entries = await context.batch.run(never);
    expect(entries.map((entry) => entry.snapshot.workspace.merge)).toEqual([
      'conflict',
      'conflict',
    ]);
    expect(git.calls.filter((call) => call.startsWith('merge:start')))
      .toHaveLength(2);
    // Nothing was removed: both branches still hold their work.
    expect(git.calls.some((call) => call.startsWith('remove'))).toBe(false);
  });

  it('publishes both delegations on their own streams', async () => {
    const context = await withAccounts(build({ tasks }));
    await context.batch.run(never);
    const streams = new Set(
      context.frames.filter((frame) => frame.kind === 'delegation').map(
        (frame) => frame.stream,
      ),
    );
    expect([...streams].toSorted()).toEqual(['d1', 'd2']);
  });
});

describe('a workspace git refuses', () => {
  it('runs that delegation in the session workspace while the others stay isolated', async () => {
    const git = new OrderedGit();
    git.refuseWorktree = 'cli-bridge/d2';
    const context = await withAccounts(build({
      tasks: [
        { cli: 'claude', prompt: 'Build the auth stack.', account: 'work' },
        { cli: 'codex', prompt: 'Build the BI stack.', account: 'analytics' },
      ],
      git,
    }));
    const entries = await context.batch.run(never);

    expect(entries.map((entry) => entry.snapshot.workspace.mode)).toEqual([
      'worktree',
      'inline',
    ]);
    expect(entries.map((entry) => entry.snapshot.status)).toEqual([
      'completed',
      'completed',
    ]);
    // The one that could not be isolated has nothing to merge, and says so.
    expect(entries[1]?.snapshot.workspace).toMatchObject({
      path: '/repo',
      merge: 'not-required',
    });
  });
});

describe('more delegations than the concurrency budget', () => {
  it('runs them all: the surplus queues rather than failing', async () => {
    // Sampled at each spawn, which is the moment the budget is at its fullest.
    const peak = { running: 0, queued: 0 };
    // The registry exists only after build(), so the script reads it through a
    // holder rather than closing over a value that is not there yet.
    const probe: { runs?: ReturnType<typeof build>['runs'] } = {};
    const context = build({
      tasks: ['a', 'b', 'c', 'd'].map((prompt) => ({
        cli: 'claude' as const,
        prompt,
      })),
      limits: { maxConcurrentRuns: 2 },
      script: (argv) => {
        if (!argv.includes('--print')) return { stdout: ['1.0.0'] };
        const load = probe.runs?.load ?? { running: 0, queued: 0 };
        peak.running = Math.max(peak.running, load.running);
        peak.queued = Math.max(peak.queued, load.queued);
        // Several chunks, so a run holds its slot across ticks: a budget that
        // was not enforced would show up here as an overlap.
        return {
          stdout: [
            ...Array.from({ length: 8 }, () => '\n'),
            ...transcriptFor(argv, 'Done.'),
          ],
        };
      },
    });
    probe.runs = context.runs;
    const entries = await context.batch.run(never);

    expect(entries.map((entry) => entry.snapshot.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
    ]);
    expect(entries.map((entry) => entry.snapshot.rounds.length)).toEqual([
      1,
      1,
      1,
      1,
    ]);
    // Every task ran, two at a time, with the rest waiting rather than refused.
    expect(
      context.process.spawns.filter((spawn) =>
        spawn.spec.argv.includes('--print')
      ),
    ).toHaveLength(4);
    expect(peak.running).toBeLessThanOrEqual(2);
    expect(peak.queued).toBeGreaterThan(0);
  });
});

describe('work that did not finish', () => {
  it('is committed but not merged, and its branch is named', async () => {
    const { batch, git } = build({
      isolation: { mode: 'worktree' },
      script: (
        argv,
      ) => (argv.includes('--print')
        ? { exitCode: 1, stderr: ['boom'] }
        : { stdout: ['1.0.0'] }),
    });
    const [entry] = await batch.run(never);
    expect(entry?.snapshot.status).toBe('failed');
    expect(entry?.snapshot.workspace).toMatchObject({ merge: 'skipped' });
    expect(entry?.snapshot.workspace.detail).toContain('cli-bridge/d1');
    expect(git.calls.some((call) => call.startsWith('commit'))).toBe(true);
    expect(git.calls.some((call) => call.startsWith('merge'))).toBe(false);
  });

  it('leaves no delegation of a cancelled batch merged, and no branch removed', async () => {
    const control = new AbortController();
    const git = new OrderedGit();
    const context = await withAccounts(build({
      tasks: [
        { cli: 'claude', prompt: 'Build the auth stack.', account: 'work' },
        { cli: 'codex', prompt: 'Build the BI stack.', account: 'analytics' },
      ],
      git,
      script: (
        argv,
      ) => (argv.includes('--print') || argv.includes('exec')
        ? { hold: true }
        : { stdout: ['1.0.0'] }),
    }));
    const running = context.batch.run(control.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    control.abort();
    const entries = await running;

    expect(entries.map((entry) => entry.snapshot.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    // Committed so nothing is lost, unmerged so nothing half-done lands.
    expect(git.calls.filter((call) => call.startsWith('commit'))).toHaveLength(
      2,
    );
    expect(git.calls.some((call) => call.startsWith('merge'))).toBe(false);
    expect(git.calls.some((call) => call.startsWith('remove'))).toBe(false);
    expect(
      entries.every((entry) => entry.snapshot.workspace.merge === 'skipped'),
    ).toBe(true);
  });

  it('is left alone when the caller cancels', async () => {
    const control = new AbortController();
    const { batch, git } = build({
      isolation: { mode: 'worktree' },
      script: (
        argv,
      ) => (argv.includes('--print') ? { hold: true } : { stdout: ['1.0.0'] }),
    });
    const running = batch.run(control.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    control.abort();
    const [entry] = await running;
    expect(entry?.snapshot.status).toBe('cancelled');
    expect(git.calls.some((call) => call.startsWith('merge'))).toBe(false);
  });
});
