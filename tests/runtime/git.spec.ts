import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandGit, type GitPort } from '../../src/runtime/git.ts';
import type { ProcessPort } from '../../src/runtime/ports.ts';

/**
 * A real subprocess port.
 *
 * This suite runs REAL git: worktrees, merges and conflicts are the kind of
 * thing a fake would model the way the author already believes it works, which
 * is exactly where the bugs hide.
 */
const realProcess: ProcessPort = {
  async resolveExecutable(command) {
    // A bare name: the platform's own lookup finds it, including PATHEXT on
    // Windows, so this suite runs wherever git does.
    return command;
  },
  spawn(spec) {
    const [program, ...args] = spec.argv;
    const child = spawn(program ?? '', args, {
      cwd: spec.cwd,
      env: {
        ...process.env,
        ...spec.env,
        GIT_AUTHOR_NAME: 'Bridge Test',
        GIT_AUTHOR_EMAIL: 'bridge@test.invalid',
        GIT_COMMITTER_NAME: 'Bridge Test',
        GIT_COMMITTER_EMAIL: 'bridge@test.invalid',
      } as NodeJS.ProcessEnv,
    });
    return {
      pid: child.pid ?? -1,
      stdin: child.stdin ?? undefined,
      stdout: child.stdout ?? undefined,
      stderr: child.stderr ?? undefined,
      collected: {},
      done: new Promise((resolve) =>
        child.on(
          'close',
          (code, signal) => resolve({ exitCode: code, signal: signal as null }),
        )
      ),
      terminate: () => {
        child.kill();
      },
      waitForExit: async () => true,
    };
  },
  async spawnTerminal() {
    throw new Error('not used');
  },
};

let root = '';
let repository = '';
let git: GitPort;

/** Run a git command directly, for arranging the fixtures. */
async function raw(cwd: string, ...args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    child.on(
      'close',
      (
        code,
      ) => (code === 0
        ? resolve()
        : reject(new Error(`git ${args.join(' ')} → ${String(code)}`))),
    );
  });
}

beforeEach(async () => {
  // Worktrees live beside the repository, so both hang off one root the
  // teardown removes even when a test fails part-way through.
  root = await mkdtemp(join(tmpdir(), 'cli-bridge-git-'));
  repository = join(root, 'repo');
  await mkdir(repository, { recursive: true });
  git = commandGit(realProcess, () => Date.now(), {
    timeoutMs: 60_000,
    graceMs: 2000,
    maxOutputBytes: 8192,
  });
  await raw(repository, 'init', '--initial-branch=main');
  await raw(repository, 'config', 'user.email', 'bridge@test.invalid');
  await raw(repository, 'config', 'user.name', 'Bridge Test');
  await writeFile(join(repository, 'README.md'), 'base\n', 'utf8');
  await raw(repository, 'add', '-A');
  await raw(repository, 'commit', '-m', 'base');
}, 30_000);

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('reading a repository', () => {
  it('recognizes one, and a directory that is not one', async () => {
    expect(await git.isRepository(repository)).toBe(true);
    const plain = await mkdtemp(join(tmpdir(), 'cli-bridge-plain-'));
    try {
      expect(await git.isRepository(plain)).toBe(false);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('names the checked-out branch', async () => {
    expect(await git.currentBranch(repository)).toBe('main');
  });

  it('reports a detached head as no branch', async () => {
    await raw(repository, 'checkout', '--detach');
    expect(await git.currentBranch(repository)).toBeUndefined();
  });

  it('sees a dirty working tree', async () => {
    expect(await git.hasChanges(repository)).toBe(false);
    await writeFile(join(repository, 'new.txt'), 'x', 'utf8');
    expect(await git.hasChanges(repository)).toBe(true);
  });
});

describe('isolating work in a worktree', () => {
  it('creates one on its own branch, from the base', async () => {
    const path = join(root, `wt-${String(Date.now())}`);
    await git.addWorktree(repository, path, 'cli-bridge/d1', 'main');
    try {
      expect(await git.currentBranch(path)).toBe('cli-bridge/d1');
      expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('base\n');
    } finally {
      await git.removeWorktree(repository, path).catch(() => undefined);
    }
  });

  it('commits whatever the delegate left, and merges it back', async () => {
    const path = join(root, `wt-merge-${String(Date.now())}`);
    await git.addWorktree(repository, path, 'cli-bridge/d1', 'main');
    await writeFile(join(path, 'feature.ts'), 'export const x = 1\n', 'utf8');

    const commit = await git.commitAll(path, 'add the feature');
    expect(commit).toMatch(/^[0-9a-f]{7,}$/u);

    const outcome = await git.merge(
      repository,
      'cli-bridge/d1',
      'Merge the feature',
    );
    expect(outcome.ok).toBe(true);
    expect(await readFile(join(repository, 'feature.ts'), 'utf8')).toBe(
      'export const x = 1\n',
    );

    await git.removeWorktree(repository, path);
    await git.deleteBranch(repository, 'cli-bridge/d1');
  });

  it('reports nothing to commit as no commit at all', async () => {
    const path = join(root, `wt-empty-${String(Date.now())}`);
    await git.addWorktree(repository, path, 'cli-bridge/d2', 'main');
    try {
      expect(await git.commitAll(path, 'nothing happened')).toBeUndefined();
    } finally {
      await git.removeWorktree(repository, path);
    }
  });

  it('summarizes work the delegate has not committed, new files included', async () => {
    const path = join(root, `wt-untracked-${String(Date.now())}`);
    await git.addWorktree(repository, path, 'cli-bridge/d5', 'main');
    try {
      // What a coding agent mostly produces: a file git has never seen, and an
      // edit to one it has. Neither is committed yet, and a review happens now.
      await writeFile(
        join(path, 'brand-new.ts'),
        'export const x = 1\n',
        'utf8',
      );
      await writeFile(
        join(path, 'README.md'),
        'edited by the delegate\n',
        'utf8',
      );
      const diffstat = await git.diffstat(path, 'main');
      expect(diffstat).toContain('brand-new.ts');
      expect(diffstat).toContain('README.md');
    } finally {
      await git.removeWorktree(repository, path).catch(() => undefined);
      await git.deleteBranch(repository, 'cli-bridge/d5').catch(() =>
        undefined
      );
    }
  });

  it('summarizes what changed, for a review', async () => {
    const path = join(root, `wt-diff-${String(Date.now())}`);
    await git.addWorktree(repository, path, 'cli-bridge/d3', 'main');
    try {
      await writeFile(join(path, 'feature.ts'), 'export const x = 1\n', 'utf8');
      await git.commitAll(path, 'add the feature');
      const diffstat = await git.diffstat(path, 'main');
      expect(diffstat).toContain('feature.ts');
      expect(diffstat).toContain('1 file changed');
    } finally {
      await git.removeWorktree(repository, path);
    }
  });
});

describe('paths a real machine produces', () => {
  it('works in a directory whose name has spaces, as a Windows home does', async () => {
    const path = join(root, `Work Trees ${String(Date.now())}`, 'delegate one');
    await git.addWorktree(repository, path, 'cli-bridge/space', 'main');
    try {
      await writeFile(join(path, 'spaced.ts'), 'export const x = 1\n', 'utf8');
      expect(await git.commitAll(path, 'work in a spaced path')).toMatch(
        /^[0-9a-f]{7,}$/u,
      );
      expect(await git.diffstat(path, 'main')).toContain('spaced.ts');
      expect((await git.merge(repository, 'cli-bridge/space', 'Merge it')).ok)
        .toBe(true);
    } finally {
      await git.removeWorktree(repository, path).catch(() => undefined);
      await git.deleteBranch(repository, 'cli-bridge/space').catch(() =>
        undefined
      );
    }
  });

  it('merges two delegations into the same base, one after the other', async () => {
    const stamp = String(Date.now());
    const first = join(root, `wt-a-${stamp}`);
    const second = join(root, `wt-b-${stamp}`);
    await git.addWorktree(repository, first, `cli-bridge/a-${stamp}`, 'main');
    await git.addWorktree(repository, second, `cli-bridge/b-${stamp}`, 'main');
    try {
      await writeFile(
        join(first, 'auth.ts'),
        'export const auth = 1\n',
        'utf8',
      );
      await writeFile(join(second, 'bi.ts'), 'export const bi = 1\n', 'utf8');
      await git.commitAll(first, 'auth stack');
      await git.commitAll(second, 'bi stack');

      expect(
        (await git.merge(repository, `cli-bridge/a-${stamp}`, 'Merge auth')).ok,
      ).toBe(true);
      // The second merges onto a base the first has already moved.
      expect(
        (await git.merge(repository, `cli-bridge/b-${stamp}`, 'Merge bi')).ok,
      ).toBe(true);
      expect(await readFile(join(repository, 'auth.ts'), 'utf8')).toBe(
        'export const auth = 1\n',
      );
      expect(await readFile(join(repository, 'bi.ts'), 'utf8')).toBe(
        'export const bi = 1\n',
      );
    } finally {
      await git.removeWorktree(repository, first).catch(() => undefined);
      await git.removeWorktree(repository, second).catch(() => undefined);
    }
  });
});

describe('a conflicting merge', () => {
  it('is unwound, leaving the base untouched and the work on its branch', async () => {
    const path = join(root, `wt-conflict-${String(Date.now())}`);
    await git.addWorktree(repository, path, 'cli-bridge/d4', 'main');
    await writeFile(join(path, 'README.md'), 'from the delegate\n', 'utf8');
    await git.commitAll(path, 'delegate edit');

    // The base moves underneath it, touching the same line.
    await writeFile(join(repository, 'README.md'), 'from the human\n', 'utf8');
    await raw(repository, 'commit', '-am', 'human edit');

    const outcome = await git.merge(
      repository,
      'cli-bridge/d4',
      'Merge the delegate',
    );
    expect(outcome).toMatchObject({ ok: false, conflict: true });

    // The base is exactly as the human left it, and git is not mid-merge.
    expect(await readFile(join(repository, 'README.md'), 'utf8')).toBe(
      'from the human\n',
    );
    expect(await git.hasChanges(repository)).toBe(false);
    // The delegate's work is still there, on its own branch.
    expect(await readFile(join(path, 'README.md'), 'utf8')).toBe(
      'from the delegate\n',
    );

    await git.removeWorktree(repository, path);
  });
});

describe('failures', () => {
  it('reports a command that could not run', async () => {
    await expect(
      git.addWorktree(repository, join(repository, 'wt'), 'main', 'main'),
    )
      .rejects.toThrow(/git worktree add/u);
  });
});
