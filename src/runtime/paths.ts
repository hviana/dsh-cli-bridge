/**
 * Where the plugin keeps its state, and what may be called an account.
 *
 * Account ids become directory names on the user's disk, so they are validated
 * against the strictest of the three platforms rather than the current one: an
 * id created on Linux must still be a legal, unambiguous directory name when
 * the same state directory is opened on Windows or macOS.
 *
 * @module dsh-cli-bridge/runtime/paths
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CliId } from '../shared/protocol.ts';

/** Environment variable that relocates the harness home. */
export const DSH_HOME_ENV = 'DSH_HOME';

/** Directory the harness keeps user data in, under the OS home. */
export const DSH_HOME_DIR_NAME = '.dsh';

/** Directory this plugin owns inside the harness home. */
export const BRIDGE_DIR_NAME = 'cli-bridge';

/**
 * Resolve the plugin's state directory.
 * @param configured - the `stateDir` config value; empty derives the default.
 * @param env - the environment to read `DSH_HOME` from.
 * @returns an absolute directory path.
 */
export function resolveStateDir(
  configured: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (configured.trim().length > 0) return resolve(configured);
  const home = env[DSH_HOME_ENV];
  const harnessHome = home !== undefined && home.trim().length > 0
    ? resolve(home)
    : join(homedir(), DSH_HOME_DIR_NAME);
  return join(harnessHome, BRIDGE_DIR_NAME);
}

/** The filesystem layout of one state directory. */
export class BridgePaths {
  constructor(readonly root: string) {}

  /** The account registry document. */
  get registry(): string {
    return join(this.root, 'accounts.json');
  }

  /** The resumable-session ledger — the resume handles that survive a reload. */
  get sessions(): string {
    return join(this.root, 'sessions.json');
  }

  /** The managed toolchain's bookkeeping document. */
  get toolchainState(): string {
    return join(this.root, 'toolchain', 'state.json');
  }

  /**
   * Private npm prefix one delegate CLI is installed into.
   * @param cli - the delegate.
   * @returns the prefix directory.
   */
  toolchainPrefix(cli: CliId): string {
    return join(this.root, 'toolchain', cli);
  }

  /** Directory holding one isolated worktree per delegation. */
  get worktrees(): string {
    return join(this.root, 'worktrees');
  }

  /**
   * Private CLI home of one account — the directory that IS the account.
   * @param cli - the delegate.
   * @param id - the validated account id.
   * @returns the home directory.
   */
  accountHome(cli: CliId, id: string): string {
    return join(this.root, 'homes', cli, id);
  }
}

/** Names Windows refuses as a path segment, in any letter case, with or without an extension. */
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_unused, index) => `com${String(index + 1)}`),
  ...Array.from({ length: 9 }, (_unused, index) => `lpt${String(index + 1)}`),
]);

/** Shape an account id must have to be a safe directory name everywhere. */
const ACCOUNT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/** An account id that cannot be used. */
export class InvalidAccountIdError extends Error {
  constructor(id: string, reason: string) {
    super(`invalid account id ${JSON.stringify(id)}: ${reason}`);
    this.name = 'InvalidAccountIdError';
  }
}

/**
 * Validate an account id.
 *
 * The rules are portability rules, not taste: lowercase because macOS and
 * Windows compare filenames case-insensitively and `Work` and `work` must not
 * become two ids for one directory; no reserved device names; no trailing dot
 * or space, which Windows silently strips.
 * @param id - the candidate id.
 * @returns the same id, proven safe.
 * @throws {InvalidAccountIdError} when the id could not be a directory name everywhere.
 */
export function assertAccountId(id: string): string {
  if (!ACCOUNT_ID.test(id)) {
    throw new InvalidAccountIdError(
      id,
      'use 1–64 characters of a–z, 0–9, dot, dash or underscore, starting alphanumeric',
    );
  }
  if (WINDOWS_RESERVED.has(id.split('.')[0] ?? id)) {
    throw new InvalidAccountIdError(id, 'this name is reserved by Windows');
  }
  if (id.endsWith('.')) {
    throw new InvalidAccountIdError(id, 'a trailing dot is dropped by Windows');
  }
  return id;
}
