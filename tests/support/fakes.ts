/**
 * Test doubles for the runtime's ports.
 *
 * They are deliberately faithful about the two things that break real code:
 * output arrives asynchronously and in arbitrary chunks, and a process only
 * settles when its script says so.
 */
import { PassThrough } from 'node:stream';
import { dirname } from 'node:path';
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess';
import type { FilePort, ProcessPort } from '../../src/runtime/ports.ts';

/** Shared no-op, hoisted so the fakes do not allocate one per spawn. */
const noop = (): void => {};

/** Whether a command is an absolute path on either platform shape. */
function isAbsolutePath(command: string): boolean {
  return command.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(command);
}

/** What a scripted process does. */
export interface ProcessScript {
  /** stdout chunks, delivered in order, one per tick. */
  readonly stdout?: readonly string[];
  /** stderr chunks, delivered in order, one per tick. */
  readonly stderr?: readonly string[];
  /** Exit code; defaults to 0. */
  readonly exitCode?: number | null;
  /** Terminating signal; defaults to none. */
  readonly signal?: string | null;
  /** Never exit on its own — the run must be cancelled or time out. */
  readonly hold?: boolean;
}

/** A recorded spawn. */
export interface SpawnRecord {
  readonly spec: SubprocessSpawnSpec;
  /** Whether the spec's signal fired before the process settled. */
  aborted: boolean;
}

/** Scripted `ctx.subprocess`. */
export class FakeProcessPort implements ProcessPort {
  readonly spawns: SpawnRecord[] = [];
  readonly terminals: SubprocessTerminalSpawnSpec[] = [];
  /** Executables this port claims to have; anything else fails resolution. */
  resolvable = new Set<string>();
  /** The live terminal handed to the last `spawnTerminal` caller. */
  lastTerminal: FakeTerminal | undefined;

  constructor(
    private readonly script: (spec: SubprocessSpawnSpec) => ProcessScript,
  ) {}

  async resolveExecutable(command: string): Promise<string> {
    // An absolute path verifies as itself, POSIX or Windows shaped; a bare name
    // resolves only when this port claims to have it.
    if (isAbsolutePath(command)) return command;
    if (this.resolvable.has(command)) return `/usr/bin/${command}`;
    throw new Error(`not found: ${command}`);
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    // The real provider refuses a spec whose signal already fired, rather than
    // starting a child nothing is left to stop. Consumers have to survive that.
    if (spec.signal?.aborted === true) throw new Error('aborted before spawn');
    const record: SpawnRecord = { spec, aborted: false };
    this.spawns.push(record);
    const plan = this.script(spec);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let settle: (outcome: SubprocessOutcome) => void = noop;
    const done = new Promise<SubprocessOutcome>((resolve) => {
      settle = resolve;
    });

    const finish = (outcome: SubprocessOutcome): void => {
      stdout.end();
      stderr.end();
      settle(outcome);
    };

    // Chunks are delivered one event-loop turn apart on purpose: a consumer
    // that only works when output arrives in one piece is not a real consumer.
    // oxlint-disable eslint/no-await-in-loop
    const emit = async (): Promise<void> => {
      for (const chunk of plan.stdout ?? []) {
        await tick();
        stdout.write(chunk);
      }
      for (const chunk of plan.stderr ?? []) {
        await tick();
        stderr.write(chunk);
      }
      await tick();
      /* oxlint-enable eslint/no-await-in-loop */
      // `?? 0` would turn a deliberate `null` — a signal death — into a clean exit.
      if (plan.hold !== true) {
        finish({
          exitCode: plan.exitCode === undefined ? 0 : plan.exitCode,
          signal: (plan.signal ?? null) as null,
        });
      }
    };
    void emit();

    spec.signal?.addEventListener('abort', () => {
      record.aborted = true;
      finish({ exitCode: null, signal: 'SIGTERM' });
    }, { once: true });

    return {
      pid: 1234,
      stdin: undefined,
      stdout,
      stderr,
      collected: {},
      done,
      terminate: () => {
        finish({ exitCode: null, signal: 'SIGTERM' });
      },
      waitForExit: async () => true,
    };
  }

  async spawnTerminal(
    spec: SubprocessTerminalSpawnSpec,
  ): Promise<SubprocessTerminalHandle> {
    this.terminals.push(spec);
    const terminal = new FakeTerminal();
    this.lastTerminal = terminal;
    return terminal;
  }
}

/** A scripted PTY session the test drives by hand. */
export class FakeTerminal implements SubprocessTerminalHandle {
  readonly pid = 4321;
  readonly output = new PassThrough();
  readonly writes: string[] = [];
  terminated = false;
  private settle: (outcome: SubprocessOutcome) => void = noop;
  readonly done = new Promise<SubprocessOutcome>((resolve) => {
    this.settle = resolve;
  });

  async write(data: string): Promise<void> {
    this.writes.push(data);
  }

  async inspectForeground(): Promise<undefined> {
    return undefined;
  }

  async signalForeground(): Promise<number> {
    return this.pid;
  }

  async terminate(): Promise<void> {
    this.terminated = true;
    this.exit(null, 'SIGTERM');
  }

  /** Emit terminal output, as the CLI would. */
  emit(text: string): void {
    this.output.write(text);
  }

  /** End the session. */
  exit(exitCode: number | null, signal: string | null = null): void {
    this.output.end();
    this.settle({ exitCode, signal: signal as null });
  }
}

/** In-memory {@link FilePort}. */
export class MemoryFiles implements FilePort {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  /** Paths whose write should fail, to exercise the failure branches. */
  readonly failWrites = new Set<string>();

  async readText(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async writeText(path: string, text: string): Promise<void> {
    if (this.failWrites.has(path)) throw new Error(`EACCES: ${path}`);
    this.directories.add(dirname(path));
    this.files.set(path, text);
  }

  async makeDirectory(path: string): Promise<void> {
    this.directories.add(path);
  }

  async removeDirectory(path: string): Promise<void> {
    this.directories.delete(path);
    for (const key of Array.from(this.files.keys())) {
      if (key.startsWith(`${path}/`)) this.files.delete(key);
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }
}

/** A clock the test advances. */
export function fakeClock(
  start = 1_700_000_000_000,
): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** Yield to the event loop so scripted output reaches its listeners. */
export async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Wait until a predicate holds, or fail the test's patience. */
export async function until(
  predicate: () => boolean,
  attempts = 200,
): Promise<void> {
  // oxlint-disable-next-line eslint/no-await-in-loop -- polling is the point
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    // oxlint-disable-next-line eslint/no-await-in-loop
    await tick();
  }
  throw new Error('condition never held');
}
