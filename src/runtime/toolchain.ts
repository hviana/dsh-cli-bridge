/**
 * Getting and keeping the delegate CLIs.
 *
 * The managed mode installs each CLI into a private npm prefix inside the
 * plugin's state directory. That choice is the portable one: it needs no
 * elevation on any platform, cannot collide with a system package manager, and
 * is removed by deleting a directory. A CLI the user already has on `PATH` is
 * used as-is rather than reinstalled.
 *
 * What it resolves is an ARGV, not a path — see [launch](./launch.ts) for why a
 * bare path is not enough on Windows.
 *
 * @module dsh-cli-bridge/runtime/toolchain
 */
import type { CliId, ToolchainStatus } from '../shared/protocol.ts';
import { CLI_IDS } from '../shared/protocol.ts';
import { adapterFor } from '../domain/adapters/index.ts';
import type { DelegateConfig, ToolchainConfig } from '../config.ts';
import { BridgeError, describeError } from './errors.ts';
import { runProcess } from './exec.ts';
import {
  binEntry,
  composeArgv,
  globalPackageDir,
  isJavaScriptEntry,
  npmEntryCandidates,
  pathFor,
} from './launch.ts';
import type { BridgePaths } from './paths.ts';
import type { FilePort, ProcessPort } from './ports.ts';

/** A delegate CLI located on this machine, ready to spawn. */
export interface Executable {
  readonly cli: CliId;
  /**
   * The argv prefix that runs it: either `[node, entry.js]` for a package this
   * plugin can see inside, or the executable itself, or a `cmd.exe` wrapper.
   */
  readonly argv: readonly string[];
  /** What to show a human — the executable or entry point this resolves to. */
  readonly path: string;
  /** Where it came from. */
  readonly source: 'managed' | 'path' | 'configured';
}

/** What the managed installer remembers between runs. */
interface ToolchainRecord {
  readonly version?: string;
  readonly updatedAt?: number;
}

type ToolchainDocument = Partial<Record<CliId, ToolchainRecord>>;

/** Live output of an install, so a human can watch it happen. */
export type InstallSink = (stream: 'stdout' | 'stderr', text: string) => void;

/**
 * Resolution, installation and update of the delegate CLIs.
 *
 * Resolution results are cached per delegate because they are consulted on
 * every run and an executable does not move underneath a live process; an
 * install or update invalidates the entry it changed.
 */
export class Toolchain {
  private readonly resolved = new Map<CliId, Executable>();
  /**
   * Probed versions, keyed by resolved argv. An executable's version cannot
   * change under a live process without an install, and an install clears the
   * entry it replaced — so the status surface is free to be read often.
   */
  private readonly versions = new Map<string, string | undefined>();
  private document: ToolchainDocument | undefined;
  private readonly inflight = new Map<CliId, Promise<Executable>>();
  private npmArgv: readonly string[] | undefined;

  constructor(
    private readonly paths: BridgePaths,
    private readonly files: FilePort,
    private readonly process: ProcessPort,
    private readonly now: () => number,
    private readonly platform: NodeJS.Platform,
    private readonly nodePath: string,
    private readonly config: ToolchainConfig,
    private readonly delegates: Readonly<Record<CliId, DelegateConfig>>,
  ) {}

  /**
   * Report every delegate's installation state, without installing anything.
   * @param signal - cancels the version probes.
   * @returns one status per delegate, in listing order.
   */
  async statuses(signal?: AbortSignal): Promise<ToolchainStatus[]> {
    const document = await this.read();
    return Promise.all(CLI_IDS.map(async (cli): Promise<ToolchainStatus> => {
      const executable = await this.locate(cli);
      if (executable === undefined) return { cli, source: 'missing' };
      const record = document[cli];
      const version = await this.probeVersion(executable, signal);
      return {
        cli,
        path: executable.path,
        source: executable.source,
        ...version === undefined ? {} : { version },
        ...record?.updatedAt === undefined
          ? {}
          : { updatedAt: record.updatedAt },
      };
    }));
  }

  /**
   * Resolve a delegate's executable, installing it first when that is allowed.
   *
   * Concurrent callers share one install: the second run of a fresh profile
   * waits for the first one's npm rather than racing it into the same prefix.
   * @param cli - the delegate.
   * @param sink - live installer output.
   * @param signal - cancels the install.
   * @returns the located executable.
   * @throws {BridgeError} `CLI_MISSING` or `TOOLCHAIN_DISABLED` when it cannot be had.
   */
  async ensure(
    cli: CliId,
    sink?: InstallSink,
    signal?: AbortSignal,
  ): Promise<Executable> {
    const located = await this.locate(cli);
    if (located !== undefined) return located;
    if (this.config.mode !== 'managed' || !this.config.autoInstall) {
      throw new BridgeError(
        `${adapterFor(cli).displayName} is not available` +
          (this.config.mode === 'managed'
            ? ' and automatic setup is off'
            : ` and setup is set to ${this.config.mode}`),
        this.config.mode === 'managed' ? 'CLI_MISSING' : 'TOOLCHAIN_DISABLED',
      );
    }
    const pending = this.inflight.get(cli) ??
      this.startInstall(cli, sink, signal);
    this.inflight.set(cli, pending);
    try {
      return await pending;
    } finally {
      this.inflight.delete(cli);
    }
  }

  /**
   * Install or update one delegate into the managed prefix.
   * @param cli - the delegate.
   * @param sink - live installer output.
   * @param signal - cancels the install.
   * @returns the delegate's status afterwards.
   * @throws {BridgeError} `TOOLCHAIN_DISABLED` or `INSTALL_FAILED`.
   */
  async install(
    cli: CliId,
    sink?: InstallSink,
    signal?: AbortSignal,
  ): Promise<ToolchainStatus> {
    if (this.config.mode !== 'managed') {
      throw new BridgeError(
        `toolchain.mode is ${this.config.mode}; managed installs are off`,
        'TOOLCHAIN_DISABLED',
      );
    }
    await this.startInstall(cli, sink, signal);
    const [status] = await this.statuses(signal).then((all) =>
      all.filter((entry) => entry.cli === cli)
    );
    /* v8 ignore next -- statuses() always yields one entry per delegate. */
    if (status === undefined) {
      throw new BridgeError(
        `${cli} disappeared after installing`,
        'CLI_MISSING',
      );
    }
    return status;
  }

  /**
   * Update every managed delegate whose install is older than the configured
   * interval. Called on a timer by the plugin; a delegate that is not managed,
   * or was updated recently, is skipped without touching the network.
   * @param sink - live installer output.
   * @param signal - cancels the updates.
   * @returns the delegates that were updated.
   */
  async refreshStale(
    sink?: InstallSink,
    signal?: AbortSignal,
  ): Promise<CliId[]> {
    if (this.config.mode !== 'managed' || this.config.updateIntervalMs <= 0) {
      return [];
    }
    const document = await this.read();
    const due: CliId[] = [];
    for (const cli of CLI_IDS) {
      const record = document[cli];
      if (record?.updatedAt === undefined) continue;
      if (this.now() - record.updatedAt < this.config.updateIntervalMs) {
        continue;
      }
      due.push(cli);
    }
    // Sequential on purpose: two concurrent npm installs would contend for the
    // same cache and interleave their output into one unreadable stream.
    // oxlint-disable-next-line eslint/no-await-in-loop
    for (const cli of due) await this.startInstall(cli, sink, signal);
    return due;
  }

  /** Run the managed install and record what it produced. */
  private async startInstall(
    cli: CliId,
    sink: InstallSink | undefined,
    signal?: AbortSignal,
  ): Promise<Executable> {
    const adapter = adapterFor(cli);
    const prefix = this.paths.toolchainPrefix(cli);
    await this.files.makeDirectory(prefix);
    const npm = await this.resolveNpm(signal);
    const result = await runProcess(this.process, {
      argv: composeArgv(npm, [
        'install',
        '--global',
        '--prefix',
        prefix,
        '--no-audit',
        '--no-fund',
        ...this.config.registry.length > 0
          ? ['--registry', this.config.registry]
          : [],
        `${adapter.npmPackage}@latest`,
      ]),
      cwd: prefix,
      env: {},
      graceMs: 5000,
      maxTailBytes: 8192,
      timeoutMs: this.config.installTimeoutMs,
      ...signal === undefined ? {} : { signal },
      ...sink === undefined ? {} : { onOutput: sink },
    }, this.now);

    if (result.exitCode !== 0) {
      throw new BridgeError(
        `installing ${adapter.npmPackage} failed: ${
          result.stderr.trim() || `exit code ${String(result.exitCode)}`
        }`,
        'INSTALL_FAILED',
      );
    }

    this.resolved.delete(cli);
    this.versions.clear();
    const executable = await this.locate(cli);
    if (executable === undefined) {
      throw new BridgeError(
        `${adapter.npmPackage} installed but no ${adapter.command} entry point appeared`,
        'INSTALL_FAILED',
      );
    }
    const version = await this.probeVersion(executable, signal);
    await this.record(cli, {
      ...version === undefined ? {} : { version },
      updatedAt: this.now(),
    });
    return executable;
  }

  /**
   * Locate a delegate's executable without installing.
   *
   * Order is deliberate: an explicitly configured path is the deployment's
   * decision; a managed install is this plugin's own and therefore the one it
   * can keep current; and `PATH` is the machine's, used as it is.
   * @param cli - the delegate.
   * @returns the executable, or `undefined` when there is none.
   */
  private async locate(cli: CliId): Promise<Executable | undefined> {
    const cached = this.resolved.get(cli);
    if (cached !== undefined) return cached;
    const found = await this.search(cli);
    if (found !== undefined) this.resolved.set(cli, found);
    return found;
  }

  /** The uncached half of {@link locate}. */
  private async search(cli: CliId): Promise<Executable | undefined> {
    const adapter = adapterFor(cli);
    const configured = this.delegates[cli].executable;
    if (configured.length > 0) {
      const path = await this.verify(configured);
      if (path === undefined) {
        throw new BridgeError(
          `delegates.${cli}.executable points at ${configured}, which is not an executable`,
          'CLI_MISSING',
        );
      }
      return { cli, source: 'configured', path, argv: this.launch(path) };
    }
    if (this.config.mode === 'managed') {
      const managed = await this.managedEntry(cli);
      if (managed !== undefined) return managed;
    }
    const onPath = await this.verify(adapter.command);
    return onPath === undefined
      ? undefined
      : { cli, source: 'path', path: onPath, argv: this.launch(onPath) };
  }

  /**
   * Resolve a managed install to a spawnable argv.
   *
   * The package's own `bin` entry is preferred over the platform shim, because a
   * Windows `.cmd` cannot be spawned without a shell at all. What that entry
   * needs depends on what it IS: Codex ships a JavaScript launcher, which takes
   * this process's Node in front of it, and Claude Code ships a per-platform
   * native binary, which must be spawned as itself.
   * @param cli - the delegate.
   * @returns the executable, or `undefined` when nothing is installed.
   */
  private async managedEntry(cli: CliId): Promise<Executable | undefined> {
    const adapter = adapterFor(cli);
    const path = pathFor(this.platform);
    const prefix = this.paths.toolchainPrefix(cli);
    const packageDir = globalPackageDir(
      prefix,
      adapter.npmPackage,
      this.platform,
    );
    const manifest = await this.readJson(path.join(packageDir, 'package.json'));
    const entry = manifest === undefined
      ? undefined
      : binEntry(manifest, adapter.command);
    if (entry !== undefined) {
      const script = path.join(packageDir, entry);
      if (await this.files.exists(script)) {
        return {
          cli,
          source: 'managed',
          path: script,
          argv: this.launch(script),
        };
      }
    }
    // No readable manifest (a native build, an unusual layout): fall back to
    // whatever the installer put in the prefix's bin position.
    const shim = this.platform === 'win32'
      ? path.join(prefix, `${adapter.command}.cmd`)
      : path.join(prefix, 'bin', adapter.command);
    return await this.files.exists(shim)
      ? { cli, source: 'managed', path: shim, argv: this.launch(shim) }
      : undefined;
  }

  /**
   * The launch prefix for one resolved path.
   *
   * What a path IS decides how it runs, and the rule is the same wherever the
   * path came from: JavaScript takes this process's Node in front of it, and
   * anything else is spawned as itself. A Windows batch shim stays a bare path
   * here — wrapping it in `cmd.exe` belongs to {@link composeArgv}, the only
   * place that knows the arguments it has to be quoted together with.
   * @param path - the resolved executable or entry point.
   * @returns the launch prefix.
   */
  private launch(path: string): readonly string[] {
    return isJavaScriptEntry(path) ? [this.nodePath, path] : [path];
  }

  /** Resolve a command through the provider, answering `undefined` when absent. */
  private async verify(command: string): Promise<string | undefined> {
    try {
      return await this.process.resolveExecutable(command);
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve npm to a spawnable argv.
   *
   * npm's own entry point beside this Node executable wins over the `npm`
   * command for the same reason a delegate's does: on Windows the command is a
   * batch shim, and a shell-free spawn cannot run one.
   * @param signal - cancels the lookup.
   * @returns the argv prefix that runs npm.
   */
  private async resolveNpm(signal?: AbortSignal): Promise<readonly string[]> {
    if (this.npmArgv !== undefined) return this.npmArgv;
    // Only the default command may be satisfied by npm's bundled entry point; a
    // configured command names something specific and must be honored as named.
    if (this.config.npmCommand === 'npm') {
      for (const candidate of npmEntryCandidates(this.nodePath)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- first hit wins
        if (await this.files.exists(candidate)) {
          this.npmArgv = [this.nodePath, candidate];
          return this.npmArgv;
        }
      }
    }
    try {
      const path = await this.process.resolveExecutable(
        this.config.npmCommand,
        undefined,
        signal,
      );
      this.npmArgv = this.launch(path);
      return this.npmArgv;
    } catch (error) {
      throw new BridgeError(
        `toolchain.npmCommand ${
          JSON.stringify(this.config.npmCommand)
        } was not found: ${describeError(error)}`,
        'INSTALL_FAILED',
        { cause: error },
      );
    }
  }

  /** Ask an executable for its version, tolerating a CLI that refuses to say. */
  private async probeVersion(
    executable: Executable,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const key = executable.argv.join(' ');
    const cached = this.versions.get(key);
    if (cached !== undefined || this.versions.has(key)) return cached;
    const adapter = adapterFor(executable.cli);
    try {
      const result = await runProcess(this.process, {
        argv: composeArgv(executable.argv, adapter.versionArgv()),
        cwd: this.paths.root,
        env: {},
        graceMs: 2000,
        maxTailBytes: 1024,
        timeoutMs: 30_000,
        ...signal === undefined ? {} : { signal },
      }, this.now);
      const version = adapter.parseVersion(
        `${result.stdout}\n${result.stderr}`,
      );
      this.versions.set(key, version);
      return version;
    } catch {
      return undefined;
    }
  }

  /** Read the installer's bookkeeping, tolerating anything that is not it. */
  private async read(): Promise<ToolchainDocument> {
    if (this.document !== undefined) return this.document;
    const raw = await this.readJson(this.paths.toolchainState);
    this.document = typeof raw === 'object' && raw !== null
      ? raw as ToolchainDocument
      : {};
    return this.document;
  }

  /** Read and parse a JSON document, or `undefined` when it is absent or invalid. */
  private async readJson(path: string): Promise<unknown> {
    const text = await this.files.readText(path);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /** Persist one delegate's install record. */
  private async record(cli: CliId, entry: ToolchainRecord): Promise<void> {
    const document = { ...await this.read(), [cli]: entry };
    this.document = document;
    await this.files.writeText(
      this.paths.toolchainState,
      `${JSON.stringify(document, undefined, 2)}\n`,
    );
  }
}
