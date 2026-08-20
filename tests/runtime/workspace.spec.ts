import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Config } from '../../src/config.ts';
import type { IsolationConfig } from '../../src/config.ts';
import type { GitPort, MergeOutcome } from '../../src/runtime/git.ts';
import { BridgePaths } from '../../src/runtime/paths.ts';
import { Workspaces } from '../../src/runtime/workspace.ts';
import { MemoryFiles } from '../support/fakes.ts';

const isolation: IsolationConfig = new Config({}).isolation;
const paths = new BridgePaths('/state');

/** A git repository that records what it was asked to do. */
class FakeGit implements GitPort {
  readonly calls: string[] = [];
  repository = true;
  branch: string | undefined = 'main';
  commit: string | undefined = 'abc1234';
  mergeOutcome: MergeOutcome = { ok: true, commit: 'merged1' };
  failOn = new Set<string>();

  private record(name: string): void {
    this.calls.push(name);
    if (this.failOn.has(name)) throw new Error(`${name} refused`);
  }

  async isRepository(): Promise<boolean> {
    this.record('isRepository');
    return this.repository;
  }

  async currentBranch(): Promise<string | undefined> {
    this.record('currentBranch');
    return this.branch;
  }

  async addWorktree(): Promise<void> {
    this.record('addWorktree');
  }

  async removeWorktree(): Promise<void> {
    this.record('removeWorktree');
  }

  async hasChanges(): Promise<boolean> {
    this.record('hasChanges');
    return true;
  }

  async commitAll(): Promise<string | undefined> {
    this.record('commitAll');
    return this.commit;
  }

  async merge(): Promise<MergeOutcome> {
    this.record('merge');
    return this.mergeOutcome;
  }

  async deleteBranch(): Promise<void> {
    this.record('deleteBranch');
  }

  async diffstat(): Promise<string> {
    this.record('diffstat');
    return ' feature.ts | 2 ++\n 1 file changed';
  }
}

function build(
  options: { isolation?: Partial<IsolationConfig>; git?: FakeGit } = {},
) {
  const git = options.git ?? new FakeGit();
  const files = new MemoryFiles();
  const workspaces = new Workspaces(paths, files, git, {
    ...isolation,
    ...options.isolation,
  });
  return { git, files, workspaces };
}

const request = { delegation: 'd1', base: '/repo', contended: false };

describe('deciding whether to isolate', () => {
  it('shares the session workspace for a lone delegation', async () => {
    const { workspaces, git } = build();
    const lease = await workspaces.acquire(request);
    expect(lease.state).toEqual({
      mode: 'inline',
      path: '/repo',
      merge: 'not-required',
    });
    expect(git.calls).not.toContain('addWorktree');
  });

  it('isolates a delegation that would collide with another', async () => {
    const { workspaces } = build();
    const lease = await workspaces.acquire({ ...request, contended: true });
    expect(lease.state).toMatchObject({
      mode: 'worktree',
      path: join('/state', 'worktrees', 'd1'),
      branch: 'cli-bridge/d1',
      base: 'main',
      merge: 'pending',
    });
  });

  it('always isolates when the deployment says so', async () => {
    const { workspaces } = build({ isolation: { mode: 'worktree' } });
    expect((await workspaces.acquire(request)).state.mode).toBe('worktree');
  });

  it('never isolates when the deployment says so', async () => {
    const { workspaces } = build({ isolation: { mode: 'inline' } });
    expect(
      (await workspaces.acquire({ ...request, contended: true })).state.mode,
    ).toBe('inline');
  });

  it('does not isolate outside a git repository — there is nothing to branch', async () => {
    const git = new FakeGit();
    git.repository = false;
    const { workspaces } = build({ git, isolation: { mode: 'worktree' } });
    expect((await workspaces.acquire(request)).state.mode).toBe('inline');
  });

  it('falls back to the session workspace when git refuses the worktree', async () => {
    const git = new FakeGit();
    git.failOn.add('addWorktree');
    const { workspaces } = build({ git, isolation: { mode: 'worktree' } });
    expect((await workspaces.acquire(request)).state.mode).toBe('inline');
  });

  it('branches from a detached head as HEAD', async () => {
    const git = new FakeGit();
    git.branch = undefined;
    const { workspaces } = build({ git, isolation: { mode: 'worktree' } });
    expect((await workspaces.acquire(request)).state.base).toBe('HEAD');
  });
});

describe('an inline lease', () => {
  it('has nothing to commit, merge, release, or show', async () => {
    const { workspaces, git } = build();
    const lease = await workspaces.acquire(request);
    expect((await lease.commit('x')).merge).toBe('not-required');
    expect((await lease.merge('x')).merge).toBe('not-required');
    expect((await lease.release()).merge).toBe('not-required');
    expect(await lease.evidence()).toEqual({ files: [] });
    // An unisolated delegation never even asks git a question.
    expect(git.calls).toEqual([]);
  });
});

describe('a worktree lease', () => {
  const isolated = { ...request, contended: true };

  it('commits, merges, then removes itself and its branch', async () => {
    const { workspaces, git } = build();
    const lease = await workspaces.acquire(isolated);
    expect((await lease.commit('port the parser')).commit).toBe('abc1234');
    expect((await lease.merge('port the parser')).merge).toBe('merged');
    await lease.release();
    expect(git.calls).toContain('removeWorktree');
    expect(git.calls).toContain('deleteBranch');
  });

  it('reports a delegate that changed nothing, and merges nothing', async () => {
    const git = new FakeGit();
    git.commit = undefined;
    const { workspaces } = build({ git });
    const lease = await workspaces.acquire(isolated);
    expect(await lease.commit('x')).toMatchObject({
      merge: 'skipped',
      detail: 'the delegate changed nothing',
    });
    expect((await lease.merge('x')).merge).toBe('skipped');
    expect(git.calls).not.toContain('merge');
  });

  it('keeps the work when the merge conflicts, and names the branch', async () => {
    const git = new FakeGit();
    git.mergeOutcome = {
      ok: false,
      conflict: true,
      detail: 'CONFLICT in README.md',
    };
    const { workspaces } = build({ git });
    const lease = await workspaces.acquire(isolated);
    await lease.commit('x');
    const state = await lease.merge('x');
    expect(state).toMatchObject({ merge: 'conflict' });
    expect(state.detail).toContain('CONFLICT in README.md');
    expect(state.detail).toContain('cli-bridge/d1');
    await lease.release();
    expect(git.calls).not.toContain('removeWorktree');
  });

  it('keeps the work when the merge fails for another reason', async () => {
    const git = new FakeGit();
    git.mergeOutcome = {
      ok: false,
      conflict: false,
      detail: 'index.lock exists',
    };
    const { workspaces } = build({ git });
    const lease = await workspaces.acquire(isolated);
    await lease.commit('x');
    expect((await lease.merge('x')).merge).toBe('failed');
  });

  it('refuses to merge into a branch that is no longer checked out', async () => {
    const git = new FakeGit();
    const { workspaces } = build({ git });
    const lease = await workspaces.acquire(isolated);
    await lease.commit('x');
    git.branch = 'somewhere-else';
    const state = await lease.merge('x');
    expect(state.merge).toBe('skipped');
    expect(state.detail).toContain('no longer checked out');
    expect(git.calls).not.toContain('merge');
  });

  it('does not merge at all when merging is switched off', async () => {
    const git = new FakeGit();
    const { workspaces } = build({ git, isolation: { merge: 'never' } });
    const lease = await workspaces.acquire(isolated);
    await lease.commit('x');
    expect((await lease.merge('x')).merge).toBe('skipped');
    expect(git.calls).not.toContain('merge');
  });

  it('reports a commit that could not be made', async () => {
    const git = new FakeGit();
    git.failOn.add('commitAll');
    const { workspaces } = build({ git });
    const lease = await workspaces.acquire(isolated);
    expect(await lease.commit('x')).toMatchObject({
      merge: 'failed',
      detail: expect.stringContaining('refused'),
    });
  });

  it('stays merged when the worktree cannot be removed afterwards', async () => {
    const git = new FakeGit();
    git.failOn.add('removeWorktree');
    const { workspaces } = build({ git });
    const lease = await workspaces.acquire(isolated);
    await lease.commit('x');
    await lease.merge('x');
    const state = await lease.release();
    expect(state.merge).toBe('merged');
    expect(state.detail).toContain('could not be removed');
  });

  it('shows what changed, for a review', async () => {
    const { workspaces } = build();
    const lease = await workspaces.acquire(isolated);
    expect(await lease.evidence()).toEqual({
      files: [],
      diffstat: ' feature.ts | 2 ++\n 1 file changed',
    });
  });

  it('shows nothing rather than failing when the diff cannot be read', async () => {
    const git = new FakeGit();
    git.failOn.add('diffstat');
    const { workspaces } = build({ git });
    const lease = await workspaces.acquire(isolated);
    expect(await lease.evidence()).toEqual({ files: [] });
  });
});
