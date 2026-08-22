/**
 * Several delegations, one call.
 *
 * "Build the auth stack with account X and the BI stack with account Y" is one
 * tool call, two delegations, two accounts, two isolated worktrees — and one
 * merge queue, because two merges into one branch at the same time is a race the
 * repository loses.
 *
 * A single delegation is a batch of one. There is no second code path for it:
 * the isolation decision, the merge, and the aggregation are the same in both
 * cases, and a lone delegation simply has nobody to collide with.
 *
 * @module dsh-cli-bridge/runtime/batch
 */
import type {
  BatchId,
  CliId,
  DelegationId,
  DelegationSnapshot,
  EffortLevel,
  PermissionMode,
  RunId,
} from '../shared/protocol.ts';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Config } from '../config.ts';
import { Delegation, type DelegationDeps } from './delegation.ts';
import type { MergeQueue } from './merge.ts';
import { anySignal } from './signals.ts';
import type { WorkspaceLease, Workspaces } from './workspace.ts';

/** One task in a batch. */
export interface BatchTask {
  readonly cli: CliId;
  readonly prompt: string;
  readonly account?: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  /** Wall-clock budget for one run of this task; omitted uses the deployment default. */
  readonly timeoutMs?: number;
}

/** What one call asked for. */
export interface BatchRequest {
  readonly id: BatchId;
  readonly tasks: readonly BatchTask[];
  readonly permission: PermissionMode;
  /** The session workspace: the base repository, and the inline fallback. */
  readonly base: string;
  readonly sessionId?: string;
  readonly callId?: string;
  readonly agent?: Agent;
  /**
   * Whether another batch is already working in the base right now.
   *
   * Carried rather than computed: this batch is not the only thing that could
   * be there — two single-task batches from two calls can hold the same base
   * at once — and the owner above is the one that can see them all.
   */
  readonly baseContended?: boolean;
}

/** Everything a batch drives. */
export interface BatchDeps extends Omit<DelegationDeps, 'evidence'> {
  readonly workspaces: Workspaces;
  readonly config: Config;
  /** The process-wide merge queue; merges serialize across batches, not within one. */
  readonly merges: MergeQueue;
  /** Mints delegation ids, so identity stays with the registry that owns it. */
  readonly nextDelegationId: () => DelegationId;
  /**
   * Lineage for a continuation: the settled run whose delegate session carries
   * on — or the delegate session itself, when the run has been trimmed — and
   * the delegation it carries on from.
   */
  readonly inherit?: {
    readonly resumeFrom?: RunId;
    readonly resumeSession?: string;
    readonly parent: DelegationId;
  };
  /**
   * Announces each delegation as it is created, with the handle that stops just
   * that one. The owner above keeps them so a surface can direct or cancel a
   * single delegation of a batch.
   */
  readonly onDelegation?: (
    delegation: Delegation,
    lease: WorkspaceLease,
    cancel: () => void,
  ) => void;
}

/** One prepared delegation: its loop, its workspace, and its own stop. */
interface Prepared {
  readonly delegation: Delegation;
  readonly lease: WorkspaceLease;
  readonly own: AbortController;
}

/** One delegation's outcome, with what became of its work. */
export interface BatchEntry {
  readonly snapshot: DelegationSnapshot;
}

/** Several delegations run together and merged in completion order. */
export class Batch {
  constructor(
    private readonly request: BatchRequest,
    private readonly deps: BatchDeps,
  ) {}

  /**
   * Run every delegation, merge what each produced, and report them all.
   * @param signal - the caller's cancellation, which stops every delegation.
   * @returns one entry per task, in the order they were asked for.
   */
  async run(signal: AbortSignal): Promise<BatchEntry[]> {
    const contended = this.request.tasks.length > 1 ||
      this.request.baseContended === true;
    const delegations = await Promise.all(
      this.request.tasks.map(async (task) => this.prepare(task, contended)),
    );
    return Promise.all(
      delegations.map(async (prepared) => this.drive(prepared, signal)),
    );
  }

  /** Claim a workspace and build the delegation that will use it. */
  private async prepare(
    task: BatchTask,
    contended: boolean,
  ): Promise<Prepared> {
    const id = this.deps.nextDelegationId();
    const lease = await this.deps.workspaces.acquire({
      delegation: id,
      base: this.request.base,
      contended,
    });
    const delegation = new Delegation({
      id,
      batch: this.request.id,
      cli: task.cli,
      task: task.prompt,
      permission: this.request.permission,
      workspace: lease.state,
      ...task.account === undefined ? {} : { account: task.account },
      ...task.model === undefined ? {} : { model: task.model },
      ...task.effort === undefined ? {} : { effort: task.effort },
      ...task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs },
      ...this.request.sessionId === undefined
        ? {}
        : { sessionId: this.request.sessionId },
      ...this.request.callId === undefined
        ? {}
        : { callId: this.request.callId },
      ...this.request.agent === undefined ? {} : { agent: this.request.agent },
      ...this.deps.inherit === undefined ? {} : {
        parent: this.deps.inherit.parent,
        ...this.deps.inherit.resumeFrom === undefined
          ? {}
          : { resumeFrom: this.deps.inherit.resumeFrom },
        ...this.deps.inherit.resumeSession === undefined
          ? {}
          : { resumeSession: this.deps.inherit.resumeSession },
      },
    }, {
      runs: this.deps.runs,
      hub: this.deps.hub,
      directions: this.deps.directions,
      config: this.deps.config,
      // The LIVE autonomy reader, not the configured defaults. A person turns
      // autonomy on and off mid conversation and a delegation must see that at
      // its next decision; omitting it here was what made every switch inert —
      // the delegation fell back to `config.autonomy`, where all three are off,
      // so a toggle moved the panel and reached nothing that decides.
      ...this.deps.autonomy === undefined
        ? {}
        : { autonomy: this.deps.autonomy },
      now: this.deps.now,
      evidence: async () => lease.evidence(),
      ...this.deps.advisor === undefined ? {} : { advisor: this.deps.advisor },
      ...this.deps.defaultRoute === undefined
        ? {}
        : { defaultRoute: this.deps.defaultRoute },
      ...this.deps.inquiry === undefined ? {} : { inquiry: this.deps.inquiry },
    });
    const own = new AbortController();
    this.deps.onDelegation?.(delegation, lease, () => own.abort());
    return { delegation, lease, own };
  }

  /** Run one delegation, then commit and merge whatever it produced. */
  private async drive(
    prepared: Prepared,
    signal: AbortSignal,
  ): Promise<BatchEntry> {
    // The call's cancellation and this delegation's own stop both reach it.
    const combined = anySignal([signal, prepared.own.signal]);
    try {
      const snapshot = await prepared.delegation.run(combined.signal);
      const workspace = await this.deps.merges.settle(prepared.lease, snapshot);
      prepared.delegation.mergeReported(workspace);
      return { snapshot: prepared.delegation.state };
    } finally {
      combined.dispose();
    }
  }
}
