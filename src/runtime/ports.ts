/**
 * The runtime's ports.
 *
 * Everything below this line is the outside world: processes, the filesystem,
 * the credential store, the clock. The runtime never imports them directly, so
 * every behaviour in this package is exercised in a test without spawning a
 * process or writing a byte — and the plugin's composition root is the only
 * place a real implementation appears.
 *
 * The process port is deliberately typed with the harness's own subprocess
 * vocabulary: `ctx.subprocess` satisfies it structurally, so the seam costs no
 * adapter, and a remote-sandbox subprocess provider moves the delegate CLIs
 * with it for free.
 *
 * @module dsh-cli-bridge/runtime/ports
 */
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess';
import type { LlmPort } from './advisor.ts';
import type { UserQuestionsPort } from './inquiry.ts';

/** The slice of `ctx.subprocess` this plugin uses. */
export interface ProcessPort {
  /**
   * Resolve an executable in the provider's execution world.
   * @param command - absolute path or bare name.
   * @param env - environment entries used for the lookup.
   * @param signal - cancels the lookup.
   * @returns the canonical executable path.
   */
  resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string>;
  /**
   * Start a managed child process.
   * @param spec - the fully specified spawn.
   * @returns the live handle.
   */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
  /**
   * Allocate a terminal and start a process session in it.
   * @param spec - the fully specified terminal spawn.
   * @returns the live terminal handle.
   */
  spawnTerminal(
    spec: SubprocessTerminalSpawnSpec,
  ): Promise<SubprocessTerminalHandle>;
}

/** The filesystem operations the account and toolchain stores need. */
export interface FilePort {
  /**
   * Read a UTF-8 file.
   * @param path - absolute path.
   * @returns the contents, or `undefined` when the file does not exist.
   */
  readText(path: string): Promise<string | undefined>;
  /**
   * Write a UTF-8 file, creating parent directories, replacing any existing
   * file atomically so a crash cannot leave a half-written registry.
   * @param path - absolute path.
   * @param text - the contents.
   */
  writeText(path: string, text: string): Promise<void>;
  /**
   * Create a directory and its parents; succeeds when it already exists.
   * @param path - absolute path.
   */
  makeDirectory(path: string): Promise<void>;
  /**
   * Remove a directory and everything under it; succeeds when it is absent.
   * @param path - absolute path.
   */
  removeDirectory(path: string): Promise<void>;
  /**
   * Test whether a path exists.
   * @param path - absolute path.
   * @returns whether anything is there.
   */
  exists(path: string): Promise<boolean>;
}

/**
 * The harness credential seam, narrowed to the one read this plugin performs.
 * Absent in a composition without `ctx.credentials`, in which case API-key
 * accounts report themselves unconfigured rather than failing the plugin.
 */
export interface CredentialPort {
  /**
   * Resolve one credential reference.
   * @param ref - the environment-variable-shaped reference.
   * @returns the value, or `undefined` while unconfigured.
   */
  resolve(ref: string): Promise<string | undefined>;
}

/** Everything the runtime needs from outside itself. */
export interface RuntimePorts {
  readonly process: ProcessPort;
  readonly files: FilePort;
  /** Absent when the composition provides no credential service. */
  readonly credentials?: CredentialPort;
  /**
   * The model seam, for the autonomous decisions.
   *
   * Absent when the composition has no model service — in which case autonomy
   * has nothing to consult and every question goes to the human.
   */
  readonly llm?: LlmPort;
  /**
   * The human-question seam.
   *
   * Absent when the composition has no interactive surface — in which case a
   * delegate's question is returned to the caller instead.
   */
  readonly questions?: UserQuestionsPort;
  /** Epoch milliseconds. Injected so run timings are deterministic under test. */
  readonly now: () => number;
  /** Host platform, consulted only where a real OS difference exists. */
  readonly platform: NodeJS.Platform;
  /**
   * Absolute path of the running Node executable.
   *
   * The toolchain runs npm-installed CLIs as `node <entry>` rather than through
   * their platform shims, so it needs the interpreter it is already running on.
   */
  readonly nodePath: string;
}
