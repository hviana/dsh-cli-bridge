/**
 * The merge queue.
 *
 * One at a time, always. Two merges into the same branch at once is a race the
 * repository loses, and the queue is deliberately owned above any single batch:
 * two batches from two turns can be in flight together, and they merge into the
 * same base.
 *
 * The policy it enforces is the one that keeps a base branch trustworthy:
 * commit everything so nothing is lost, merge only what actually FINISHED, and
 * leave anything else on its own branch with the reason recorded.
 *
 * @module dsh-cli-bridge/runtime/merge
 */
import type { DelegationSnapshot, WorkspaceState } from '../shared/protocol.ts';
import type { WorkspaceLease } from './workspace.ts';

/** Serializes every merge in the process. */
export class MergeQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Commit a delegation's work and, if it finished, merge it back.
   *
   * Committing happens off the queue — it touches only the delegation's own
   * worktree — while the merge waits its turn, because that is the step that
   * touches the shared branch.
   * @param lease - the delegation's workspace.
   * @param snapshot - how the delegation ended.
   * @returns the workspace's final state.
   */
  async settle(
    lease: WorkspaceLease,
    snapshot: DelegationSnapshot,
  ): Promise<WorkspaceState> {
    if (lease.state.mode !== 'worktree') return lease.state;
    await lease.commit(snapshot.label);

    if (snapshot.status !== 'completed') {
      // Committed, so nothing is lost; unmerged, so a half-done change never
      // lands on the base branch behind the user's back.
      return {
        ...lease.state,
        merge: 'skipped',
        detail: `the delegation ${snapshot.status}; its work is on ${
          lease.state.branch ?? 'its branch'
        }`,
      };
    }

    const merged = this.tail.then(async () => lease.merge(snapshot.label));
    // A failed merge must not poison the queue for the delegations behind it.
    this.tail = merged.catch(() => undefined);
    await merged;
    return lease.release();
  }

  /** Resolves once every queued merge has settled. */
  async drain(): Promise<void> {
    await this.tail.catch(() => undefined);
  }
}
