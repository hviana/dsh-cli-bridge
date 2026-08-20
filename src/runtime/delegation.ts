/**
 * One delegation: a task carried through as many rounds as it takes.
 *
 * A round is one delegate run. Between rounds the pure policy in
 * `domain/continuation.ts` says what should happen; this loop is what carries it
 * out — asking the human, consulting the session's model, or resuming the
 * delegate — and records who decided what.
 *
 * It composes the run registry rather than replacing it: round one is a
 * `start`, every later round is the registry's own `reply`, which resumes the
 * delegate's session under the original account, model and permission mode.
 *
 * @module dsh-cli-bridge/runtime/delegation
 */
import type {
  Activity,
  BatchId,
  CliId,
  DecisionRecord,
  DelegationId,
  DelegationSnapshot,
  DelegationStatus,
  EffortLevel,
  PermissionMode,
  RunEnd,
  RunId,
  RunUsage,
  WorkspaceState,
} from '../shared/protocol.ts';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Evidence } from '../domain/advice.ts';
import { adviceRequest, parseAdvice } from '../domain/advice.ts';
import type { Continuation, RoundFacts } from '../domain/continuation.ts';
import { applyAdvice, applyAnswer, nextStep } from '../domain/continuation.ts';
import { boundHead, oneLineLabel } from '../domain/text.ts';
import type { AutonomyConfig, Config } from '../config.ts';
import { adviceTarget, type AdvisorPort } from './advisor.ts';
import type { StreamHub } from './channel.ts';
import type { DirectionLedger } from './directions.ts';
import { describeError } from './errors.ts';
import type { InquiryPort } from './inquiry.ts';
import type { RunRegistry } from './registry.ts';
import { anySignal } from './signals.ts';

/** Characters of task kept as a delegation's label. */
const LABEL_CHARS = 72;

/**
 * How many times one round may bounce between deciders.
 *
 * A `continue` that answers "finished" re-enters the policy, which may then ask
 * for a review — a legitimate second pass. This bounds that chain so a
 * misbehaving advisor cannot ping-pong forever inside a single round.
 */
const DECISION_PASSES = 4;

/** What one delegation was asked to do. */
export interface DelegationRequest {
  readonly id: DelegationId;
  readonly batch: BatchId;
  readonly cli: CliId;
  /** The task as the caller stated it. */
  readonly task: string;
  readonly account?: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  readonly permission: PermissionMode;
  /** Where the delegate runs — the session workspace, or an isolated worktree. */
  readonly workspace: WorkspaceState;
  readonly sessionId?: string;
  readonly callId?: string;
  /** The calling agent, for the human's question and the advisor's route. */
  readonly agent?: Agent;
  /**
   * A settled run whose delegate session this delegation continues.
   *
   * Set when the caller replies to a delegation that already finished: the work
   * carries on in the delegate's own session, in a fresh workspace of its own,
   * because the previous one has already been merged and removed.
   */
  readonly resumeFrom?: RunId;
  /** The delegation this one continues, for lineage. */
  readonly parent?: DelegationId;
}

/** Everything the loop drives. */
export interface DelegationDeps {
  readonly runs: RunRegistry;
  readonly hub: StreamHub;
  readonly directions: DirectionLedger;
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
  /** Absent when the composition cannot consult a model. */
  readonly advisor?: AdvisorPort;
  /** Absent when the composition cannot reach a human. */
  readonly inquiry?: InquiryPort;
  /**
   * What the delegation produced, for a review. Absent for an inline
   * delegation, where there is no isolated diff to show.
   */
  readonly evidence?: () => Promise<Evidence>;
}

/** One delegation, driven to a terminus. */
export class Delegation {
  private snapshot: DelegationSnapshot;
  private readonly files = new Set<string>();
  private reviews = 0;
  private continueJudged = false;
  private lastRun: RunId | undefined;

  constructor(
    private readonly request: DelegationRequest,
    private readonly deps: DelegationDeps,
  ) {
    this.snapshot = {
      id: request.id,
      batch: request.batch,
      label: oneLineLabel(request.task, LABEL_CHARS),
      cli: request.cli,
      account: request.account ?? 'ambient',
      permission: request.permission,
      status: 'running',
      rounds: [],
      workspace: request.workspace,
      directions: [],
      decisions: [],
      startedAt: deps.now(),
      ...request.parent === undefined ? {} : { parent: request.parent },
      ...request.model === undefined ? {} : { model: request.model },
      ...request.effort === undefined ? {} : { effort: request.effort },
      ...request.sessionId === undefined
        ? {}
        : { sessionId: request.sessionId },
      ...request.callId === undefined ? {} : { callId: request.callId },
    };
    this.lastRun = request.resumeFrom;
    this.publish();
  }

  /** The current projection, for the caller and every surface. */
  get state(): DelegationSnapshot {
    return this.snapshot;
  }

  /**
   * Run the delegation to a terminus.
   * @param signal - the caller's cancellation, which stops the whole loop.
   * @returns the settled snapshot.
   */
  async run(signal: AbortSignal): Promise<DelegationSnapshot> {
    const collect = this.watchFiles();
    try {
      let message = this.request.task;
      // Rounds are sequential by definition: each one is decided by the last.
      /* oxlint-disable eslint/no-await-in-loop */
      for (let round = 1; !signal.aborted; round += 1) {
        // The judgment is about ONE round's report, so each new round is
        // unjudged again — otherwise a delegation is only ever asked once
        // whether it is finished, however many rounds it goes on to spend.
        this.continueJudged = false;
        const end = await this.spend(message, signal);
        if (end === undefined) break;
        this.charge(end.usage);
        const step = await this.decide(round, end, signal);
        this.record(round, step);
        if (step.kind !== 'resume') {
          this.settle(end, step.kind === 'ask' ? 'needs_direction' : undefined);
          return this.snapshot;
        }
        message = step.message;
      }
      /* oxlint-enable eslint/no-await-in-loop */
      this.settle(this.lastEnd(), signal.aborted ? 'cancelled' : undefined);
      return this.snapshot;
    } finally {
      collect();
    }
  }

  /**
   * Spend one round: start the delegate, or resume it.
   * @param message - the task, or the continuation message.
   * @param signal - the caller's cancellation.
   * @returns the round's outcome, or `undefined` when it could not be spent.
   */
  private async spend(
    message: string,
    signal: AbortSignal,
  ): Promise<RunEnd | undefined> {
    try {
      const started = this.lastRun === undefined
        ? await this.deps.runs.start({
          cli: this.request.cli,
          prompt: message,
          cwd: this.request.workspace.path,
          permission: this.request.permission,
          ...this.request.account === undefined
            ? {}
            : { account: this.request.account },
          ...this.request.model === undefined
            ? {}
            : { model: this.request.model },
          ...this.request.effort === undefined
            ? {}
            : { effort: this.request.effort },
          ...this.request.sessionId === undefined
            ? {}
            : { sessionId: this.request.sessionId },
          ...this.request.callId === undefined
            ? {}
            : { callId: this.request.callId },
          // Honoured only while the round waits for a free delegate slot; once
          // it is running, the listener below is what stops it.
          signal,
        })
        : await this.deps.runs.reply({
          run: this.lastRun,
          message,
          // Every round of THIS delegation runs in THIS delegation's workspace.
          // A continuation is a new delegation with a worktree of its own, and
          // the one its parent ran in is merged and gone.
          cwd: this.request.workspace.path,
          ...this.request.sessionId === undefined
            ? {}
            : { sessionId: this.request.sessionId },
          ...this.request.callId === undefined
            ? {}
            : { callId: this.request.callId },
          signal,
        });

      this.lastRun = started.snapshot.id;
      this.snapshot = {
        ...this.snapshot,
        rounds: [...this.snapshot.rounds, started.snapshot.id],
      };
      this.publish();
      const cancel = (): void => {
        this.deps.runs.cancel(started.snapshot.id, this.request.sessionId);
      };
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
      try {
        return await started.settled;
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    } catch (error) {
      // A round that cannot even start — a delegate that named no session to
      // resume, a vanished account — ends the delegation with the reason. A
      // round abandoned while it queued for a slot is not a failure at all: the
      // caller gave up, which is a cancellation.
      const abandoned = signal.aborted;
      this.settle({
        status: abandoned ? 'cancelled' : 'failed',
        summary: this.lastEnd()?.summary ?? '',
        ...abandoned ? {} : { error: describeError(error) },
        durationMs: this.deps.now() - this.snapshot.startedAt,
      });
      return undefined;
    }
  }

  /**
   * Decide what follows one round, consulting whoever the policy names.
   * @param round - the round that just finished.
   * @param end - its outcome.
   * @param signal - the caller's cancellation.
   * @returns a `resume`, `finish`, or the `ask` that nobody answered.
   */
  private async decide(
    round: number,
    end: RunEnd,
    signal: AbortSignal,
  ): Promise<Continuation> {
    let step = nextStep(this.facts(round, end));
    // Sequential by nature: each pass decides what the next one is even for.
    /* oxlint-disable eslint/no-await-in-loop */
    for (let pass = 0; pass < DECISION_PASSES; pass += 1) {
      if (step.kind === 'resume' || step.kind === 'finish') return step;
      // A user direction arriving during the wait aborts it, and the fresh facts
      // put that direction first — the override, mechanically.
      const waiter = this.deps.directions.waiter(this.request.id);
      const combined = anySignal([signal, waiter.signal]);
      try {
        const answered = step.kind === 'ask'
          ? await this.askHuman(step.question, end, combined.signal)
          : await this.consult(step.topic, round, end, combined.signal);
        if (waiter.interrupted()) {
          step = nextStep(this.facts(round, end));
          continue;
        }
        if (answered === undefined) return step;
        step = answered;
      } finally {
        waiter.dispose();
        combined.dispose();
      }
    }
    /* oxlint-enable eslint/no-await-in-loop */
    return step;
  }

  /**
   * Put the delegate's question to the human.
   * @param question - the delegate's question.
   * @param end - the round's outcome, for context.
   * @param signal - cancellation, including a direction arriving.
   * @returns the next step, or `undefined` when nobody answered.
   */
  private async askHuman(
    question: string,
    end: RunEnd,
    signal: AbortSignal,
  ): Promise<Continuation | undefined> {
    const inquiry = this.deps.inquiry;
    if (inquiry === undefined) return undefined;
    this.snapshot = {
      ...this.snapshot,
      status: 'awaiting-human',
      question: {
        run: this.lastRun ?? '',
        question,
        context: end.summary,
        askedAt: this.deps.now(),
      },
    };
    this.publish();
    const answer = await inquiry.ask({
      delegation: this.request.id,
      question,
      context: end.summary,
      ...this.request.agent === undefined ? {} : { agent: this.request.agent },
      signal,
    });
    const { question: _asked, ...rest } = this.snapshot;
    this.snapshot = { ...rest, status: 'running' };
    this.publish();
    return answer === undefined ? undefined : applyAnswer(answer);
  }

  /**
   * Consult the session's model.
   * @param topic - what to ask it.
   * @param round - the round being decided.
   * @param end - its outcome.
   * @param signal - cancellation, including a direction arriving.
   * @returns the next step, or `undefined` when the model could not be reached.
   */
  private async consult(
    topic: 'decide' | 'continue' | 'review',
    round: number,
    end: RunEnd,
    signal: AbortSignal,
  ): Promise<Continuation | undefined> {
    const advisor = this.deps.advisor;
    const target = adviceTarget(
      this.autonomy.advisor,
      this.request.agent?.options,
    );
    if (advisor === undefined || target === undefined) return undefined;
    if (topic === 'continue') this.continueJudged = true;
    if (topic === 'review') this.reviews += 1;

    const evidence = topic === 'review' ? await this.evidence() : undefined;
    const request = adviceRequest(topic, {
      task: this.request.task,
      directions: this.deps.directions.all(this.request.id).map((record) =>
        record.text
      ),
      summary: end.summary,
      maxBytes: this.autonomy.advisor.evidenceMaxBytes,
      ...end.question === undefined ? {} : { question: end.question },
      ...evidence === undefined ? {} : { evidence },
    });

    try {
      const reply = await advisor.consult(request, target, signal);
      return applyAdvice(parseAdvice(topic, reply), this.facts(round, end));
    } catch (error) {
      // A model that cannot be reached must not stall or loop the delegation.
      this.note(
        'warn',
        `autonomy.${topic} could not consult the session model: ${
          describeError(error)
        }`,
      );
      return {
        kind: 'finish',
        reason: `the session model could not be consulted for ${topic}`,
      };
    }
  }

  /** What the delegation produced, for a review. */
  private async evidence(): Promise<Evidence> {
    const files = [...this.files].toSorted();
    const supplied = await this.deps.evidence?.().catch(() => undefined);
    return {
      files: supplied?.files !== undefined && supplied.files.length > 0
        ? supplied.files
        : files,
      ...supplied?.diffstat === undefined
        ? {}
        : { diffstat: supplied.diffstat },
    };
  }

  /** The autonomy in force right now, which a person may have just changed. */
  private get autonomy(): AutonomyConfig {
    return this.deps.autonomy?.() ?? this.deps.config.autonomy;
  }

  /** The policy's inputs at one decision point. */
  private facts(round: number, end: RunEnd): RoundFacts {
    const pending = this.deps.directions.pending(this.request.id);
    return {
      round,
      end,
      reviews: this.reviews,
      continueJudged: this.continueJudged,
      autonomy: this.autonomy,
      canAskHuman: this.deps.inquiry !== undefined &&
        this.deps.config.inquiry.enabled,
      canAdvise: this.deps.advisor !== undefined &&
        adviceTarget(this.autonomy.advisor, this.request.agent?.options) !==
          undefined,
      ...pending === undefined ? {} : { pendingDirection: pending },
    };
  }

  /** Record one decision, consuming the direction that drove it. */
  private record(round: number, step: Continuation): void {
    const source = step.kind === 'resume' ? step.source : 'policy';
    if (step.kind === 'resume' && step.source === 'direction') {
      const pending = this.deps.directions.pending(this.request.id);
      if (pending !== undefined) {
        this.deps.directions.consume(this.request.id, pending.id, round);
      }
    }
    const decision: DecisionRecord = {
      round,
      source,
      kind: step.kind,
      reason: step.reason,
      at: this.deps.now(),
      ...step.kind === 'resume'
        ? {
          message: boundHead(
            step.message,
            this.deps.config.limits.summaryMaxBytes,
          ),
        }
        : {},
    };
    this.snapshot = {
      ...this.snapshot,
      decisions: [...this.snapshot.decisions, decision],
      directions: this.deps.directions.all(this.request.id),
    };
    this.publish();
  }

  /** Settle the delegation on the last round's facts. */
  private settle(end: RunEnd | undefined, status?: DelegationStatus): void {
    if (this.snapshot.finishedAt !== undefined) return;
    const settled = end ?? {
      status: 'failed' as const,
      summary: '',
      error: 'the delegation spent no round',
      durationMs: this.deps.now() - this.snapshot.startedAt,
    };
    const { question: _pending, ...rest } = this.snapshot;
    this.snapshot = {
      ...rest,
      status: status ?? settled.status,
      end: settled,
      finishedAt: this.deps.now(),
      directions: this.deps.directions.all(this.request.id),
    };
    this.publish();
  }

  /**
   * Add one round's usage to the delegation's total.
   * @param usage - the round's figures, absent when the delegate reported none.
   */
  private charge(usage: RunUsage | undefined): void {
    if (usage === undefined) return;
    const total = this.snapshot.usage;
    this.snapshot = {
      ...this.snapshot,
      usage: total === undefined ? usage : {
        ...sum('inputTokens', total, usage),
        ...sum('cachedInputTokens', total, usage),
        ...sum('outputTokens', total, usage),
        ...sum('costUsd', total, usage),
      },
    };
  }

  /** Record the workspace's merge state, once the batch has merged it. */
  mergeReported(workspace: WorkspaceState): void {
    this.snapshot = { ...this.snapshot, workspace };
    this.publish();
  }

  /** The last round's outcome, if any round settled. */
  private lastEnd(): RunEnd | undefined {
    const last = this.snapshot.rounds.at(-1);
    return last === undefined
      ? undefined
      : this.deps.runs.endOf(last, this.request.sessionId);
  }

  /** Collect the files the delegate reported touching, for a review's evidence. */
  private watchFiles(): () => void {
    const { dispose } = this.deps.hub.subscribe((frame) => {
      if (frame.kind !== 'activity') return;
      if (!this.snapshot.rounds.includes(frame.stream)) return;
      const activity: Activity = frame.activity;
      if (activity.type === 'file') this.files.add(activity.path);
    });
    return dispose;
  }

  /** Publish a notice on the delegation's own stream. */
  private note(level: 'info' | 'warn' | 'error', text: string): void {
    this.deps.hub.publish(this.request.id, {
      kind: 'activity',
      activity: { type: 'notice', level, text },
    });
  }

  /** Announce the current snapshot on the delegation's own stream. */
  private publish(): void {
    this.deps.hub.publish(this.request.id, {
      kind: 'delegation',
      delegation: this.snapshot,
    });
  }
}

/**
 * One usage field, added across two rounds.
 *
 * A field neither round reported stays absent rather than becoming a zero the
 * delegate never claimed.
 * @param key - the field.
 * @param left - the running total.
 * @param right - the new round.
 * @returns a one-key fragment, or nothing.
 */
function sum(
  key: keyof RunUsage,
  left: RunUsage,
  right: RunUsage,
): Partial<RunUsage> {
  const total = (left[key] ?? 0) + (right[key] ?? 0);
  return left[key] === undefined && right[key] === undefined
    ? {}
    : { [key]: total };
}
