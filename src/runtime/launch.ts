/**
 * Turning "a CLI" into an argv this platform can actually spawn.
 *
 * On Windows an npm-installed CLI is a `.cmd` shim, and `child_process.spawn`
 * refuses to execute one without a shell — it has since the batch-injection fix
 * of 2024. The harness's subprocess seam spawns without a shell (correctly: a
 * shell is an injection surface), so a plugin that hands it `claude.cmd` simply
 * fails on Windows.
 *
 * The way out is to skip the shim and run what the shim would have run. An npm
 * CLI's `bin` entry is one of two things, and they are not interchangeable:
 * a JavaScript file, which needs this process's Node in front of it, or a
 * native executable, which must be spawned directly — `@anthropic-ai/claude-code`
 * ships the latter, `@openai/codex` the former. So the strategies below, in
 * order:
 *
 * 1. a JavaScript `bin` entry, run with this process's Node;
 * 2. any other `bin` entry or executable, spawned as it is;
 * 3. a batch shim through `cmd.exe`, as the last resort for a CLI installed
 *    outside this plugin's control.
 *
 * @module dsh-cli-bridge/runtime/launch
 */
import { dirname, extname, join, posix, win32 } from 'node:path';

/**
 * The `node:path` implementation whose separators match one platform.
 *
 * `globalPackageDir` and the toolchain's managed-entry resolution take an
 * explicit platform, so they must shape paths for THAT platform rather than for
 * the host the test happens to run on. A simulated `win32` on a Linux host must
 * produce real backslashes, and this is the one place that decides.
 * @param platform - the platform a path is being shaped for.
 * @returns `path.win32` for Windows, `path.posix` otherwise.
 */
export function pathFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

/** Directory npm installs a package into inside a global prefix. */
export function globalPackageDir(
  prefix: string,
  pkg: string,
  platform: NodeJS.Platform,
): string {
  // npm's global layout differs by platform, and only here. The platform's own
  // path module is used rather than the host's, so the answer is shaped for the
  // platform it names on any machine.
  const path = pathFor(platform);
  const segments = pkg.split('/');
  return platform === 'win32'
    ? path.join(prefix, 'node_modules', ...segments)
    : path.join(prefix, 'lib', 'node_modules', ...segments);
}

/**
 * Read one command's entry point from a package manifest.
 * @param manifest - the parsed `package.json`.
 * @param command - the bin name to look up.
 * @returns the manifest-relative path, or `undefined` when it declares none.
 */
export function binEntry(
  manifest: unknown,
  command: string,
): string | undefined {
  if (typeof manifest !== 'object' || manifest === null) return undefined;
  const bin = (manifest as { bin?: unknown }).bin;
  if (typeof bin === 'string') return bin;
  if (typeof bin !== 'object' || bin === null) return undefined;
  const entry = (bin as Record<string, unknown>)[command];
  if (typeof entry === 'string') return entry;
  // A single-entry map under another name is still unambiguous.
  const entries = Object.values(bin as Record<string, unknown>).filter((
    value,
  ): value is string => typeof value === 'string');
  return entries.length === 1 ? entries[0] : undefined;
}

/** File extensions this process's Node can execute directly. */
const JAVASCRIPT = new Set(['.js', '.mjs', '.cjs']);

/**
 * Whether a `bin` entry is JavaScript rather than a native executable.
 *
 * The distinction is load-bearing: `node claude.exe` fails as surely as
 * executing `codex.js` without an interpreter would.
 * @param path - the entry point.
 * @returns true when Node should be put in front of it.
 */
export function isJavaScriptEntry(path: string): boolean {
  return JAVASCRIPT.has(extname(path).toLowerCase());
}

/** Whether a path is a Windows batch shim, which cannot be spawned directly. */
export function isBatchFile(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === '.cmd' || extension === '.bat';
}

/**
 * Quote one argument for `cmd.exe`.
 *
 * Only reached for a batch shim on Windows. The rules are cmd's, not a POSIX
 * shell's: a double quote is doubled, and the caret escapes cmd's own
 * metacharacters so the shim cannot be talked into running something else.
 * @param argument - the argument as the caller wrote it.
 * @returns the quoted form.
 */
export function quoteForCmd(argument: string): string {
  const escaped = argument.replaceAll('"', '""').replaceAll(
    /[&<>^|]/gu,
    (match) => `^${match}`,
  );
  return `"${escaped}"`;
}

/**
 * Build the argv for a batch shim.
 * @param executable - the `.cmd` or `.bat` path.
 * @param args - the arguments to pass through.
 * @returns an argv that runs the shim through `cmd.exe`.
 */
export function batchArgv(
  executable: string,
  args: readonly string[],
): readonly string[] {
  // /d skips AutoRun scripts, /s keeps the quoting rules predictable, /c runs
  // and exits. The whole command is one argument, as cmd expects.
  return [
    'cmd.exe',
    '/d',
    '/s',
    '/c',
    [executable, ...args].map(quoteForCmd).join(' '),
  ];
}

/**
 * Compose the argv for one invocation of a resolved executable.
 *
 * Concatenation is right for everything except a batch shim, and wrong for that
 * one in a way that only shows up on Windows: `cmd.exe /c` takes ONE command
 * string, so the shim and every argument have to be quoted into it together.
 * Appending them after the string hands cmd a second, unquoted command line —
 * which is both broken and an injection surface, since the delegate's own
 * arguments would then be re-parsed by the shell.
 * @param executable - the resolved launch prefix.
 * @param args - the arguments for this invocation.
 * @returns the argv to spawn.
 */
export function composeArgv(
  executable: readonly string[],
  args: readonly string[],
): readonly string[] {
  const [only, ...rest] = executable;
  return only !== undefined && rest.length === 0 && isBatchFile(only)
    ? batchArgv(only, args)
    : [...executable, ...args];
}

/**
 * Candidate locations of npm's own entry point beside a Node executable.
 *
 * Both layouts are tried on both platforms: version managers move things
 * around, and an existence check is cheaper than being wrong.
 * @param nodePath - absolute path of the running Node executable.
 * @returns manifest-free candidate paths, most likely first.
 */
export function npmEntryCandidates(nodePath: string): readonly string[] {
  const directory = dirname(nodePath);
  return [
    join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(directory, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
}
