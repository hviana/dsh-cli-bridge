import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Config } from '../../src/config.ts';
import type {
  Config as ResolvedConfig,
  ToolchainConfig,
} from '../../src/config.ts';
import { globalPackageDir, pathFor } from '../../src/runtime/launch.ts';
import { BridgePaths } from '../../src/runtime/paths.ts';
import { Toolchain } from '../../src/runtime/toolchain.ts';
import type { CliId } from '../../src/shared/protocol.ts';
import {
  fakeClock,
  FakeProcessPort,
  MemoryFiles,
  type ProcessScript,
} from '../support/fakes.ts';

const paths = new BridgePaths('/state');
const NODE = '/usr/bin/node';
const defaults: ResolvedConfig = new Config({});

/**
 * Where production resolves one CLI's managed shim on a platform: the host
 * state prefix, joined with the platform's own separators.
 */
function managedShim(
  cli: CliId,
  platform: NodeJS.Platform,
  ...segments: readonly string[]
): string {
  return pathFor(platform).join(paths.toolchainPrefix(cli), ...segments);
}

function build(options: {
  toolchain?: Partial<ToolchainConfig>;
  platform?: NodeJS.Platform;
  script?: (argv: readonly string[]) => ProcessScript;
  onPath?: readonly string[];
  installed?: readonly string[];
} = {}) {
  const files = new MemoryFiles();
  for (const path of options.installed ?? []) files.directories.add(path);
  const clock = fakeClock();
  const port = new FakeProcessPort((spec) =>
    options.script?.(spec.argv) ?? { stdout: ['1.2.3'] }
  );
  for (const command of options.onPath ?? []) port.resolvable.add(command);
  const toolchain = new Toolchain(
    paths,
    files,
    port,
    clock.now,
    options.platform ?? 'linux',
    NODE,
    { ...defaults.toolchain, ...options.toolchain },
    defaults.delegates,
  );
  return { files, clock, port, toolchain };
}

describe('locating a delegate', () => {
  it('reports a missing CLI rather than guessing', async () => {
    const { toolchain } = build();
    expect(await toolchain.statuses()).toEqual([
      { cli: 'claude', source: 'missing' },
      { cli: 'codex', source: 'missing' },
    ]);
  });

  it('uses a CLI already on PATH without installing anything', async () => {
    const { toolchain, port } = build({ onPath: ['claude'] });
    const [claude] = await toolchain.statuses();
    expect(claude).toMatchObject({
      source: 'path',
      path: '/usr/bin/claude',
      version: '1.2.3',
    });
    expect(port.spawns.every((record) => !record.spec.argv.includes('install')))
      .toBe(true);
  });

  it('prefers its own managed install over PATH', async () => {
    const managed = managedShim('claude', 'linux', 'bin', 'claude');
    const { toolchain } = build({ onPath: ['claude'], installed: [managed] });
    expect((await toolchain.statuses())[0]).toMatchObject({
      source: 'managed',
      path: managed,
    });
  });

  it('finds the Windows shim where npm puts it', async () => {
    const managed = managedShim('codex', 'win32', 'codex.cmd');
    const { toolchain } = build({ platform: 'win32', installed: [managed] });
    expect((await toolchain.statuses())[1]).toMatchObject({
      source: 'managed',
      path: managed,
    });
  });

  it('honours an explicitly configured executable', async () => {
    const files = new MemoryFiles();
    const port = new FakeProcessPort(() => ({ stdout: ['9.9.9'] }));
    const toolchain = new Toolchain(
      paths,
      files,
      port,
      fakeClock().now,
      'linux',
      NODE,
      defaults.toolchain,
      {
        ...defaults.delegates,
        claude: {
          ...defaults.delegates.claude,
          executable: '/opt/claude/bin/claude',
        },
      },
    );
    expect((await toolchain.statuses())[0]).toMatchObject({
      source: 'configured',
      path: '/opt/claude/bin/claude',
    });
  });

  it('fails loudly when a configured executable is not there', async () => {
    const files = new MemoryFiles();
    const port = new FakeProcessPort(() => ({}));
    const toolchain = new Toolchain(
      paths,
      files,
      port,
      fakeClock().now,
      'linux',
      NODE,
      defaults.toolchain,
      {
        ...defaults.delegates,
        claude: {
          ...defaults.delegates.claude,
          executable: 'claude-that-is-not-there',
        },
      },
    );
    await expect(toolchain.statuses()).rejects.toMatchObject({
      code: 'CLI_MISSING',
    });
  });

  it('ignores the managed prefix when managed mode is off', async () => {
    const managed = managedShim('claude', 'linux', 'bin', 'claude');
    const { toolchain } = build({
      toolchain: { mode: 'path' },
      installed: [managed],
    });
    expect((await toolchain.statuses())[0]).toMatchObject({
      source: 'missing',
    });
  });

  it('tolerates a CLI that will not report its version', async () => {
    const { toolchain } = build({
      onPath: ['claude'],
      script: () => ({ stdout: ['who knows'] }),
    });
    expect((await toolchain.statuses())[0]?.version).toBeUndefined();
  });
});

describe('spawning what it found', () => {
  /** Stage an installed package with a readable manifest, exactly as npm lays it out. */
  function staged(platform: NodeJS.Platform, manifest: string, entry: string) {
    const files = new MemoryFiles();
    const path = pathFor(platform);
    const packageDir = globalPackageDir(
      paths.toolchainPrefix('claude'),
      '@anthropic-ai/claude-code',
      platform,
    );
    files.files.set(path.join(packageDir, 'package.json'), manifest);
    files.files.set(path.join(packageDir, entry), '#!/usr/bin/env node');
    const port = new FakeProcessPort(() => ({ stdout: ['3.1.4'] }));
    const toolchain = new Toolchain(
      paths,
      files,
      port,
      fakeClock().now,
      platform,
      NODE,
      defaults.toolchain,
      defaults.delegates,
    );
    return { toolchain, port, packageDir, path };
  }

  it('runs a JavaScript entry point with this Node, not the platform shim', async () => {
    const { toolchain, port, packageDir, path } = staged(
      'linux',
      '{"bin":{"claude":"cli.js"}}',
      'cli.js',
    );
    const entry = path.join(packageDir, 'cli.js');
    expect((await toolchain.statuses())[0]).toMatchObject({
      source: 'managed',
      path: entry,
      version: '3.1.4',
    });
    expect(port.spawns[0]?.spec.argv).toEqual([NODE, entry, '--version']);
  });

  it('spawns a native entry point as itself — Claude Code ships one', async () => {
    // The real package declares `bin/claude.exe`, an ELF or PE binary depending
    // on the platform. Putting Node in front of it would fail immediately.
    const { toolchain, port, packageDir, path } = staged(
      'linux',
      '{"bin":{"claude":"bin/claude.exe"}}',
      'bin/claude.exe',
    );
    const entry = path.join(packageDir, 'bin', 'claude.exe');
    expect((await toolchain.statuses())[0]).toMatchObject({
      source: 'managed',
      path: entry,
    });
    expect(port.spawns[0]?.spec.argv).toEqual([entry, '--version']);
  });

  it('does the same on Windows, where a .cmd shim cannot be spawned at all', async () => {
    const { toolchain, port, packageDir, path } = staged(
      'win32',
      '{"bin":{"claude":"cli.js"}}',
      'cli.js',
    );
    const entry = path.join(packageDir, 'cli.js');
    expect((await toolchain.statuses())[0]).toMatchObject({
      source: 'managed',
      path: entry,
    });
    expect(port.spawns[0]?.spec.argv).toEqual([NODE, entry, '--version']);
  });

  it('falls back to the prefix shim when the package has no readable manifest', async () => {
    const managed = managedShim('claude', 'linux', 'bin', 'claude');
    const { toolchain, port } = build({ installed: [managed] });
    expect((await toolchain.statuses())[0]).toMatchObject({
      source: 'managed',
      path: managed,
    });
    expect(port.spawns[0]?.spec.argv[0]).toBe(managed);
  });

  it('wraps a Windows shim in cmd.exe when that is all there is', async () => {
    const shim = managedShim('claude', 'win32', 'claude.cmd');
    const { toolchain, port } = build({ platform: 'win32', installed: [shim] });
    expect((await toolchain.statuses())[0]).toMatchObject({
      source: 'managed',
      path: shim,
    });
    expect(port.spawns[0]?.spec.argv.slice(0, 4)).toEqual([
      'cmd.exe',
      '/d',
      '/s',
      '/c',
    ]);
    // The shim AND its arguments are quoted into the single command string cmd
    // takes: appended after it, they would be a second, unquoted command line.
    expect(port.spawns[0]?.spec.argv).toHaveLength(5);
    expect(port.spawns[0]?.spec.argv.at(-1)).toBe(`"${shim}" "--version"`);
  });

  it('wraps a configured Windows shim too', async () => {
    const files = new MemoryFiles();
    const port = new FakeProcessPort(() => ({ stdout: ['1.0.0'] }));
    const toolchain = new Toolchain(
      paths,
      files,
      port,
      fakeClock().now,
      'win32',
      NODE,
      defaults.toolchain,
      {
        ...defaults.delegates,
        claude: {
          ...defaults.delegates.claude,
          executable: 'C:\\tools\\claude.cmd',
        },
      },
    );
    await toolchain.statuses();
    expect(port.spawns[0]?.spec.argv[0]).toBe('cmd.exe');
  });
});

describe('finding npm', () => {
  it('prefers npm’s own entry point beside this Node executable', async () => {
    const files = new MemoryFiles();
    const entry = join(
      '/opt/node/bin',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
    files.files.set(entry, '// npm');
    const port = new FakeProcessPort(
      (
        spec,
      ) => (spec.argv.includes('install')
        ? { stdout: ['ok'] }
        : { stdout: ['1.0.0'] }),
    );
    const toolchain = new Toolchain(
      paths,
      files,
      port,
      fakeClock().now,
      'linux',
      '/opt/node/bin/node',
      defaults.toolchain,
      defaults.delegates,
    );
    await expect(toolchain.install('claude')).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
    });
    expect(port.spawns[0]?.spec.argv.slice(0, 2)).toEqual([
      '/opt/node/bin/node',
      entry,
    ]);
  });

  it('falls back to the npm command when no bundled entry point is there', async () => {
    const { toolchain, port } = build({
      onPath: ['npm'],
      script: (
        argv,
      ) => (argv.includes('install')
        ? { stdout: ['ok'] }
        : { stdout: ['1.0.0'] }),
    });
    await expect(toolchain.install('claude')).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
    });
    expect(port.spawns[0]?.spec.argv[0]).toBe('/usr/bin/npm');
  });

  it('honours a configured npm command instead of the bundled entry point', async () => {
    const files = new MemoryFiles();
    files.files.set(
      join('/opt/node/bin', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      '// npm',
    );
    const port = new FakeProcessPort(() => ({ stdout: ['ok'] }));
    port.resolvable.add('pnpm');
    const toolchain = new Toolchain(
      paths,
      files,
      port,
      fakeClock().now,
      'linux',
      '/opt/node/bin/node',
      { ...defaults.toolchain, npmCommand: 'pnpm' },
      defaults.delegates,
    );
    await expect(toolchain.install('claude')).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
    });
    expect(port.spawns[0]?.spec.argv[0]).toBe('/usr/bin/pnpm');
  });
});

describe('installing a delegate', () => {
  const managed = managedShim('claude', 'linux', 'bin', 'claude');

  it('installs into the private prefix and then finds the binary', async () => {
    const files = new MemoryFiles();
    const clock = fakeClock();
    const port = new FakeProcessPort((spec) => {
      if (spec.argv.includes('install')) {
        files.directories.add(managed);
        return { stdout: ['added 1 package'] };
      }
      return { stdout: ['2.0.0'] };
    });
    port.resolvable.add('npm');
    const toolchain = new Toolchain(
      paths,
      files,
      port,
      clock.now,
      'linux',
      NODE,
      defaults.toolchain,
      defaults.delegates,
    );

    const status = await toolchain.install('claude');
    expect(status).toMatchObject({
      source: 'managed',
      path: managed,
      version: '2.0.0',
      updatedAt: clock.now(),
    });

    const install = port.spawns.map((record) => record.spec.argv).find((argv) =>
      argv.includes('install')
    );
    expect(install).toEqual([
      '/usr/bin/npm',
      'install',
      '--global',
      '--prefix',
      join('/state', 'toolchain', 'claude'),
      '--no-audit',
      '--no-fund',
      '@anthropic-ai/claude-code@latest',
    ]);
  });

  it('passes a configured registry through', async () => {
    const { toolchain, port } = build({
      toolchain: { registry: 'https://npm.internal' },
      onPath: ['npm'],
      script: (
        argv,
      ) => (argv.includes('install')
        ? { stdout: [''] }
        : { stdout: ['1.0.0'] }),
    });
    await expect(toolchain.install('claude')).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
    });
    const install = port.spawns.map((record) => record.spec.argv).find((argv) =>
      argv.includes('install')
    );
    expect(install).toContain('https://npm.internal');
  });

  it('reports npm’s own failure', async () => {
    const { toolchain } = build({
      onPath: ['npm'],
      script: (
        argv,
      ) => (argv.includes('install')
        ? { exitCode: 1, stderr: ['E404 not found'] }
        : { stdout: ['1.0.0'] }),
    });
    await expect(toolchain.install('claude')).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
    });
    await expect(toolchain.install('claude')).rejects.toThrow(/E404/u);
  });

  it('reports a missing npm as an actionable failure', async () => {
    const { toolchain } = build({ script: () => ({}) });
    await expect(toolchain.install('claude')).rejects.toThrow(/npmCommand/u);
  });

  it('refuses to install when managed mode is off', async () => {
    const { toolchain } = build({ toolchain: { mode: 'path' } });
    await expect(toolchain.install('claude')).rejects.toMatchObject({
      code: 'TOOLCHAIN_DISABLED',
    });
  });
});

describe('ensuring a delegate before a run', () => {
  it('returns an already-present CLI without touching npm', async () => {
    const { toolchain, port } = build({ onPath: ['claude'] });
    expect(await toolchain.ensure('claude')).toMatchObject({ source: 'path' });
    expect(port.spawns.some((record) => record.spec.argv.includes('install')))
      .toBe(false);
  });

  it('installs a missing CLI on first use', async () => {
    const files = new MemoryFiles();
    const managed = managedShim('codex', 'linux', 'bin', 'codex');
    const port = new FakeProcessPort((spec) => {
      if (spec.argv.includes('install')) {
        files.directories.add(managed);
        return { stdout: ['ok'] };
      }
      return { stdout: ['0.1.0'] };
    });
    port.resolvable.add('npm');
    const toolchain = new Toolchain(
      paths,
      files,
      port,
      fakeClock().now,
      'linux',
      NODE,
      defaults.toolchain,
      defaults.delegates,
    );
    expect(await toolchain.ensure('codex')).toMatchObject({
      source: 'managed',
      path: managed,
    });
  });

  it('shares one install between concurrent callers', async () => {
    const files = new MemoryFiles();
    const managed = managedShim('codex', 'linux', 'bin', 'codex');
    const port = new FakeProcessPort((spec) => {
      if (spec.argv.includes('install')) {
        files.directories.add(managed);
        return { stdout: ['ok'] };
      }
      return { stdout: ['0.1.0'] };
    });
    port.resolvable.add('npm');
    const toolchain = new Toolchain(
      paths,
      files,
      port,
      fakeClock().now,
      'linux',
      NODE,
      defaults.toolchain,
      defaults.delegates,
    );
    await Promise.all([toolchain.ensure('codex'), toolchain.ensure('codex')]);
    expect(port.spawns.filter((record) => record.spec.argv.includes('install')))
      .toHaveLength(1);
  });

  it('refuses when auto-install is off', async () => {
    const { toolchain } = build({ toolchain: { autoInstall: false } });
    await expect(toolchain.ensure('claude')).rejects.toMatchObject({
      code: 'CLI_MISSING',
    });
  });

  it('refuses when the toolchain is disabled entirely', async () => {
    const { toolchain } = build({ toolchain: { mode: 'disabled' } });
    await expect(toolchain.ensure('claude')).rejects.toMatchObject({
      code: 'TOOLCHAIN_DISABLED',
    });
  });

  it('streams installer output to the caller', async () => {
    const files = new MemoryFiles();
    const managed = managedShim('claude', 'linux', 'bin', 'claude');
    const port = new FakeProcessPort((spec) => {
      if (spec.argv.includes('install')) {
        files.directories.add(managed);
        return { stdout: ['downloading…\n'], stderr: ['npm warn\n'] };
      }
      return { stdout: ['1.0.0'] };
    });
    port.resolvable.add('npm');
    const toolchain = new Toolchain(
      paths,
      files,
      port,
      fakeClock().now,
      'linux',
      NODE,
      defaults.toolchain,
      defaults.delegates,
    );
    const seen: string[] = [];
    await toolchain.ensure(
      'claude',
      (stream, text) => seen.push(`${stream}:${text.trim()}`),
    );
    expect(seen).toEqual(['stdout:downloading…', 'stderr:npm warn']);
  });
});

describe('keeping delegates current', () => {
  async function installed() {
    const files = new MemoryFiles();
    const managed = managedShim('claude', 'linux', 'bin', 'claude');
    const clock = fakeClock();
    const port = new FakeProcessPort((spec) => {
      if (spec.argv.includes('install')) {
        files.directories.add(managed);
        return { stdout: ['ok'] };
      }
      return { stdout: ['1.0.0'] };
    });
    port.resolvable.add('npm');
    const toolchain = new Toolchain(
      paths,
      files,
      port,
      clock.now,
      'linux',
      NODE,
      defaults.toolchain,
      defaults.delegates,
    );
    await toolchain.install('claude');
    return { toolchain, clock, port };
  }

  it('does nothing while the install is fresh', async () => {
    const { toolchain, clock } = await installed();
    clock.advance(defaults.toolchain.updateIntervalMs - 1);
    expect(await toolchain.refreshStale()).toEqual([]);
  });

  it('updates once the interval has passed', async () => {
    const { toolchain, clock } = await installed();
    clock.advance(defaults.toolchain.updateIntervalMs + 1);
    expect(await toolchain.refreshStale()).toEqual(['claude']);
  });

  it('never updates a delegate it did not install', async () => {
    const { toolchain, clock } = build({ onPath: ['claude'] });
    clock.advance(defaults.toolchain.updateIntervalMs * 10);
    expect(await toolchain.refreshStale()).toEqual([]);
  });

  it('is off when the interval is zero', async () => {
    const { toolchain, clock } = await installed();
    clock.advance(1_000_000_000);
    const off = new Toolchain(
      paths,
      new MemoryFiles(),
      new FakeProcessPort(() => ({})),
      clock.now,
      'linux',
      NODE,
      {
        ...defaults.toolchain,
        updateIntervalMs: 0,
      },
      defaults.delegates,
    );
    expect(await off.refreshStale()).toEqual([]);
    expect(await toolchain.refreshStale()).toEqual(['claude']);
  });
});
