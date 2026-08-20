/**
 * The git commands this plugin runs, and nothing else.
 *
 * Isolation and merging are the only reasons it touches a repository, so the
 * port is exactly that vocabulary — no general-purpose git wrapper, no shell
 * strings. Every command goes through the harness's subprocess seam as an argv,
 * so the same rules that govern a delegate govern this.
 *
 * @module dsh-cli-bridge/runtime/git
 */
import { runProcess } from './exec.ts';
import type { ProcessPort } from './ports.ts';

/** How a merge ended. */
export type MergeOutcome =
  | { readonly ok: true; readonly commit?: string }
  /** The merge stopped and was unwound; the branch still holds the work. */
  | { readonly ok: false; readonly conflict: boolean; readonly detail: string };

/** The repository operations isolation needs. */
export interface GitPort {
  /**
   * Whether a directory is inside a git working tree.
   * @param cwd - the directory to test.
   * @returns true when git can work there.
   */
  isRepository(cwd: string): Promise<boolean>;
  /**
   * The branch currently checked out.
   * @param cwd - a directory in the repository.
   * @returns the branch name, or `undefined` when the head is detached.
   */
  currentBranch(cwd: string): Promise<string | undefined>;
  /**
   * Create a worktree on a new branch.
   * @param cwd - a directory in the repository.
   * @param path - where the worktree goes.
   * @param branch - the branch to create.
   * @param base - the commit or branch to start it from.
   */
  addWorktree(
    cwd: string,
    path: string,
    branch: string,
    base: string,
  ): Promise<void>;
  /**
   * Remove a worktree and forget its registration.
   * @param cwd - a directory in the repository.
   * @param path - the worktree to remove.
   */
  removeWorktree(cwd: string, path: string): Promise<void>;
  /**
   * Whether a working tree has uncommitted changes.
   * @param cwd - the working tree.
   * @returns true when anything is modified, added or removed.
   */
  hasChanges(cwd: string): Promise<boolean>;
  /**
   * Stage everything and commit it.
   * @param cwd - the working tree.
   * @param message - the commit message.
   * @returns the new commit, or `undefined` when there was nothing to commit.
   */
  commitAll(cwd: string, message: string): Promise<string | undefined>;
  /**
   * Merge a branch into whatever is checked out here.
   * @param cwd - the working tree to merge into.
   * @param branch - the branch to merge.
   * @param message - the merge commit message.
   * @returns the outcome; a conflict is unwound before it returns.
   */
  merge(cwd: string, branch: string, message: string): Promise<MergeOutcome>;
  /**
   * Delete a branch that is fully merged.
   * @param cwd - a directory in the repository.
   * @param branch - the branch to delete.
   */
  deleteBranch(cwd: string, branch: string): Promise<void>;
  /**
   * Summarize what a worktree changed relative to its base.
   * @param cwd - the worktree.
   * @param base - the commit or branch it started from.
   * @returns `git diff --stat` output, empty when nothing changed.
   */
  diffstat(cwd: string, base: string): Promise<string>;
}

/** How the git port runs commands. */
export interface GitOptions {
  /** Wall-clock bound for one git command. */
  readonly timeoutMs: number;
  /** SIGTERM-to-SIGKILL grace when one is cancelled. */
  readonly graceMs: number;
  /** Bytes of output retained from one command. */
  readonly maxOutputBytes: number;
}

/**
 * Build the git port over the subprocess seam.
 * @param process - the subprocess seam.
 * @param now - epoch-millisecond clock.
 * @param options - command bounds.
 * @returns the port the workspace provider uses.
 */
export function commandGit(
  process: ProcessPort,
  now: () => number,
  options: GitOptions,
): GitPort {
  /** Run one git command and report its output. */
  const git = async (
    cwd: string,
    args: readonly string[],
  ): Promise<{ code: number; out: string; err: string }> => {
    const executable = await process.resolveExecutable('git');
    const result = await runProcess(process, {
      // `-c core.hooksPath=` keeps a repository's own hooks out of the plugin's
      // bookkeeping commits: this commit is a container for somebody else's
      // work, not a change the repository's policy should get a vote on.
      argv: [executable, '-c', 'core.hooksPath=', ...args],
      cwd,
      env: {},
      graceMs: options.graceMs,
      maxTailBytes: options.maxOutputBytes,
      timeoutMs: options.timeoutMs,
    }, now);
    return {
      code: result.exitCode ?? -1,
      out: result.stdout.trim(),
      err: result.stderr.trim(),
    };
  };

  /** Run a command that must succeed. */
  const must = async (
    cwd: string,
    args: readonly string[],
  ): Promise<string> => {
    const result = await git(cwd, args);
    if (result.code !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed: ${
          result.err.length > 0 ? result.err : result.out
        }`,
      );
    }
    return result.out;
  };

  return {
    async isRepository(cwd) {
      return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).out ===
        'true';
    },

    async currentBranch(cwd) {
      const result = await git(cwd, [
        'symbolic-ref',
        '--quiet',
        '--short',
        'HEAD',
      ]);
      return result.code === 0 && result.out.length > 0
        ? result.out
        : undefined;
    },

    async addWorktree(cwd, path, branch, base) {
      await must(cwd, ['worktree', 'add', '-b', branch, path, base]);
    },

    async removeWorktree(cwd, path) {
      // `--force` because the delegate may have left untracked files, and the
      // worktree is being removed only once its work is merged or preserved.
      await must(cwd, ['worktree', 'remove', '--force', path]);
    },

    async hasChanges(cwd) {
      return (await must(cwd, ['status', '--porcelain'])).length > 0;
    },

    async commitAll(cwd, message) {
      await must(cwd, ['add', '--all']);
      const result = await git(cwd, [
        'commit',
        '--no-verify',
        '--message',
        message,
      ]);
      // Nothing staged is not a failure: a delegate that changed nothing is a
      // legitimate outcome, and there is simply no commit to name.
      if (result.code !== 0) {
        if (
          /nothing to commit|nothing added/iu.test(
            `${result.out}\n${result.err}`,
          )
        ) return undefined;
        throw new Error(
          `git commit failed: ${
            result.err.length > 0 ? result.err : result.out
          }`,
        );
      }
      return (await git(cwd, ['rev-parse', 'HEAD'])).out || undefined;
    },

    async merge(cwd, branch, message) {
      const result = await git(cwd, [
        'merge',
        '--no-ff',
        '--no-edit',
        '--message',
        message,
        branch,
      ]);
      if (result.code === 0) {
        const commit = (await git(cwd, ['rev-parse', 'HEAD'])).out;
        return { ok: true, ...commit.length === 0 ? {} : { commit } };
      }
      const detail = [result.out, result.err].filter((part) => part.length > 0)
        .join('\n');
      const conflict = /conflict/iu.test(detail);
      // Leave the base branch exactly as it was; the work is still on its own
      // branch, which is what the caller is told about.
      await git(cwd, ['merge', '--abort']);
      return { ok: false, conflict, detail };
    },

    async deleteBranch(cwd, branch) {
      await must(cwd, ['branch', '--delete', branch]);
    },

    async diffstat(cwd, base) {
      // Three sources, because a delegation is reviewed BEFORE its work is
      // committed and `git diff` is blind to a file git has never seen:
      // committed work against the base, tracked edits not yet committed, and
      // the new files that make up most of what a coding agent produces.
      const committed = await git(cwd, ['diff', '--stat', `${base}...HEAD`]);
      const working = await git(cwd, ['diff', '--stat', 'HEAD']);
      const untracked = await git(cwd, [
        'ls-files',
        '--others',
        '--exclude-standard',
      ]);
      const added = untracked.out.split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((path) => ` ${path} | new file`);
      return [committed.out, working.out, added.join('\n')].filter((part) =>
        part.length > 0
      ).join('\n');
    },
  };
}
