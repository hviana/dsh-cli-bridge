import { describe, expect, it } from 'vitest';
import { runProcess } from '../../src/runtime/exec.ts';
import type { ProcessPort } from '../../src/runtime/ports.ts';
import {
  fakeClock,
  FakeProcessPort,
  type ProcessScript,
} from '../support/fakes.ts';

function port(script: ProcessScript) {
  return new FakeProcessPort(() => script);
}

const base = {
  argv: ['/usr/bin/tool', '--flag'],
  cwd: '/repo',
  env: {},
  graceMs: 100,
  maxTailBytes: 1024,
};

describe('runProcess', () => {
  it('collects both streams and the exit facts', async () => {
    const result = await runProcess(
      port({ stdout: ['a', 'b'], stderr: ['warn'], exitCode: 3 }),
      base,
      fakeClock().now,
    );
    expect(result).toMatchObject({
      stdout: 'ab',
      stderr: 'warn',
      exitCode: 3,
      signal: null,
      timedOut: false,
      aborted: false,
    });
  });

  it('forwards output live, in the chunks it arrived in', async () => {
    const seen: string[] = [];
    await runProcess(port({ stdout: ['one', 'two'], stderr: ['bad'] }), {
      ...base,
      onOutput: (stream, chunk) => seen.push(`${stream}:${chunk}`),
    }, fakeClock().now);
    expect(seen).toEqual(['stdout:one', 'stdout:two', 'stderr:bad']);
  });

  it('bounds each retained stream without bounding what it forwarded', async () => {
    const forwarded: string[] = [];
    const result = await runProcess(
      port({ stdout: ['x'.repeat(500), 'y'.repeat(500)] }),
      {
        ...base,
        maxTailBytes: 100,
        onOutput: (_stream, chunk) => forwarded.push(chunk),
      },
      fakeClock().now,
    );
    expect(result.stdout).toHaveLength(100);
    expect(result.stdout.endsWith('y')).toBe(true);
    expect(forwarded.join('')).toHaveLength(1000);
  });

  it('writes the prompt to stdin and closes it', async () => {
    const spawner = port({});
    await runProcess(
      spawner,
      { ...base, stdin: 'the prompt' },
      fakeClock().now,
    );
    expect(spawner.spawns[0]?.spec.stdio.stdin).toEqual({ data: 'the prompt' });
  });

  it('leaves stdin closed when there is nothing to write', async () => {
    const spawner = port({});
    await runProcess(spawner, base, fakeClock().now);
    expect(spawner.spawns[0]?.spec.stdio.stdin).toBe('ignore');
  });

  it('passes the environment layer through, tombstones included', async () => {
    const spawner = port({});
    await runProcess(spawner, {
      ...base,
      env: { HOME_VAR: '/h', KEY: undefined },
    }, fakeClock().now);
    expect(spawner.spawns[0]?.spec.env).toEqual({
      HOME_VAR: '/h',
      KEY: undefined,
    });
  });

  it('reports a signal death', async () => {
    const result = await runProcess(
      port({ exitCode: null, signal: 'SIGSEGV' }),
      base,
      fakeClock().now,
    );
    expect(result).toMatchObject({ exitCode: null, signal: 'SIGSEGV' });
  });

  it('cancels on the caller’s signal', async () => {
    const control = new AbortController();
    const spawner = port({ hold: true });
    const running = runProcess(
      spawner,
      { ...base, signal: control.signal },
      fakeClock().now,
    );
    control.abort();
    const result = await running;
    expect(result).toMatchObject({ aborted: true, timedOut: false });
    expect(spawner.spawns[0]?.aborted).toBe(true);
  });

  it('stops a child through the handle when the provider ignores the spec signal', async () => {
    // A provider is expected to terminate the tree when the spec's signal
    // fires, but cancellation must not depend on how much of that contract a
    // given provider implements — the delegate has to go away either way.
    let terminated = false;
    const settle: { resolve?: () => void } = {};
    const stubborn: ProcessPort = {
      async resolveExecutable(command) {
        return command;
      },
      spawn() {
        return {
          pid: 4242,
          stdin: undefined,
          stdout: undefined,
          stderr: undefined,
          collected: {},
          done: new Promise((resolve) => {
            settle.resolve = () =>
              resolve({ exitCode: null, signal: 'SIGTERM' });
          }),
          terminate: () => {
            terminated = true;
            settle.resolve?.();
          },
          waitForExit: async () => true,
        };
      },
      async spawnTerminal() {
        throw new Error('not used');
      },
    };

    const control = new AbortController();
    const running = runProcess(
      stubborn,
      { ...base, signal: control.signal },
      fakeClock().now,
    );
    control.abort();
    expect(await running).toMatchObject({ aborted: true, signal: 'SIGTERM' });
    expect(terminated).toBe(true);
  });

  it('survives a provider whose terminate refuses', async () => {
    const angry: ProcessPort = {
      async resolveExecutable(command) {
        return command;
      },
      spawn() {
        return {
          pid: 1,
          stdin: undefined,
          stdout: undefined,
          stderr: undefined,
          collected: {},
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate: () => {
            throw new Error('already reaped');
          },
          waitForExit: async () => true,
        };
      },
      async spawnTerminal() {
        throw new Error('not used');
      },
    };
    const control = new AbortController();
    const running = runProcess(
      angry,
      { ...base, signal: control.signal },
      fakeClock().now,
    );
    control.abort();
    await expect(running).resolves.toMatchObject({ exitCode: 0 });
  });

  it('propagates the provider’s refusal to start an already-cancelled run', async () => {
    const control = new AbortController();
    control.abort();
    await expect(
      runProcess(
        port({ hold: true }),
        { ...base, signal: control.signal },
        fakeClock().now,
      ),
    )
      .rejects.toThrow(/aborted before spawn/u);
  });

  it('stops a run that outlives its deadline, and says so', async () => {
    const result = await runProcess(port({ hold: true }), {
      ...base,
      timeoutMs: 5,
    }, fakeClock().now);
    expect(result).toMatchObject({ timedOut: true, aborted: false });
  });

  it('measures duration on the injected clock', async () => {
    const clock = fakeClock(500);
    const result = await runProcess(port({ stdout: ['x'] }), base, () => {
      clock.advance(10);
      return clock.now();
    });
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('does not retain output when the budget is zero', async () => {
    const result = await runProcess(port({ stdout: ['noisy'] }), {
      ...base,
      maxTailBytes: 0,
    }, fakeClock().now);
    expect(result.stdout).toBe('');
  });
});
