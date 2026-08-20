/**
 * The run registry.
 *
 * It owns run identity, the concurrency budget, session fencing, cancellation
 * and retention — and it is the only place that knows how an account, a
 * toolchain, an adapter and the stream hub combine into a running delegate.
 *
 * Session fencing mirrors the harness's own background-job rule: ids are
 * predictable, so authorization is the boundary. A run started by one session
 * is invisible to another.
 *
 * @module dsh-cli-bridge/runtime/registry
 */
import type {
  CliId,
  EffortLevel,
  PermissionMode,
  RunEnd,
  RunId,
  RunSnapshot,
} from '../shared/protocol.ts';
import { adapterFor } from '../domain/adapters/index.ts';
import { type ContractMarkers, operatingContract } from '../domain/markers.ts';
import { oneLineLabel } from '../domain/text.ts';
import type { AutonomyConfig, Config } from '../config.ts';
import { type AccountStore, AMBIENT_ACCOUNT_ID } from './accounts.ts';
import type { StreamHub } from './channel.ts';
import { BridgeError, describeError } from './errors.ts';
import type { ProcessPort } from './ports.ts';
import { RunState, seedSnapshot } from './run.ts';
import { anySignal } from './signals.ts';
import { type Slot, SlotGate } from './slots.ts';
import { driveLogin, driveTask, type LoginSession } from './runner.ts';
import type { Toolchain } from './toolchain.ts';

/** Characters of prompt kept as a run's one-line label. */
const LABEL_CHARS = 72;

/** What the caller asks for when delegating a task. */
/** What one continuation asks for. */
export interface ReplyRequest {
  /** The settled run whose delegate session carries on. */
  readonly run: RunId;
  /** What to tell the delegate. */
  readonly message: string;
  /** Where it runs; omitted keeps the original run's workspace. */
  readonly cwd?: string;
  /** The asking session, for fencing. */
  readonly sessionId?: string;
  /** The tool call carrying the continuation, for its card. */
  readonly callId?: string;
  /** The caller's cancellation, honoured while the round queues for a slot. */
  readonly signal?: AbortSignal;
}

export interface StartTaskRequest {
  readonly cli: CliId;
  /** The task, as the caller wrote it; the direction preamble is added here. */
  readonly prompt: string;
  /** Account id; omitted uses the delegate's default. */
  readonly account?: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  /** Working directory and workspace boundary. */
  readonly cwd: string;
  /** The harness permission mode this run inherits. */
  readonly permission: PermissionMode;
  /** Wall-clock budget; omitted uses the configured default. */
  readonly timeoutMs?: number;
  /** Owning harness session, for fencing and listing. */
  readonly sessionId?: string;
  /** Tool call that started the run, so its card can find it. */
  readonly callId?: string;
  /** Delegate session to continue, set by {@link RunRegistry.reply}. */
  readonly resume?: string;
  /**
   * The caller's cancellation, honoured while the run waits for a free slot.
   *
   * A run that has started is cancelled through {@link RunRegistry.cancel}; this
   * is only about the wait BEFORE it starts, which is the one stretch the caller
   * would otherwise be unable to abandon.
   */
  readonly signal?: AbortSignal;
}

/** A started run: its opening snapshot, and its settlement. */
export interface StartedRun {
  readonly snapshot: RunSnapshot;
  readonly settled: Promise<RunEnd>;
}

/** Everything needed to resume a settled run under the same conditions. */
interface RunOrigin {
  readonly cli: CliId;
  readonly account: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  readonly cwd: string;
  readonly permission: PermissionMode;
  readonly timeoutMs?: number;
}

/** One registered run. */
interface RunRecord {
  readonly state: RunState;
  readonly controller: AbortController;
  readonly settled: Promise<RunEnd>;
  readonly origin?: RunOrigin;
}

/** Collaborators the registry drives. */
export interface RegistryDeps {
  readonly hub: StreamHub;
  readonly accounts: AccountStore;
  readonly toolchain: Toolchain;
  readonly process: ProcessPort;
  readonly config: Config;
  readonly now: () => number;
  /**
   * The live autonomy switches.
   *
   * A function rather than a value: a person turns autonomy on and off mid
   * conversation, and a delegation already running must see the change at its
   * next decision. Absent where only the configured settings are ever used.
   */
  readonly autonomy?: () => AutonomyConfig;
}

/** Run identity, lifecycle and fencing. */
export class RunRegistry {
  private readonly records = new Map<RunId, RunRecord>();
  /**
   * Terminals of the interactive runs, keyed by run id. Kept beside the records
   * rather than inside them because a terminal is published part-way through a
   * run's own body, after the immutable record already exists.
   */
  private readonly logins = new Map<RunId, LoginSession>();
  private readonly counters = new Map<CliId, number>();
  /**
   * The concurrency budget.
   *
   * Owned here because this is the only place a delegate is started, and read
   * through a function so a deployment's limit is never captured at
   * construction.
   */
  private readonly slots = new SlotGate(() =>
    this.deps.config.limits.maxConcurrentRuns
  );
  /**
   * Fires when the registry is shutting down.
   *
   * A run waiting for a slot has not started yet, so aborting its records would
   * reach nothing: the wait itself has to end, or the plugin would unload and
   * then spawn a delegate nobody is watching.
   */
  private readonly closing = new AbortController();

  constructor(private readonly deps: RegistryDeps) {}

  /**
   * List runs visible to one session.
   * @param sessionId - the asking session; omit to see unowned runs only.
   * @returns snapshots in registration order.
   */
  list(sessionId?: string): RunSnapshot[] {
    return [...this.records.values()]
      .map((record) => record.state.snapshot)
      .filter((snapshot) => this.visible(snapshot, sessionId));
  }

  /**
   * Every run, whoever started it.
   *
   * This is the HUMAN channel's read, and it is deliberately not fenced. The
   * person watching owns every session in their own browser, and a page cannot
   * name the session whose card it is rendering — so fencing this read by
   * session is what left the panel's run list permanently empty: the frames kept
   * arriving while the state read that repairs a late or reconnected subscriber
   * answered with nothing. Reachability is already fenced one layer out, by the
   * channel's trust check.
   *
   * The model-facing surface keeps {@link list} and its session fence, because
   * there ids are guessable and authorization is the boundary.
   * @returns snapshots in registration order.
   */
  listAll(): RunSnapshot[] {
    return [...this.records.values()].map((record) => record.state.snapshot);
  }

  /**
   * Read one run.
   * @param run - the run id.
   * @param sessionId - the asking session.
   * @returns its snapshot.
   * @throws {BridgeError} `UNKNOWN_RUN` when it does not exist or belongs elsewhere.
   */
  get(run: RunId, sessionId?: string): RunSnapshot {
    return this.record(run, sessionId).state.snapshot;
  }

  /**
   * Read one run's terminal facts.
   * @param run - the run id.
   * @param sessionId - the asking session.
   * @returns the end, or `undefined` while the run is live.
   */
  endOf(run: RunId, sessionId?: string): RunEnd | undefined {
    return this.record(run, sessionId).state.end;
  }

  /**
   * Total delegate output streamed by a set of runs.
   *
   * Runs already trimmed from the registry count as nothing rather than as an
   * error: the figure exists to tell the model how much it did NOT have to read,
   * and a forgotten round cannot make that a failure.
   * @param runs - the run ids.
   * @returns the byte total.
   */
  bytesOf(runs: readonly RunId[]): number {
    let total = 0;
    for (const run of runs) {
      total += this.records.get(run)?.state.snapshot.bytes ?? 0;
    }
    return total;
  }

  /**
   * Delegate a task.
   *
   * The run is registered — and therefore visible and streaming — BEFORE the
   * toolchain is resolved, so a first-use install is something the user watches
   * rather than a silent stall.
   * @param request - what to delegate, and under which account and permission.
   * @returns the opening snapshot and the settlement promise.
   * @throws {BridgeError} when the account, credential, or CLI cannot be had.
   */
  async start(request: StartTaskRequest): Promise<StartedRun> {
    // The slot is held from here until the run settles, so the budget bounds
    // delegates actually executing rather than calls that happen to arrive at
    // the same moment.
    const slot = await this.admit(request.signal);
    try {
      return await this.spawn(request, slot);
    } catch (error) {
      slot();
      throw error;
    }
  }

  /**
   * Wait for a slot, unless the registry is closing.
   * @param signal - the caller's cancellation.
   * @returns the slot the run holds until it settles.
   * @throws {BridgeError} `CANCELLED` when the caller gave up, or the plugin is
   *   unloading — a run admitted during shutdown would outlive the plugin.
   */
  private async admit(signal?: AbortSignal): Promise<Slot> {
    if (this.closing.signal.aborted) {
      throw new BridgeError('the bridge is shutting down', 'CANCELLED');
    }
    const combined = anySignal([signal, this.closing.signal]);
    try {
      const slot = await this.slots.acquire(combined.signal);
      if (!this.closing.signal.aborted) return slot;
      slot();
      throw new BridgeError('the bridge is shutting down', 'CANCELLED');
    } finally {
      combined.dispose();
    }
  }

  /**
   * Register and drive one admitted run.
   * @param request - what to delegate.
   * @param slot - the concurrency slot this run holds until it settles.
   * @returns the opening snapshot and the settlement promise.
   */
  private async spawn(
    request: StartTaskRequest,
    slot: Slot,
  ): Promise<StartedRun> {
    const adapter = adapterFor(request.cli);
    const delegate = this.deps.config.delegates[request.cli];
    const record = await this.deps.accounts.resolve(
      request.cli,
      request.account,
    );
    const accountId = record?.id ?? AMBIENT_ACCOUNT_ID;
    const binding = await this.deps.accounts.bind(request.cli, record);
    if (record !== undefined) {
      await this.deps.accounts.prepareHome(request.cli, record.id);
    }

    // Precedence: the call's own model, then the account's (an endpoint account
    // names the model its provider serves), then the deployment's default.
    const model = request.model ?? record?.model ??
      emptyToUndefined(delegate.defaultModel);
    const effort = request.effort ?? emptyToUndefined(delegate.defaultEffort);
    const timeoutMs = request.timeoutMs ?? this.deps.config.limits.runTimeoutMs;
    const origin: RunOrigin = {
      cli: request.cli,
      account: accountId,
      cwd: request.cwd,
      permission: request.permission,
      ...model === undefined ? {} : { model },
      ...effort === undefined ? {} : { effort },
      ...timeoutMs === undefined ? {} : { timeoutMs },
    };

    const id = this.issue(request.cli);
    const state = new RunState(
      this.deps.hub,
      seedSnapshot({
        id,
        cli: request.cli,
        kind: 'task',
        account: accountId,
        label: oneLineLabel(request.prompt, LABEL_CHARS),
        permission: request.permission,
        cwd: request.cwd,
        interactive: false,
        ...model === undefined ? {} : { model },
        ...effort === undefined ? {} : { effort },
        ...request.sessionId === undefined
          ? {}
          : { sessionId: request.sessionId },
        ...request.callId === undefined ? {} : { callId: request.callId },
      }, this.deps.now()),
    );

    const controller = new AbortController();
    const settled = this.execute(state, controller, async () => {
      const executable = await this.deps.toolchain.ensure(
        request.cli,
        (stream, text) => {
          state.output(stream, text);
        },
        controller.signal,
      );
      const markers = this.markers();
      const { preamble } = this.deps.config.direction;
      const plan = adapter.planTask({
        prompt: preamble
          ? `${operatingContract(markers)}\n\n${request.prompt}`
          : request.prompt,
        permission: request.permission,
        cwd: request.cwd,
        account: binding,
        extraArgs: delegate.extraArgs,
        ...model === undefined ? {} : { model },
        ...effort === undefined ? {} : { effort },
        ...request.resume === undefined ? {} : { resume: request.resume },
      });
      return driveTask(this.deps.process, {
        adapter,
        executable: executable.argv,
        plan,
        cwd: request.cwd,
        state,
        limits: this.deps.config.limits,
        markers,
        timeoutMs: timeoutMs ?? 0,
        signal: controller.signal,
      }, this.deps.now);
    });

    this.records.set(id, { state, controller, settled, origin });
    // The slot frees on EITHER outcome: a run that failed is not still running.
    void settled.then(slot, slot);
    void settled.then(() =>
      this.deps.accounts.touch(request.cli, accountId).catch(() => undefined)
    );
    return { snapshot: state.snapshot, settled };
  }

  /**
   * Answer a run that asked for direction, or send it further work.
   *
   * The caller names the RUN, never the delegate's own session id: resuming is
   * a fact of this registry, not a token the model has to carry.
   * @param request - which run to continue, and what to tell it.
   * @returns the new run that carries the continuation.
   * @throws {BridgeError} when the run is unknown, live, or not resumable.
   */
  async reply(request: ReplyRequest): Promise<StartedRun> {
    const record = this.record(request.run, request.sessionId);
    if (!record.state.isSettled) {
      throw new BridgeError(
        `run ${request.run} is still running; cancel it or wait for it to settle`,
        'INVALID_REQUEST',
      );
    }
    const origin = record.origin;
    const delegateSession = record.state.snapshot.delegateSessionId;
    if (origin === undefined || delegateSession === undefined) {
      throw new BridgeError(
        `run ${request.run} left no delegate session to resume`,
        'INVALID_REQUEST',
      );
    }
    return this.start({
      cli: origin.cli,
      prompt: request.message,
      account: origin.account,
      // A continuation may run somewhere else entirely: a delegation that was
      // isolated gets a FRESH worktree, and the one the original ran in has
      // been merged and removed. Defaulting to the original's workspace keeps
      // a plain reply — the `/cli` kind — exactly where it was.
      cwd: request.cwd ?? origin.cwd,
      permission: origin.permission,
      resume: delegateSession,
      ...origin.model === undefined ? {} : { model: origin.model },
      ...origin.effort === undefined ? {} : { effort: origin.effort },
      ...origin.timeoutMs === undefined ? {} : { timeoutMs: origin.timeoutMs },
      ...request.sessionId === undefined
        ? {}
        : { sessionId: request.sessionId },
      ...request.callId === undefined ? {} : { callId: request.callId },
      ...request.signal === undefined ? {} : { signal: request.signal },
    });
  }

  /**
   * Start an interactive sign-in for one account.
   * @param cli - the delegate.
   * @param account - the account whose private home receives the credentials.
   * @param sessionId - owning session, for fencing.
   * @returns the opening snapshot and the settlement promise.
   */
  async startLogin(
    cli: CliId,
    account: string,
    sessionId?: string,
  ): Promise<StartedRun> {
    // A sign-in must not sit in a queue: it draws a prompt and waits for a
    // person, so a spent budget is something to say rather than something to
    // wait out behind delegates that may run for minutes.
    const slot = this.slots.reserve();
    if (slot === undefined) {
      const limit = this.deps.config.limits.maxConcurrentRuns;
      throw new BridgeError(
        `already running ${
          String(limit)
        } delegate runs; wait for one to finish`,
        'RUN_LIMIT',
      );
    }
    try {
      return await this.spawnLogin(cli, account, slot, sessionId);
    } catch (error) {
      slot();
      throw error;
    }
  }

  /**
   * Register and drive one admitted sign-in.
   * @param cli - the delegate.
   * @param account - the account whose private home receives the credentials.
   * @param slot - the concurrency slot this run holds until it settles.
   * @param sessionId - owning session, for fencing.
   * @returns the opening snapshot and the settlement promise.
   */
  private async spawnLogin(
    cli: CliId,
    account: string,
    slot: Slot,
    sessionId?: string,
  ): Promise<StartedRun> {
    const adapter = adapterFor(cli);
    // Resolving first is what refuses an unknown id: preparing a home would
    // happily create a directory for an account nobody registered.
    if (account !== AMBIENT_ACCOUNT_ID) {
      await this.deps.accounts.resolve(cli, account);
    }
    const home = await this.deps.accounts.prepareHome(cli, account);
    const id = this.issue(cli);
    const state = new RunState(
      this.deps.hub,
      seedSnapshot({
        id,
        cli,
        kind: 'login',
        account,
        label: `${adapter.displayName} sign-in`,
        permission: 'danger-full-access',
        cwd: this.deps.config.stateDir,
        interactive: true,
        ...sessionId === undefined ? {} : { sessionId },
      }, this.deps.now()),
    );

    const controller = new AbortController();
    const settled = this.execute(state, controller, async () => {
      const executable = await this.deps.toolchain.ensure(
        cli,
        (stream, text) => {
          state.output(stream, text);
        },
        controller.signal,
      );
      const session = await driveLogin(this.deps.process, {
        adapter,
        executable: executable.argv,
        plan: adapter.planLogin({
          account: home === undefined ? {} : { home },
          cwd: state.snapshot.cwd,
        }),
        cwd: state.snapshot.cwd,
        state,
        limits: this.deps.config.limits,
      }, this.deps.now);
      this.logins.set(id, session);
      controller.signal.addEventListener('abort', () => {
        void session.terminate();
      }, { once: true });
      return session.settled;
    });

    this.records.set(id, { state, controller, settled });
    void settled.then(slot, slot);
    return { snapshot: state.snapshot, settled };
  }

  /**
   * Deliver keystrokes to an interactive run.
   * @param run - the run id.
   * @param data - text to write, exactly as typed.
   * @param sessionId - the asking session.
   * @throws {BridgeError} `NOT_INTERACTIVE` when the run has no terminal.
   */
  async write(run: RunId, data: string, sessionId?: string): Promise<void> {
    this.record(run, sessionId);
    const login = this.logins.get(run);
    if (login === undefined) {
      throw new BridgeError(
        `run ${run} does not accept input`,
        'NOT_INTERACTIVE',
      );
    }
    await login.write(data);
  }

  /**
   * Stop a live run.
   * @param run - the run id.
   * @param sessionId - the asking session.
   * @returns whether a live run was asked to stop.
   */
  cancel(run: RunId, sessionId?: string): 'requested' | 'already-finished' {
    const record = this.record(run, sessionId);
    if (record.state.isSettled) return 'already-finished';
    record.controller.abort();
    return 'requested';
  }

  /**
   * Cancel every live run and wait for the processes to go away.
   *
   * The plugin's disposer awaits this, so unloading the plugin cannot leave a
   * delegate running against a workspace nothing is watching.
   */
  async dispose(): Promise<void> {
    // Queued first: a run still waiting for a slot has no record to abort, and
    // freeing slots below would otherwise admit it as the plugin unloads.
    this.closing.abort();
    for (const record of this.records.values()) record.controller.abort();
    await Promise.allSettled(
      [...this.records.values()].map((record) => record.settled),
    );
    this.records.clear();
    this.logins.clear();
  }

  /** How many delegates are executing, and how many rounds are queued behind them. */
  get load(): { readonly running: number; readonly queued: number } {
    return { running: this.slots.inUse, queued: this.slots.queued };
  }

  /**
   * The markers this deployment's contract states.
   *
   * The next-steps marker is stated only while something will act on it: an
   * unread marker would silently cut its own text out of the summary the model
   * receives.
   * @returns the markers, for both the prompt and the classifier.
   */
  private markers(): ContractMarkers {
    const { marker, nextStepsMarker } = this.deps.config.direction;
    return {
      direction: marker,
      ...(this.deps.autonomy?.() ?? this.deps.config.autonomy).continue
        ? { nextSteps: nextStepsMarker }
        : {},
    };
  }

  /** Issue the next `<cli>-<n>` id. */
  private issue(cli: CliId): RunId {
    const next = (this.counters.get(cli) ?? 0) + 1;
    this.counters.set(cli, next);
    return `${cli}-${String(next)}`;
  }

  /** Resolve a visible run, or refuse. */
  private record(run: RunId, sessionId?: string): RunRecord {
    const record = this.records.get(run);
    if (
      record === undefined || !this.visible(record.state.snapshot, sessionId)
    ) {
      throw new BridgeError(
        `no run named ${JSON.stringify(run)}`,
        'UNKNOWN_RUN',
      );
    }
    return record;
  }

  /** Whether a session may see a run: its own runs, and unowned ones. */
  private visible(snapshot: RunSnapshot, sessionId?: string): boolean {
    return snapshot.sessionId === undefined || snapshot.sessionId === sessionId;
  }

  /**
   * Run a body, guaranteeing settlement.
   *
   * A failure BEFORE the delegate starts — a missing CLI, a failed install — is
   * still a settled run rather than a rejected promise, so every start has one
   * shape for the caller and the failure is visible on the channel.
   * @param state - the run being driven.
   * @param controller - its cancellation.
   * @param body - the driver.
   * @returns the terminal facts.
   */
  private async execute(
    state: RunState,
    controller: AbortController,
    body: () => Promise<RunEnd>,
  ): Promise<RunEnd> {
    const startedAt = this.deps.now();
    try {
      return await body();
    } catch (error) {
      return state.finish({
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        summary: '',
        ...controller.signal.aborted ? {} : { error: describeError(error) },
        durationMs: this.deps.now() - startedAt,
      }, this.deps.now());
    } finally {
      this.trim();
    }
  }

  /** Evict the oldest settled runs beyond the retention budget. */
  private trim(): void {
    const settled = [...this.records.entries()]
      .filter(([, record]) => record.state.isSettled)
      .toSorted(([, left], [, right]) =>
        (left.state.snapshot.finishedAt ?? 0) -
        (right.state.snapshot.finishedAt ?? 0)
      );
    for (
      const [id] of settled.slice(
        0,
        Math.max(0, settled.length - this.deps.config.limits.retainedRuns),
      )
    ) {
      this.records.delete(id);
      this.logins.delete(id);
      this.deps.hub.forget(id);
    }
  }
}

/** Treat the empty configuration sentinel as absence. */
function emptyToUndefined<T extends string>(value: T | ''): T | undefined {
  return value === '' ? undefined : value;
}
