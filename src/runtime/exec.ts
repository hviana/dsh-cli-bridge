/**
 * The one way this plugin runs a process.
 *
 * Version probes, npm installs, auth checks and delegated runs all come through
 * here, so cancellation, deadlines, output bounding and UTF-8 decoding are
 * written once and behave identically — including on Windows, where the
 * harness's subprocess provider terminates the whole process tree rather than
 * just the child this handle names.
 *
 * @module dsh-cli-bridge/runtime/exec
 */
import type { Readable } from 'node:stream';
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { boundTail } from '../domain/text.ts';
import type { ProcessPort } from './ports.ts';

/** One finished process. */
export interface ProcessResult {
  /** Exit code; `null` when the process died from a signal. */
  readonly exitCode: number | null;
  /** Terminating signal; `null` on a normal exit. */
  readonly signal: string | null;
  /** Tail-bounded stdout. */
  readonly stdout: string;
  /** Tail-bounded stderr. */
  readonly stderr: string;
  /** Whether the deadline fired. */
  readonly timedOut: boolean;
  /** Whether the caller's signal aborted the run. */
  readonly aborted: boolean;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
}

/** How to run one process. */
export interface ProcessRequest {
  /** Executable and arguments; `argv[0]` must already be resolved. */
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Environment entries merged onto the provider's scrubbed parent environment. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Text written to stdin, which is then closed. Absent leaves stdin empty. */
  readonly stdin?: string;
  /** Wall-clock budget in milliseconds; `0` or absent means no deadline. */
  readonly timeoutMs?: number;
  /** SIGTERM-to-SIGKILL grace for the process tree. */
  readonly graceMs: number;
  /** Caller cancellation. */
  readonly signal?: AbortSignal;
  /** Bytes of each stream retained in the result. */
  readonly maxTailBytes: number;
  /**
   * Live output sink, called with decoded text as it arrives.
   * @param stream - which stream produced the text.
   * @param chunk - the decoded text.
   */
  readonly onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

/**
 * Run one process to completion.
 *
 * The returned promise settles only after the process tree has closed, so a
 * caller that awaits it knows nothing of the run is still executing.
 * @param port - the subprocess seam.
 * @param request - the fully specified run.
 * @param now - epoch-millisecond clock.
 * @returns exit facts and bounded output.
 */
export async function runProcess(
  port: ProcessPort,
  request: ProcessRequest,
  now: () => number,
): Promise<ProcessResult> {
  const startedAt = now();
  const control = new AbortController();
  let timedOut = false;
  let aborted = false;

  const abort = (): void => {
    aborted = true;
    control.abort();
  };
  // A signal that fired BEFORE this call — cancelled while the toolchain was
  // still resolving, say — never emits an `abort` event, so the listener alone
  // would leave the child running with nothing to stop it.
  if (request.signal?.aborted === true) abort();
  else request.signal?.addEventListener('abort', abort, { once: true });
  const deadline = request.timeoutMs !== undefined && request.timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      control.abort();
    }, request.timeoutMs)
    : undefined;
  // A pending deadline must never be the reason a Node process stays alive.
  deadline?.unref?.();

  const spec: SubprocessSpawnSpec = {
    argv: request.argv,
    cwd: request.cwd,
    stdio: {
      stdin: request.stdin === undefined ? 'ignore' : { data: request.stdin },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    graceMs: request.graceMs,
    signal: control.signal,
    env: { ...request.env },
  };

  let stop: (() => void) | undefined;
  try {
    const handle = port.spawn(spec);
    // The spec carries the signal, and a provider is expected to terminate the
    // child's whole tree when it fires — but cancellation is not something to
    // hold loosely, and `terminate` is part of every handle. So the child is
    // stopped from BOTH directions: whichever the provider implements, the
    // delegate goes away. Terminating an already-dead child is a no-op.
    const terminate = (): void => {
      try {
        handle.terminate();
      } catch {
        // A provider that has already reaped the child may refuse; the outcome
        // is the same, and a failure here must not mask the run's own result.
      }
    };
    if (control.signal.aborted) terminate();
    else {
      control.signal.addEventListener('abort', terminate, { once: true });
      stop = () => {
        control.signal.removeEventListener('abort', terminate);
      };
    }
    const stdout = collect(
      handle.stdout,
      request.maxTailBytes,
      (text) => request.onOutput?.('stdout', text),
    );
    const stderr = collect(
      handle.stderr,
      request.maxTailBytes,
      (text) => request.onOutput?.('stderr', text),
    );
    const outcome = await handle.done;
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: stdout(),
      stderr: stderr(),
      timedOut,
      aborted: aborted && !timedOut,
      durationMs: now() - startedAt,
    };
  } finally {
    stop?.();
    if (deadline !== undefined) clearTimeout(deadline);
    request.signal?.removeEventListener('abort', abort);
  }
}

/**
 * Decode one piped stream, forward it live, and retain a bounded tail.
 *
 * `setEncoding` is what makes the live forwarding safe: Node holds back a
 * partial multi-byte sequence until the rest of it arrives, so a sink never
 * receives a broken code point and the channel never ships one to a browser.
 * @param stream - the piped stream, absent when the caller did not pipe it.
 * @param maxBytes - bytes of tail to retain.
 * @param sink - live text consumer.
 * @returns a reader for the retained tail, valid once the process closed.
 */
function collect(
  stream: Readable | undefined,
  maxBytes: number,
  sink: (text: string) => void,
): () => string {
  if (stream === undefined) return () => '';
  let retained = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    sink(chunk);
    if (maxBytes <= 0) return;
    retained = boundTail(retained + chunk, maxBytes);
  });
  // A stream error (a peer closing mid-read) must not become an unhandled
  // rejection; the exit facts still describe the run.
  stream.on('error', () => {});
  return () => retained;
}
