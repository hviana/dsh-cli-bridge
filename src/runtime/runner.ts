/**
 * The two ways a delegate process is driven.
 *
 * A TASK is piped: stdout is JSON lines, decoded into activities as it arrives
 * and classified once at the end. A LOGIN owns a real terminal, because the
 * CLIs' sign-in flows draw prompts and read keystrokes; it is the only place
 * this plugin needs a PTY, and it is why the subprocess seam's terminal
 * primitive exists.
 *
 * Both publish everything they see to the stream hub and hand back one bounded
 * outcome. Neither knows what a tool, a session, or a model is.
 *
 * @module dsh-cli-bridge/runtime/runner
 */
import type { RunEnd } from '../shared/protocol.ts';
import type { CliAdapter, SpawnPlan } from '../domain/adapters/index.ts';
import type { ContractMarkers } from '../domain/markers.ts';
import { LineAssembler } from '../domain/lines.ts';
import { classifyOutcome } from '../domain/outcome.ts';
import { boundHead } from '../domain/text.ts';
import type { LimitsConfig } from '../config.ts';
import { runProcess } from './exec.ts';
import { composeArgv } from './launch.ts';
import type { ProcessPort } from './ports.ts';
import type { RunState } from './run.ts';

/**
 * Viewport of the login terminal.
 *
 * Not a configuration field: no surface can resize this terminal, so a second
 * value would only be a way to make the sign-in prompt wrap badly.
 */
const LOGIN_TERMINAL = { rows: 30, cols: 120 } as const;

/** Everything one task run needs. */
export interface TaskRun {
  readonly adapter: CliAdapter;
  /** Resolved argv prefix that runs the delegate on this platform. */
  readonly executable: readonly string[];
  /** The adapter's plan: argv tail, environment, and the prompt for stdin. */
  readonly plan: SpawnPlan;
  readonly cwd: string;
  readonly state: RunState;
  readonly limits: LimitsConfig;
  /** The markers this run's prompt announced, and is read back through. */
  readonly markers: ContractMarkers;
  /** Wall-clock budget; `0` means none. */
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/**
 * Run one delegated task to settlement.
 *
 * Output is streamed to the hub as it arrives AND fed to the adapter's decoder,
 * so the browser sees the raw transcript while the model's eventual result is
 * built from structured facts rather than scraped prose.
 * @param port - the subprocess seam.
 * @param run - the fully prepared run.
 * @param now - epoch-millisecond clock.
 * @returns the terminal facts, already recorded on the run state.
 */
export async function driveTask(
  port: ProcessPort,
  run: TaskRun,
  now: () => number,
): Promise<RunEnd> {
  const decoder = run.adapter.decoder();
  const assembler = new LineAssembler();

  const consume = (line: string): void => {
    for (const activity of decoder.push(line)) run.state.activity(activity);
    const session = decoder.state().delegateSessionId;
    if (session !== undefined) run.state.bindDelegateSession(session);
  };

  run.state.markRunning();
  const result = await runProcess(port, {
    argv: composeArgv(run.executable, run.plan.argv),
    cwd: run.cwd,
    env: run.plan.env,
    ...run.plan.stdin === undefined ? {} : { stdin: run.plan.stdin },
    graceMs: run.limits.terminateGraceMs,
    maxTailBytes: run.limits.stderrTailBytes,
    signal: run.signal,
    ...run.timeoutMs > 0 ? { timeoutMs: run.timeoutMs } : {},
    onOutput: (stream, chunk) => {
      run.state.output(stream, chunk);
      if (stream !== 'stdout') return;
      for (const line of assembler.push(chunk)) consume(line);
    },
  }, now);
  for (const line of assembler.flush()) consume(line);

  const end = classifyOutcome({
    state: decoder.state(),
    exitCode: result.exitCode,
    signal: result.signal,
    cancelled: result.aborted,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    markers: run.markers,
    summaryMaxBytes: run.limits.summaryMaxBytes,
    errorMaxBytes: run.limits.errorMaxBytes,
    stderr: result.stderr,
  });
  return run.state.finish(end, now());
}

/** A live interactive login. */
export interface LoginSession {
  /**
   * Deliver keystrokes to the terminal.
   * @param data - text to write, exactly as typed.
   */
  write(data: string): Promise<void>;
  /** Terminate the terminal session and await its quiescence. */
  terminate(): Promise<void>;
  /** Settles when the sign-in process exits. */
  readonly settled: Promise<RunEnd>;
}

/** Everything one login run needs. */
export interface LoginRun {
  readonly adapter: CliAdapter;
  /** Resolved argv prefix that runs the delegate on this platform. */
  readonly executable: readonly string[];
  readonly plan: SpawnPlan;
  readonly cwd: string;
  readonly state: RunState;
  readonly limits: LimitsConfig;
}

/**
 * Start an interactive sign-in under a real terminal.
 *
 * The promise resolves once the terminal is allocated — not when the login
 * finishes — because the caller must be able to type into it.
 * @param port - the subprocess seam.
 * @param run - the fully prepared login.
 * @param now - epoch-millisecond clock.
 * @returns the live session.
 */
export async function driveLogin(
  port: ProcessPort,
  run: LoginRun,
  now: () => number,
): Promise<LoginSession> {
  const startedAt = now();
  const handle = await port.spawnTerminal({
    argv: composeArgv(run.executable, run.plan.argv),
    cwd: run.cwd,
    env: definedEntries(run.plan.env),
    rows: LOGIN_TERMINAL.rows,
    cols: LOGIN_TERMINAL.cols,
    graceMs: run.limits.terminateGraceMs,
  });

  run.state.markRunning();
  handle.output.setEncoding('utf8');
  handle.output.on('data', (chunk: string) => {
    run.state.output('stdout', chunk);
  });
  handle.output.on('error', () => {});

  const settled = handle.done.then(
    (outcome) =>
      run.state.finish({
        status: outcome.exitCode === 0 ? 'completed' : 'failed',
        summary: outcome.exitCode === 0
          ? `${run.adapter.displayName} sign-in finished.`
          : '',
        ...outcome.exitCode === 0 ? {} : {
          error: outcome.signal === null
            ? `exited with code ${String(outcome.exitCode)}`
            : `terminated by ${outcome.signal}`,
        },
        ...outcome.exitCode === null ? {} : { exitCode: outcome.exitCode },
        durationMs: now() - startedAt,
      }, now()),
    (error: unknown) =>
      run.state.finish({
        status: 'failed',
        summary: '',
        error: boundHead(
          error instanceof Error ? error.message : String(error),
          run.limits.errorMaxBytes,
        ),
        durationMs: now() - startedAt,
      }, now()),
  );

  return {
    write: (data) => handle.write(data),
    terminate: () => handle.terminate(),
    settled,
  };
}

/**
 * Drop tombstones from an environment layer.
 *
 * The terminal spawn spec takes only defined values, while the pipe spec also
 * accepts `undefined` as "remove this inherited entry"; a terminal login never
 * needs the tombstone form, so dropping it here is lossless.
 * @param env - the adapter's environment layer.
 * @returns the same entries with the tombstones removed.
 */
function definedEntries(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined
    ),
  );
}
