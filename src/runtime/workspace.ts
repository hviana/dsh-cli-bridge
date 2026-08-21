/**
 * Where a delegation works, and how its work comes back.
 *
 * Two delegates editing one working tree would corrupt each other's work, so a
 * delegation that could collide gets its own git worktree on its own branch.
 * When it finishes, whatever it left is committed and the branch is merged back
 * — one delegation, one reviewable unit of history.
 *
 * A delegation that did NOT finish keeps its branch and its worktree: merging
 * half-done or failed work into the base is worse than leaving it somewhere the
 * human can look at it.
 *
 * @module dsh-cli-bridge/runtime/workspace
 */
import { join } from 'node:path';
import type { DelegationId, WorkspaceState } from '../shared/protocol.ts';
import type { Evidence } from '../domain/advice.ts';
import { boundTail } from '../domain/text.ts';
import type { IsolationConfig } from '../config.ts';
import type { GitPort, MergeOutcome } from './git.ts';
import type { BridgePaths } from './paths.ts';
import type { FilePort } from './ports.ts';

/** One delegation's claim on a place to work. */
export interface WorkspaceLease {
  /** Where it works, and what has become of that work. */
  readonly state: WorkspaceState;
  /**
   * Commit whatever the delegate left behind.
   * @param label - one line naming the work, for the commit message.
   * @returns the updated state.
   */
  commit(label: string): Promise<WorkspaceState>;
  /**
   * Merge the branch back into the base. Serialize this: two merges into one
   * branch at the same time is a race the repository will lose.
   * @param label - one line naming the work, for the merge message.
   * @returns the updated state.
   */
  merge(label: string): Promise<WorkspaceState>;
  /**
   * Give the place back. A worktree whose work was merged is removed; one that
   * still holds unmerged work is kept, and said so.
   * @returns the final state.
   */
  release(): Promise<WorkspaceState>;
  /**
   * What changed here, for a review.
   * @returns the diffstat, when there is a base to compare against.
   */
  evidence(): Promise<Evidence>;
}

/** What a delegation asks for. */
export interface WorkspaceRequest {
  readonly delegation: DelegationId;
  /** The session workspace — the base repository, and the inline fallback. */
  readonly base: string;
  /** Whether anything else is working in the base right now. */
  readonly contended: boolean;
}

/** Hands out places to work. */
export class Workspaces {
  constructor(
    private readonly paths: BridgePaths,
    private readonly files: FilePort,
    private readonly git: GitPort,
    private readonly config: IsolationConfig,
  ) {}

  /**
   * Claim a place for one delegation.
   *
   * `auto` isolates exactly when isolation is needed: another delegation is
   * already working in the base, or the deployment asked for it outright. A
   * directory that is not a git repository is never isolated, because there is
   * nothing to branch from and nothing to merge back.
   * @param request - who is asking, and whether the base is contended.
   * @returns the lease.
   */
  async acquire(request: WorkspaceRequest): Promise<WorkspaceLease> {
    const wanted = this.config.mode === 'worktree' ||
      (this.config.mode === 'auto' && request.contended);
    if (!wanted) return inlineLease(request.base);
    // Isolation was wanted but needs a repository to cut a worktree from. A
    // base that has none — or one whose state could not be read — runs the
    // delegation inline, and the state says why: two contended delegations
    // sharing one tree with no record of it is exactly the collision that
    // isolation exists to prevent.
    const repository = await this.git.isRepository(request.base).catch(() =>
      undefined
    );
    if (repository !== true) {
      return inlineLease(
        request.base,
        repository === false
          ? 'the base is not a git repository, so there was nothing to isolate in'
          : 'the repository could not be checked, so the work ran in the session workspace',
      );
    }

    const branch = `${this.config.branchPrefix}${request.delegation}`;
    const path = join(this.paths.worktrees, request.delegation);
    const baseRef = await this.git.currentBranch(request.base) ?? 'HEAD';
    try {
      await this.files.makeDirectory(this.paths.worktrees);
      await this.git.addWorktree(request.base, path, branch, baseRef);
    } catch (error) {
      // A repository that will not give us a worktree — a stale registration, a
      // branch that exists — is not a reason to refuse the work. Fall back to
      // the session workspace and SAY SO in the state: running the delegation
      // inline without a word is exactly the silent collision isolation exists
      // to prevent, and the record must show that isolation was wanted and
      // not had.
      return inlineLease(
        request.base,
        `a worktree could not be created (${describe(error)})`,
      );
    }

    return new WorktreeLease(
      {
        mode: 'worktree',
        path,
        branch,
        base: baseRef,
        origin: request.base,
        merge: 'pending',
      },
      request.base,
      this.git,
      this.config,
    );
  }
}

/**
 * The session workspace: nothing to isolate, nothing to merge.
 * @param path - the working directory.
 * @param detail - why the delegation is inline when isolation was wanted;
 *   absent for the ordinary case, where inline is simply the decision.
 */
function inlineLease(path: string, detail?: string): WorkspaceLease {
  const state: WorkspaceState = {
    mode: 'inline',
    path,
    merge: 'not-required',
    ...detail === undefined ? {} : { detail },
  };
  return {
    state,
    async commit() {
      return state;
    },
    async merge() {
      return state;
    },
    async release() {
      return state;
    },
    async evidence() {
      return { files: [] };
    },
  };
}

/** An isolated checkout, committed and merged back when its delegation finishes. */
class WorktreeLease implements WorkspaceLease {
  private current: WorkspaceState;

  constructor(
    initial: WorkspaceState,
    private readonly repository: string,
    private readonly git: GitPort,
    private readonly config: IsolationConfig,
  ) {
    this.current = initial;
  }

  get state(): WorkspaceState {
    return this.current;
  }

  async commit(label: string): Promise<WorkspaceState> {
    try {
      const commit = await this.git.commitAll(
        this.current.path,
        `${label}\n\nDelegated by dsh-cli-bridge.`,
      );
      this.current = commit === undefined
        // Nothing to merge is a legitimate outcome, and an honest one to report.
        ? {
          ...this.current,
          merge: 'skipped',
          detail: 'the delegate changed nothing',
        }
        : { ...this.current, commit };
    } catch (error) {
      this.current = {
        ...this.current,
        merge: 'failed',
        detail: describe(error),
      };
    }
    return this.current;
  }

  async merge(label: string): Promise<WorkspaceState> {
    if (this.config.merge !== 'auto') {
      return this.hold('skipped', 'isolation.merge is off');
    }
    if (this.current.merge !== 'pending' || this.current.commit === undefined) {
      return this.current;
    }
    const branch = this.current.branch;
    const base = this.current.base;
    /* v8 ignore next -- a worktree lease always carries both. */
    if (branch === undefined || base === undefined) return this.current;

    // The base must still be the branch this work was started from: merging
    // into whatever the user checked out since would be a surprise.
    const checkedOut = await this.git.currentBranch(this.repository).catch(() =>
      undefined
    );
    if (checkedOut !== base) {
      return this.hold(
        'skipped',
        `the base branch ${base} is no longer checked out (now ${
          checkedOut ?? 'detached'
        })`,
      );
    }

    let outcome: MergeOutcome;
    try {
      outcome = await this.git.merge(
        this.repository,
        branch,
        `Merge ${branch}: ${label}`,
      );
    } catch (error) {
      // A merge that could not even be attempted — git vanished mid-session,
      // say — must not take the delegation's result down with it. The queue
      // above has already recorded the failure as terminal, and the caller
      // still needs to read what the delegate did. The work is on its branch,
      // and the state says why it is still there.
      return this.hold('failed', describe(error));
    }
    if (outcome.ok) {
      this.current = {
        ...this.current,
        merge: 'merged',
        ...outcome.commit === undefined ? {} : { commit: outcome.commit },
      };
      return this.current;
    }
    return this.hold(outcome.conflict ? 'conflict' : 'failed', outcome.detail);
  }

  async release(): Promise<WorkspaceState> {
    // Anything unmerged stays exactly where it is, with the branch that holds it
    // named in the state — that is the recovery path.
    if (this.current.merge !== 'merged') return this.current;
    try {
      await this.git.removeWorktree(this.repository, this.current.path);
      if (this.current.branch !== undefined) {
        await this.git.deleteBranch(this.repository, this.current.branch).catch(
          () => undefined,
        );
      }
    } catch (error) {
      this.current = {
        ...this.current,
        detail: `merged, but the worktree could not be removed: ${
          describe(error)
        }`,
      };
    }
    return this.current;
  }

  async evidence(): Promise<Evidence> {
    const base = this.current.base;
    if (base === undefined) return { files: [] };
    const diffstat = await this.git.diffstat(this.current.path, base).catch(
      () => '',
    );
    return {
      files: [],
      ...diffstat.length === 0 ? {} : { diffstat: boundTail(diffstat, 8192) },
    };
  }

  /** Record a state the work is being kept in, and why. */
  private hold(merge: WorkspaceState['merge'], detail: string): WorkspaceState {
    const kept = this.config.keepOnConflict || merge === 'skipped';
    this.current = {
      ...this.current,
      merge,
      detail: kept && this.current.branch !== undefined
        ? `${detail}; the work is on ${this.current.branch}`
        : detail,
    };
    return this.current;
  }
}

/** One readable line for a caught value. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
