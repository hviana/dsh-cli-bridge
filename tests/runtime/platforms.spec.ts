/**
 * The operating-system matrix.
 *
 * Everything that differs per platform is here, driven through the same code
 * path a real run takes: npm's global layout, which entry point is spawnable,
 * the Windows batch shim, the account home variables, and the state paths. The
 * platform is an injected port, so all three are exercised on whichever machine
 * runs the suite — which is the only way a Linux CI run can defend Windows.
 */
import { describe, expect, it } from 'vitest';
import { Config } from '../../src/config.ts';
import { adapterFor } from '../../src/domain/adapters/index.ts';
import { AccountStore } from '../../src/runtime/accounts.ts';
import { StreamHub } from '../../src/runtime/channel.ts';
import {
  composeArgv,
  globalPackageDir,
  pathFor,
} from '../../src/runtime/launch.ts';
import { BridgePaths } from '../../src/runtime/paths.ts';
import { RunRegistry } from '../../src/runtime/registry.ts';
import { Toolchain } from '../../src/runtime/toolchain.ts';
import type { CliId } from '../../src/shared/protocol.ts';
import { fakeClock, FakeProcessPort, MemoryFiles } from '../support/fakes.ts';
import { transcriptFor } from '../support/delegation.ts';

/** One supported platform, and what a delegate install looks like on it. */
const PLATFORMS = [
  { platform: 'linux' as NodeJS.Platform, node: '/usr/bin/node' },
  { platform: 'darwin' as NodeJS.Platform, node: '/usr/local/bin/node' },
  {
    platform: 'win32' as NodeJS.Platform,
    node: 'C:\\Program Files\\nodejs\\node.exe',
  },
] as const;

/** What each delegate's npm package actually ships as its `bin` entry. */
const ENTRIES: Readonly<Record<CliId, { bin: string; spawnsNode: boolean }>> = {
  // A native binary on every platform: putting Node in front of it would fail.
  claude: { bin: 'bin/claude.exe', spawnsNode: false },
  // A JavaScript launcher: it needs this process's Node in front of it.
  codex: { bin: 'bin/codex.js', spawnsNode: true },
};

function build(
  platform: NodeJS.Platform,
  node: string,
  options: { installed?: readonly string[] } = {},
) {
  const config = new Config({ toolchain: { mode: 'managed' } });
  const paths = new BridgePaths(platform === 'win32' ? 'C:\\state' : '/state');
  const files = new MemoryFiles();
  const clock = fakeClock();
  const process = new FakeProcessPort(
    (
      spec,
    ) => (spec.argv.some((part) => part.includes('--version'))
      ? { stdout: ['1.2.3'] }
      : { stdout: transcriptFor(spec.argv, 'Done.') }),
  );
  for (const path of options.installed ?? []) files.directories.add(path);
  const hub = new StreamHub(65_536, clock.now);
  const accounts = new AccountStore(paths, files, clock.now, {
    resolve: async () => 'sk-test',
  });
  const toolchain = new Toolchain(
    paths,
    files,
    process,
    clock.now,
    platform,
    node,
    config.toolchain,
    config.delegates,
  );
  const runs = new RunRegistry({
    hub,
    accounts,
    toolchain,
    process,
    config,
    now: clock.now,
  });
  return { config, paths, files, process, accounts, toolchain, runs };
}

/** Stage a managed install of one delegate, as its npm package lays it out. */
async function install(
  context: ReturnType<typeof build>,
  cli: CliId,
  platform: NodeJS.Platform,
) {
  const adapter = adapterFor(cli);
  const path = pathFor(platform);
  const prefix = context.paths.toolchainPrefix(cli);
  const packageDir = globalPackageDir(prefix, adapter.npmPackage, platform);
  const entry = ENTRIES[cli];
  await context.files.writeText(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ bin: { [adapter.command]: entry.bin } }),
  );
  context.files.directories.add(path.join(packageDir, entry.bin));
  return { packageDir, entry };
}

describe.each(PLATFORMS)('on $platform', ({ platform, node }) => {
  it.each(['claude', 'codex'] as const)(
    'spawns a managed %s the way its package ships',
    async (cli) => {
      const context = build(platform, node);
      const { packageDir, entry } = await install(context, cli, platform);
      const script = pathFor(platform).join(packageDir, entry.bin);

      const status = (await context.toolchain.statuses()).find((entry_) =>
        entry_.cli === cli
      );
      expect(status).toMatchObject({
        source: 'managed',
        path: script,
        version: '1.2.3',
      });

      const started = await context.runs.start({
        cli,
        prompt: 'Port the parser.',
        cwd: platform === 'win32' ? 'C:\\repo' : '/repo',
        permission: 'workspace-write',
      });
      expect((await started.settled).status).toBe('completed');

      const spawn = context.process.spawns.at(-1)?.spec;
      expect(spawn?.argv[0]).toBe(entry.spawnsNode ? node : script);
      if (entry.spawnsNode) expect(spawn?.argv[1]).toBe(script);
      // Whatever the launcher, the delegate's own flags follow it verbatim.
      expect(spawn?.argv).toContain(cli === 'claude' ? '--print' : 'exec');
    },
  );

  it('gives each account its own CLI home, in that CLI’s own variable', async () => {
    const context = build(platform, node);
    await install(context, 'claude', platform);
    await context.accounts.add({ cli: 'claude', id: 'work', auth: 'session' });
    const started = await context.runs.start({
      cli: 'claude',
      prompt: 'x',
      account: 'work',
      cwd: platform === 'win32' ? 'C:\\repo' : '/repo',
      permission: 'read-only',
    });
    await started.settled;

    const env = context.process.spawns.at(-1)?.spec.env ?? {};
    expect(env['CLAUDE_CONFIG_DIR']).toBe(
      context.paths.accountHome('claude', 'work'),
    );
    // The home is under the state directory, so it is a real path on this
    // platform — whatever separator the host's own `path` module uses.
    expect(env['CLAUDE_CONFIG_DIR']).toContain('state');
  });

  it('reads npm’s global layout as npm lays it out here', () => {
    const dir = globalPackageDir(
      platform === 'win32' ? 'C:\\prefix' : '/prefix',
      '@openai/codex',
      platform,
    );
    expect(dir).toBe(
      pathFor(platform).join(
        platform === 'win32' ? 'C:\\prefix' : '/prefix',
        ...(platform === 'win32' ? ['node_modules'] : ['lib', 'node_modules']),
        '@openai',
        'codex',
      ),
    );
  });
});

describe('a CLI that is only reachable through a batch shim', () => {
  it('quotes the shim and every argument into one cmd.exe command', () => {
    const argv = composeArgv(['C:\\tools\\claude.cmd'], [
      '--print',
      '--model',
      'opus 4.5',
    ]);
    expect(argv.slice(0, 4)).toEqual(['cmd.exe', '/d', '/s', '/c']);
    expect(argv).toHaveLength(5);
    expect(argv.at(-1)).toBe(
      '"C:\\tools\\claude.cmd" "--print" "--model" "opus 4.5"',
    );
  });

  it('cannot be talked into running a second command', () => {
    const argv = composeArgv(['C:\\tools\\claude.cmd'], [
      '--print',
      'x & del /q *',
    ]);
    // The ampersand is escaped for cmd, so it stays part of the argument.
    expect(argv.at(-1)).toContain('x ^& del /q *');
  });

  it('leaves every other executable exactly as it is', () => {
    expect(composeArgv(['/usr/bin/node', '/opt/codex.js'], ['exec', '--json']))
      .toEqual(['/usr/bin/node', '/opt/codex.js', 'exec', '--json']);
    expect(composeArgv(['/usr/local/bin/claude'], ['--print'])).toEqual([
      '/usr/local/bin/claude',
      '--print',
    ]);
  });
});
