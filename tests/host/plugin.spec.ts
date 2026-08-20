import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import { apply, Config, inject, name } from '../../src/index.ts';
import { FakeCarrier, FakeContext } from '../support/host.ts';
import { FakeProcessPort } from '../support/fakes.ts';

let stateDir = '';

beforeEach(async () => {
  // The composition root binds the REAL filesystem, so every mount here is
  // pointed at a directory the test owns.
  stateDir = await mkdtemp(join(tmpdir(), 'cli-bridge-plugin-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(stateDir, { recursive: true, force: true });
});

/** Mount the plugin the way the harness Loader would. */
function mount(options: {
  config?: Record<string, unknown>;
  withCommands?: boolean;
  withCarrier?: boolean;
} = {}) {
  const tools = new Map<string, ToolDefinition>();
  const commands: CommandDefinition[] = [];
  const process = new FakeProcessPort(() => ({ stdout: ['1.0.0'] }));
  const carrier = new FakeCarrier();
  const ctx = new FakeContext()
    .provide('tools', {
      register(definition: ToolDefinition) {
        tools.set(definition.name, definition);
        return () => {
          tools.delete(definition.name);
        };
      },
    })
    .provide('subprocess', process);
  if (options.withCommands === true) {
    ctx.provide('commands', {
      register(definition: CommandDefinition) {
        commands.push(definition);
        return () => {
          commands.length = 0;
        };
      },
    });
  }
  if (options.withCarrier === true) ctx.provide('webServer', carrier);

  const config = new Config({ stateDir, ...options.config });
  apply(ctx.asContext(), config);
  return { ctx, tools, commands, carrier, process, config };
}

describe('the plugin manifest', () => {
  it('names itself and states only the services it cannot work without', () => {
    expect(name).toBe('cli-bridge');
    expect(inject).toEqual(['tools', 'subprocess']);
  });

  it('exports the wire vocabulary so a consumer can type against it', async () => {
    const module = await import('../../src/index.ts');
    expect(module.CLI_IDS).toEqual(['claude', 'codex']);
    expect(module.DEFAULT_BASE_PATH).toBe('/dsh-cli-bridge');
  });
});

describe('mounting', () => {
  it('registers the model-facing surface', () => {
    expect([...mount().tools.keys()].toSorted())
      .toEqual([
        'cli_accounts',
        'cli_delegate',
        'cli_delegate_all',
        'cli_reply',
        'cli_toolchain',
      ]);
  });

  it('works with nothing but the tool registry and the subprocess seam', () => {
    const { commands, carrier } = mount();
    expect(commands).toEqual([]);
    expect(carrier.routes.size).toBe(0);
  });

  it('adds the command when the harness has a command registry', () => {
    expect(
      mount({ withCommands: true }).commands.map((command) => command.name),
    ).toEqual(['cli']);
  });

  it('adds the channel when the harness has an HTTP carrier', () => {
    expect(mount({ withCarrier: true }).carrier.routes.size).toBe(3);
  });

  it('unwinds every registration when it unloads', async () => {
    const { ctx, tools, commands, carrier } = mount({
      withCommands: true,
      withCarrier: true,
    });
    await ctx.dispose();
    expect(tools.size).toBe(0);
    expect(commands).toEqual([]);
    expect(carrier.routes.size).toBe(0);
  });

  it('refuses to load with a malformed trusted authority', () => {
    expect(() =>
      mount({ config: { channel: { trustedHosts: ['harness.internal/api'] } } })
    )
      .toThrow(/bare host/u);
  });
});

describe('keeping the delegates current', () => {
  it('checks once at boot and then on the configured interval', async () => {
    vi.useFakeTimers();
    const { ctx, process } = mount({
      config: { toolchain: { updateIntervalMs: 60_000 } },
    });
    await vi.advanceTimersByTimeAsync(1);
    // Nothing is managed yet, so the check reads its own record and spawns nothing.
    expect(process.spawns).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(process.spawns).toEqual([]);
    await ctx.dispose();
  });

  it('schedules nothing when background updates are off', async () => {
    vi.useFakeTimers();
    const { ctx } = mount({ config: { toolchain: { updateIntervalMs: 0 } } });
    expect(vi.getTimerCount()).toBe(0);
    await ctx.dispose();
  });

  it('schedules nothing when the toolchain is not managed', async () => {
    vi.useFakeTimers();
    const { ctx } = mount({ config: { toolchain: { mode: 'path' } } });
    expect(vi.getTimerCount()).toBe(0);
    await ctx.dispose();
  });
});

describe('configuration', () => {
  it('honours a config that turns the admin tools off', () => {
    expect(
      [...mount({ config: { adminTools: false } }).tools.keys()].toSorted(),
    )
      .toEqual(['cli_delegate', 'cli_delegate_all', 'cli_reply']);
  });

  it('honours a config that turns the channel off', () => {
    expect(
      mount({ withCarrier: true, config: { channel: { enabled: false } } })
        .carrier.routes.size,
    ).toBe(0);
  });
});
