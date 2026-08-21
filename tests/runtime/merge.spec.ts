import { describe, expect, it } from 'vitest';
import { MergeQueue } from '../../src/runtime/merge.ts';
import type { WorkspaceLease } from '../../src/runtime/workspace.ts';
import type {
  DelegationSnapshot,
  WorkspaceState,
} from '../../src/shared/protocol.ts';

/** A lease that records the order it was driven in. */
class FakeLease implements WorkspaceLease {
  readonly calls: string[] = [];
  state: WorkspaceState;
  /** Held open until the test releases it, to expose ordering. */
  gate: (() => void) | undefined;
  mergeFails = false;

  constructor(mode: WorkspaceState['mode'], branch = 'cli-bridge/d1') {
    this.state = mode === 'inline'
      ? { mode: 'inline', path: '/repo', merge: 'not-required' }
      : {
        mode: 'worktree',
        path: '/w/d1',
        branch,
        base: 'main',
        merge: 'pending',
      };
  }

  async commit(): Promise<WorkspaceState> {
    this.calls.push('commit');
    return this.state;
  }

  async merge(): Promise<WorkspaceState> {
    this.calls.push('merge:start');
    if (this.gate !== undefined) {
      await new Promise<void>((resolve) => {
        this.gate = resolve;
      });
    }
    if (this.mergeFails) throw new Error('index.lock exists');
    this.calls.push('merge:end');
    this.state = { ...this.state, merge: 'merged' };
    return this.state;
  }

  async release(): Promise<WorkspaceState> {
    this.calls.push('release');
    return this.state;
  }

  async evidence(): Promise<{ files: readonly string[] }> {
    return { files: [] };
  }
}

const snapshot = (
  status: DelegationSnapshot['status'],
): DelegationSnapshot => ({
  id: 'd1',
  batch: 'b1',
  label: 'port the parser',
  cli: 'claude',
  account: 'work',
  permission: 'workspace-write',
  status,
  rounds: ['claude-1'],
  workspace: { mode: 'worktree', path: '/w/d1', merge: 'pending' },
  directions: [],
  decisions: [],
  notes: [],
  startedAt: 0,
  finishedAt: 1,
});

describe('settling one delegation', () => {
  it('leaves an unisolated delegation entirely alone', async () => {
    const lease = new FakeLease('inline');
    const state = await new MergeQueue().settle(lease, snapshot('completed'));
    expect(state.merge).toBe('not-required');
    expect(lease.calls).toEqual([]);
  });

  it('commits, merges and releases work that finished', async () => {
    const lease = new FakeLease('worktree');
    const state = await new MergeQueue().settle(lease, snapshot('completed'));
    expect(lease.calls).toEqual([
      'commit',
      'merge:start',
      'merge:end',
      'release',
    ]);
    expect(state.merge).toBe('merged');
  });

  it.each(['failed', 'cancelled', 'needs_direction'] as const)(
    'commits %p work but never merges it, and names its branch',
    async (status) => {
      const lease = new FakeLease('worktree');
      const state = await new MergeQueue().settle(lease, snapshot(status));
      expect(lease.calls).toEqual(['commit']);
      expect(state.merge).toBe('skipped');
      expect(state.detail).toContain('cli-bridge/d1');
      expect(state.detail).toContain(status);
    },
  );
});

describe('serializing merges', () => {
  it('lets the second merge start only once the first has ended', async () => {
    const queue = new MergeQueue();
    const first = new FakeLease('worktree', 'cli-bridge/d1');
    const second = new FakeLease('worktree', 'cli-bridge/d2');
    first.gate = () => {};

    const running = Promise.all([
      queue.settle(first, snapshot('completed')),
      queue.settle(second, { ...snapshot('completed'), id: 'd2' }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(second.calls).toEqual(['commit']);

    first.gate?.();
    await running;
    expect(first.calls).toEqual([
      'commit',
      'merge:start',
      'merge:end',
      'release',
    ]);
    expect(second.calls).toEqual([
      'commit',
      'merge:start',
      'merge:end',
      'release',
    ]);
  });

  it('does not let a failed merge poison the queue behind it', async () => {
    const queue = new MergeQueue();
    const failing = new FakeLease('worktree');
    failing.mergeFails = true;
    const following = new FakeLease('worktree', 'cli-bridge/d2');

    await expect(queue.settle(failing, snapshot('completed'))).rejects.toThrow(
      /index\.lock/u,
    );
    expect(
      (await queue.settle(following, { ...snapshot('completed'), id: 'd2' }))
        .merge,
    ).toBe('merged');
  });

  it('drains, so a disposing plugin never leaves a merge half-done', async () => {
    const queue = new MergeQueue();
    const lease = new FakeLease('worktree');
    void queue.settle(lease, snapshot('completed'));
    await queue.drain();
    expect(lease.calls).toContain('merge:end');
  });

  it('has nothing to drain before anything was settled', async () => {
    await expect(new MergeQueue().drain()).resolves.toBeUndefined();
  });
});
