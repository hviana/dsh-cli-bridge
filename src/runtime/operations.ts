/**
 * The one implementation every surface calls.
 *
 * Model-facing tools, the `/cli` command, and the browser panel are three
 * FACES of this object — none of them owns behaviour. That is what keeps the
 * three from drifting: adding an operation here gives all three the same
 * semantics, and fixing one fixes all three.
 *
 * @module dsh-cli-bridge/runtime/operations
 */
import type {
  AdviceRoute,
  AutonomySwitches,
  BatchId,
  BridgeState,
  CliId,
  ControlRequest,
  ControlResponse,
  DelegationId,
  DelegationSnapshot,
  OutputPipe,
  PermissionMode,
  RunId,
} from '../shared/protocol.ts';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AutonomyConfig, Config } from '../config.ts';
import { AccountStore, type AddAccountRequest } from './accounts.ts';
import { adviceTarget, type AdvisorPort, modelAdvisor } from './advisor.ts';
import { Batch, type BatchEntry, type BatchTask } from './batch.ts';
import { StreamHub } from './channel.ts';
import type { Delegation } from './delegation.ts';
import { DirectionLedger } from './directions.ts';
import { BridgeError, describeError } from './errors.ts';
import { commandGit } from './git.ts';
import { type InquiryPort, userQuestionsInquiry } from './inquiry.ts';
import { MergeQueue } from './merge.ts';
import { BridgePaths, resolveStateDir } from './paths.ts';
import type { RuntimePorts } from './ports.ts';
import {
  RunRegistry,
  type StartedRun,
  type StartTaskRequest,
} from './registry.ts';
import { Toolchain } from './toolchain.ts';
import { type WorkspaceLease, Workspaces } from './workspace.ts';

/** One delegation this process is keeping track of. */
interface Tracked {
  readonly delegation: Delegation;
  readonly lease: WorkspaceLease;
  readonly cancel: () => void;
}

/** What one delegation call asks for. */
export interface StartBatchRequest {
  readonly tasks: readonly BatchTask[];
  readonly permission: PermissionMode;
  /** The session workspace: the base repository, and the inline fallback. */
  readonly base: string;
  readonly sessionId?: string;
  readonly callId?: string;
  readonly agent?: Agent;
  /** The caller's cancellation — the tool call's own signal. */
  readonly signal: AbortSignal;
}

/** Everything the plugin's surfaces need, assembled once. */
export class BridgeOperations {
  readonly paths: BridgePaths;
  readonly hub: StreamHub;
  readonly accounts: AccountStore;
  readonly toolchain: Toolchain;
  readonly runs: RunRegistry;
  readonly directions: DirectionLedger;
  readonly workspaces: Workspaces;
  private readonly merges = new MergeQueue();
  private readonly tracked = new Map<DelegationId, Tracked>();
  private readonly advisor: AdvisorPort | undefined;
  private readonly inquiry: InquiryPort | undefined;
  private readonly inFlight = new Set<Promise<unknown>>();
  private batches = 0;
  private delegations = 0;
  /**
   * How many batches are currently working in each base path.
   *
   * Isolation's `auto` mode gives a delegation its own worktree exactly when
   * it could collide with another, and "another" is not only the tasks of its
   * own batch: two single-task calls can hold the same base at once, and each
   * would see nobody else there while the other is mid-edit. Counting them
   * here is what lets the second one isolate instead of sharing the tree.
   */
  private readonly basesInUse = new Map<string, number>();
  /**
   * What the user has switched on, over the configured defaults.
   *
   * Autonomy is off until a person asks for it, and only a person can ask: this
   * is set from the `/cli auto` command and the panel, never from a tool.
   */
  private switches: AutonomySwitches;

  constructor(readonly config: Config, private readonly ports: RuntimePorts) {
    this.paths = new BridgePaths(resolveStateDir(config.stateDir));
    this.hub = new StreamHub(config.channel.bufferBytesPerStream, ports.now);
    this.directions = new DirectionLedger(ports.now);
    this.accounts = new AccountStore(
      this.paths,
      ports.files,
      ports.now,
      ports.credentials,
    );
    this.workspaces = new Workspaces(
      this.paths,
      ports.files,
      commandGit(ports.process, ports.now, {
        timeoutMs: config.isolation.gitTimeoutMs,
        graceMs: config.limits.terminateGraceMs,
        maxOutputBytes: config.limits.stderrTailBytes,
      }),
      config.isolation,
    );
    // Autonomy has something to consult only where the composition has a model
    // service; a question has somewhere to go only where it has a human.
    const { decide, continue: keepGoing, review } = config.autonomy;
    this.switches = { decide, continue: keepGoing, review };
    this.advisor = ports.llm === undefined
      ? undefined
      : modelAdvisor(ports.llm, config.autonomy.advisor);
    this.inquiry = ports.questions === undefined
      ? undefined
      : userQuestionsInquiry(ports.questions, config.inquiry);
    this.toolchain = new Toolchain(
      this.paths,
      ports.files,
      ports.process,
      ports.now,
      ports.platform,
      ports.nodePath,
      config.toolchain,
      config.delegates,
    );
    this.runs = new RunRegistry({
      hub: this.hub,
      accounts: this.accounts,
      toolchain: this.toolchain,
      process: ports.process,
      config,
      now: ports.now,
    });
  }

  /**
   * Delegate a task directly, without a delegation loop around it.
   *
   * The `/cli` command and the tests use this; the model-facing tools go through
   * {@link startBatch}, because a delegation is what they are allowed to see.
   * @param request - what to delegate.
   * @returns the started run.
   */
  async startTask(request: StartTaskRequest): Promise<StartedRun> {
    return this.runs.start(request);
  }

  /**
   * Delegate one or more tasks, each carried to a terminus.
   *
   * One task or ten, this is the same path: the isolation decision, the round
   * loop, the merge and the aggregation do not care how many there are.
   * @param request - the tasks, and the conditions they run under.
   * @returns one entry per task, in the order they were asked for.
   */
  async startBatch(request: StartBatchRequest): Promise<BatchEntry[]> {
    this.batches += 1;
    try {
      // The claim and its release bracket the whole batch — construction
      // included — so no path out of here can leave the base counted forever.
      const baseContended = this.claimBase(request.base);
      const batch = new Batch({
        id: `b${String(this.batches)}` satisfies BatchId,
        tasks: request.tasks,
        permission: request.permission,
        base: request.base,
        baseContended,
        ...request.sessionId === undefined
          ? {}
          : { sessionId: request.sessionId },
        ...request.callId === undefined ? {} : { callId: request.callId },
        ...request.agent === undefined ? {} : { agent: request.agent },
      }, this.batchDeps());
      return await this.track(batch.run(request.signal));
    } finally {
      this.releaseBase(request.base);
    }
  }

  /**
   * Continue a settled delegation.
   *
   * It becomes a NEW delegation that resumes the delegate's own session: the
   * previous one's work has already been merged and its worktree removed, so the
   * continuation needs a workspace of its own. Its directions and lineage come
   * with it.
   * @param delegation - the delegation to continue.
   * @param message - what to tell the delegate.
   * @param request - the conditions the continuation runs under.
   * @returns the entry for the continuation.
   * @throws {BridgeError} when the delegation is unknown or cannot be continued.
   */
  async replyToDelegation(
    delegation: DelegationId,
    message: string,
    request: Omit<StartBatchRequest, 'tasks' | 'permission' | 'base'>,
  ): Promise<BatchEntry> {
    const previous =
      this.tracking(delegation, request.sessionId).delegation.state;
    const lastRun = previous.rounds.at(-1);
    if (previous.finishedAt === undefined || lastRun === undefined) {
      // The two live states want different refusals. A delegation mid-question
      // is waiting on the PERSON, and a model that "helps" by replying would be
      // answering somebody else's question; one mid-round simply cannot be
      // continued yet. Both are still the same error, so the caller does not
      // retry a corrected call that could not exist.
      const waiting = previous.status === 'awaiting-human';
      throw new BridgeError(
        waiting
          ? `delegation ${delegation} is waiting for the user to answer its question; only the user's answer resumes it — do not answer on their behalf`
          : `delegation ${delegation} is still running`,
        'INVALID_REQUEST',
      );
    }
    // The delegate session lives on the RUN, so a round dropped by retention —
    // or a delegate that never named a session — cannot be resumed. Finding
    // that out here costs nothing; finding it out later would already have cut
    // a worktree for work that cannot happen.
    const resumable = this.runs.list(request.sessionId)
      .some((run) => run.id === lastRun && run.delegateSessionId !== undefined);
    if (!resumable) {
      throw new BridgeError(
        `delegation ${delegation} left no delegate session to resume; delegate the work afresh`,
        'INVALID_REQUEST',
      );
    }

    const base = this.baseOf(previous);
    try {
      // Same bracket as startBatch: the claim and its release cover every path.
      const baseContended = this.claimBase(base);
      const batch = new Batch({
        id: previous.batch,
        tasks: [{
          cli: previous.cli,
          prompt: message,
          account: previous.account,
          ...previous.model === undefined ? {} : { model: previous.model },
          ...previous.effort === undefined ? {} : { effort: previous.effort },
        }],
        permission: previous.permission,
        base,
        baseContended,
        ...request.sessionId === undefined
          ? {}
          : { sessionId: request.sessionId },
        ...request.callId === undefined ? {} : { callId: request.callId },
        ...request.agent === undefined ? {} : { agent: request.agent },
      }, this.batchDeps({ resumeFrom: lastRun, parent: delegation }));
      const [entry] = await this.track(batch.run(request.signal));
      /* v8 ignore next -- a one-task batch always yields one entry. */
      if (entry === undefined) {
        throw new BridgeError(
          'the continuation produced no delegation',
          'INVALID_REQUEST',
        );
      }
      return entry;
    } finally {
      this.releaseBase(base);
    }
  }

  /**
   * Add a standing instruction to a delegation.
   *
   * This is the human's override: it is consumed before any automatic decision,
   * and its arrival cancels one already in flight.
   * @param delegation - the delegation to direct.
   * @param text - the instruction.
   * @param sessionId - the asking session, which must be allowed to see it.
   * @param origin - who is directing; only a user direction overrides.
   * @throws {BridgeError} `UNKNOWN_RUN` when the delegation is not visible here.
   */
  direct(
    delegation: DelegationId,
    text: string,
    sessionId?: string,
    origin: 'user' | 'model' = 'user',
  ): void {
    this.tracking(delegation, sessionId);
    // A direction on a FINISHED delegation is allowed on purpose: it is a
    // standing instruction for the work, not for one attempt at it, and the
    // delegation's continuation inherits it — delivered ones as context,
    // undelivered ones still pending and still overriding.
    if (text.trim().length === 0) {
      throw new BridgeError(
        'a direction needs something in it',
        'INVALID_REQUEST',
      );
    }
    this.directions.add(delegation, origin, text);
  }

  /**
   * Stop one delegation and every round it would still have spent.
   * @param delegation - the delegation to stop.
   * @param sessionId - the asking session, which must be allowed to see it.
   * @throws {BridgeError} `UNKNOWN_RUN` when the delegation is not visible here,
   *   `INVALID_REQUEST` when it has already finished.
   */
  cancelDelegation(delegation: DelegationId, sessionId?: string): void {
    const tracked = this.tracking(delegation, sessionId);
    // A stop that silently stops nothing leaves the caller believing a running
    // task was halted; the refusal names the state it is actually in.
    if (tracked.delegation.state.finishedAt !== undefined) {
      throw new BridgeError(
        `delegation ${delegation} is already finished; there is nothing left to stop`,
        'INVALID_REQUEST',
      );
    }
    tracked.cancel();
  }

  /**
   * The tracked delegation one session may act on.
   *
   * Fenced exactly as a run is: a session reaches its own delegations and the
   * unowned ones, and everything else is simply not there.
   * @param delegation - the delegation id.
   * @param sessionId - the asking session.
   * @returns what is being tracked for it.
   * @throws {BridgeError} `UNKNOWN_RUN` when it does not exist or belongs elsewhere.
   */
  private tracking(delegation: DelegationId, sessionId?: string): Tracked {
    const tracked = this.tracked.get(delegation);
    if (
      tracked === undefined ||
      !this.visible(tracked.delegation.state, sessionId)
    ) {
      throw new BridgeError(
        `no delegation named ${JSON.stringify(delegation)}`,
        'UNKNOWN_RUN',
      );
    }
    return tracked;
  }

  /**
   * The autonomy in force: the configured settings, as the user has switched them.
   * @returns the effective settings.
   */
  get autonomy(): AutonomyConfig {
    return { ...this.config.autonomy, ...this.switches };
  }

  /**
   * Switch one automatic decision on or off, for this process.
   *
   * It applies from the next decision onward, including for delegations already
   * running — a person who turns autonomy off mid-run means "stop deciding for
   * me", and waiting for the delegation to end would answer a different
   * question.
   * @param name - which decision.
   * @param on - whether DeepSeek may make it.
   */
  setAutonomy(name: keyof AutonomySwitches, on: boolean): void {
    this.switches = { ...this.switches, [name]: on };
  }

  /**
   * List the delegations visible to one session.
   * @param sessionId - the asking session.
   * @returns snapshots in creation order.
   */
  listDelegations(sessionId?: string): DelegationSnapshot[] {
    return [...this.tracked.values()]
      .map((tracked) => tracked.delegation.state)
      .filter((snapshot) => this.visible(snapshot, sessionId));
  }

  /**
   * Everything a panel or a status command shows, in one read.
   *
   * An UNSCOPED read is the human channel asking, and it sees everything — the
   * same rule the delegation list already followed. A scoped read is a session
   * asking about its own work and stays fenced to it.
   * @param sessionId - the asking session; omit for the human channel.
   * @returns runs, accounts, and toolchain state.
   */
  async state(sessionId?: string): Promise<BridgeState> {
    const [accounts, toolchain] = await Promise.all([
      this.accounts.list(),
      this.toolchain.statuses(),
    ]);
    const advice = this.adviceRoute();
    return {
      runs: sessionId === undefined
        ? this.runs.listAll()
        : this.runs.list(sessionId),
      delegations: this.listDelegations(sessionId),
      accounts,
      toolchain,
      autonomy: this.switches,
      ...advice === undefined ? {} : { advice },
    };
  }

  /**
   * The route an automatic decision would run on right now.
   *
   * Resolved WITHOUT a session, because a state read holds no delegation: it
   * answers "could autonomy act at all here", which is what a person flipping a
   * switch is really asking. A live decision resolves the same way, with the
   * calling session added as a second source.
   * @returns the route, or `undefined` when autonomy cannot act.
   */
  private adviceRoute(): AdviceRoute | undefined {
    return this.advisor === undefined ? undefined : adviceTarget(
      this.config.autonomy.advisor,
      undefined,
      this.ports.defaultRoute?.(),
    );
  }

  /**
   * Add an account and create its private CLI home.
   * @param request - the account to add.
   * @returns its snapshot.
   */
  async addAccount(request: AddAccountRequest): Promise<void> {
    await this.accounts.add(request);
  }

  /**
   * Run one control operation on behalf of a surface.
   *
   * Every branch answers with the refreshed state, so a caller renders the
   * result of its own action without a second round trip — and a failure is a
   * message rather than a thrown value, because the browser panel is one of
   * the callers and a stack trace is not a user interface.
   * @param request - the operation.
   * @param sessionId - the asking session, for run fencing.
   * @returns the refreshed state, or an explanation.
   */
  async control(
    request: ControlRequest,
    sessionId?: string,
  ): Promise<ControlResponse> {
    try {
      const run = await this.dispatch(request, sessionId);
      return {
        ok: true,
        state: await this.state(sessionId),
        ...run === undefined ? {} : { run },
      };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }

  /**
   * Cancel every live delegation and run, then let the merges finish.
   *
   * The batches are awaited BEFORE the queue is drained: a delegation that has
   * just been cancelled still has a commit to make, and draining a queue it has
   * not reached yet would report a quiet that is not there.
   */
  async dispose(): Promise<void> {
    for (const tracked of this.tracked.values()) tracked.cancel();
    await this.runs.dispose();
    await Promise.allSettled(this.inFlight);
    await this.merges.drain();
    this.tracked.clear();
  }

  /**
   * Count this batch into its base, and say whether something was already there.
   * @param base - the workspace the batch will work in.
   * @returns true when at least one other batch was already working there.
   */
  private claimBase(base: string): boolean {
    const count = (this.basesInUse.get(base) ?? 0) + 1;
    this.basesInUse.set(base, count);
    return count > 1;
  }

  /**
   * Count one finished batch out of its base.
   * @param base - the workspace the batch worked in.
   */
  private releaseBase(base: string): void {
    const count = this.basesInUse.get(base) ?? 0;
    if (count <= 1) this.basesInUse.delete(base);
    else this.basesInUse.set(base, count - 1);
  }

  /**
   * Keep one batch in view until it settles, so disposal can wait for it.
   * @param running - the batch's promise.
   * @returns the same promise.
   */
  private async track<T>(running: Promise<T>): Promise<T> {
    this.inFlight.add(running);
    try {
      return await running;
    } finally {
      this.inFlight.delete(running);
    }
  }

  /**
   * The collaborators every batch shares.
   * @param inherit - lineage for a continuation: the run to resume and the
   *   delegation it continues.
   * @returns the dependencies.
   */
  private batchDeps(inherit?: { resumeFrom: RunId; parent: DelegationId }) {
    return {
      runs: this.runs,
      hub: this.hub,
      directions: this.directions,
      config: this.config,
      autonomy: () => this.autonomy,
      now: this.ports.now,
      workspaces: this.workspaces,
      merges: this.merges,
      ...this.advisor === undefined ? {} : { advisor: this.advisor },
      ...this.ports.defaultRoute === undefined
        ? {}
        : { defaultRoute: this.ports.defaultRoute },
      ...this.inquiry === undefined ? {} : { inquiry: this.inquiry },
      ...inherit === undefined ? {} : { inherit },
      nextDelegationId: (): DelegationId => {
        this.delegations += 1;
        return `d${String(this.delegations)}`;
      },
      onDelegation: (
        delegation: Delegation,
        lease: WorkspaceLease,
        cancel: () => void,
      ): void => {
        const id = delegation.state.id;
        this.tracked.set(id, { delegation, lease, cancel });
        // Seeded before the first round can be decided, so a continuation is
        // steered by everything its parent was steered by.
        if (inherit !== undefined) this.directions.inherit(inherit.parent, id);
        this.trim();
      },
    };
  }

  /** The workspace a continuation should run against. */
  private baseOf(previous: DelegationSnapshot): string {
    // A worktree is gone by the time anyone can continue from it, so the
    // continuation starts from the session workspace it was cut from — which
    // the lease recorded for exactly this reason.
    return previous.workspace.origin ?? previous.workspace.path;
  }

  /** Whether a session may see a delegation: its own, and unowned ones. */
  private visible(snapshot: DelegationSnapshot, sessionId?: string): boolean {
    return sessionId === undefined || snapshot.sessionId === undefined ||
      snapshot.sessionId === sessionId;
  }

  /**
   * Forget the oldest settled delegations beyond the retention budget.
   *
   * Only settled ones are candidates, and the budget counts every delegation
   * being kept — a live one occupies a slot rather than being exempt from it.
   */
  private trim(): void {
    const settled = [...this.tracked.entries()]
      .filter(([, tracked]) =>
        tracked.delegation.state.finishedAt !== undefined
      )
      .toSorted(([, left], [, right]) =>
        (left.delegation.state.finishedAt ?? 0) -
        (right.delegation.state.finishedAt ?? 0)
      );
    const excess = this.tracked.size - this.config.limits.retainedRuns;
    for (const [id] of settled.slice(0, Math.max(0, excess))) {
      this.tracked.delete(id);
      this.directions.forget(id);
      this.hub.forget(id);
    }
  }

  /** Perform one control operation, returning a run id when it started one. */
  private async dispatch(
    request: ControlRequest,
    sessionId?: string,
  ): Promise<RunId | undefined> {
    switch (request.op) {
      case 'account.add':
        await this.accounts.add({
          cli: request.cli,
          ...request.id === undefined ? {} : { id: request.id },
          auth: request.auth,
          ...request.label === undefined ? {} : { label: request.label },
          ...request.credentialRef === undefined
            ? {}
            : { credentialRef: request.credentialRef },
          ...request.baseUrl === undefined ? {} : { baseUrl: request.baseUrl },
          ...request.model === undefined ? {} : { model: request.model },
        });
        return undefined;
      case 'account.remove':
        await this.accounts.remove(request.cli, request.id);
        return undefined;
      case 'account.default':
        await this.accounts.setDefault(request.cli, request.id);
        return undefined;
      case 'account.login':
        return (await this.runs.startLogin(request.cli, request.id, sessionId))
          .snapshot.id;
      case 'toolchain.install':
      case 'toolchain.update':
        await this.installToolchain(request.cli);
        return undefined;
      case 'run.cancel':
        this.runs.cancel(request.run, sessionId);
        return request.run;
      case 'run.input':
        await this.runs.write(request.run, request.data, sessionId);
        return request.run;
      case 'delegation.direct':
        this.direct(request.delegation, request.text, sessionId);
        return request.delegation;
      case 'delegation.cancel':
        this.cancelDelegation(request.delegation, sessionId);
        return request.delegation;
      case 'autonomy.set':
        this.setAutonomy(request.switch, request.on);
        return undefined;
    }
  }

  /**
   * Install or update one delegate, streaming npm's output to the channel.
   * @param cli - the delegate to install.
   */
  private async installToolchain(cli: CliId): Promise<void> {
    await this.streamInstall(
      `${cli}-install`,
      (sink) => this.toolchain.install(cli, sink),
      `${cli} is up to date`,
    );
  }

  /**
   * Update every managed delegate whose install has gone stale.
   *
   * Called on a timer by the plugin. It touches the network only for a delegate
   * this plugin installed itself and has not refreshed within the configured
   * interval, so the common case costs one file read.
   * @returns the delegates that were updated.
   */
  async refreshToolchain(): Promise<readonly CliId[]> {
    let updated: readonly CliId[] = [];
    await this.streamInstall(
      'toolchain-update',
      async (sink) => {
        updated = await this.toolchain.refreshStale(sink);
      },
      'delegates are up to date',
    );
    return updated;
  }

  /**
   * Run an installer with its output on the channel.
   *
   * The output goes to the hub under a synthetic run id so a panel renders an
   * install exactly like it renders a delegated run — one stream, one view.
   * @param id - synthetic run id carrying the install's stream.
   * @param body - the installer, handed the output sink.
   * @param done - notice published when the body succeeds.
   */
  private async streamInstall(
    id: RunId,
    body: (sink: (pipe: OutputPipe, text: string) => void) => Promise<unknown>,
    done: string,
  ): Promise<void> {
    try {
      await body((pipe, text) => {
        this.hub.publish(id, { kind: 'output', pipe, text });
      });
      this.hub.publish(id, {
        kind: 'activity',
        activity: { type: 'notice', level: 'info', text: done },
      });
    } catch (error) {
      this.hub.publish(id, {
        kind: 'activity',
        activity: {
          type: 'notice',
          level: 'error',
          text: describeError(error),
        },
      });
      throw error instanceof BridgeError
        ? error
        : new BridgeError(describeError(error), 'INSTALL_FAILED', {
          cause: error,
        });
    } finally {
      this.hub.forget(id);
    }
  }
}
