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
  AutonomyReport,
  BatchId,
  CliId,
  DecisionRecord,
  DelegationId,
  DelegationNote,
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
import { AMBIENT_ACCOUNT_ID, bareAccountId } from './accounts.ts';
import {
  type AdviceTarget,
  adviceTarget,
  type AdvisorPort,
} from './advisor.ts';
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
  /** Wall-clock budget for one run; omitted uses the deployment default. */
  readonly timeoutMs?: number;
  /**
   * The delegate's own session identity to resume, when a continuation cannot
   * resume by run id (the run was trimmed by retention). Mutually exclusive in
   * practice with {@link resumeFrom}.
   */
  readonly resumeSession?: string;
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
  /**
   * The composition's default model route, read fresh on every decision.
   *
   * Without it a session that never named a model — the ordinary case — leaves
   * a consultation with no route to run on, and every autonomy switch decays
   * into asking the human.
   */
  readonly defaultRoute?: () =>
    | { readonly provider?: string; readonly model?: string }
    | undefined;
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
      // The id is stored CANONICAL, not as the caller spelled it. A caller may
      // name an account the way the listing prints it — `claude/personal` — and
      // recording that verbatim made every surface read `claude/claude/personal`
      // once it prefixed the delegate again.
      account: request.account === undefined
        ? AMBIENT_ACCOUNT_ID
        : bareAccountId(request.cli, request.account),
      permission: request.permission,
      status: 'running',
      rounds: [],
      workspace: request.workspace,
      directions: [],
      decisions: [],
      notes: [],
      startedAt: deps.now(),
      ...request.parent === undefined ? {} : { parent: request.parent },
      ...request.model === undefined ? {} : { model: request.model },
      ...request.effort === undefined ? {} : { effort: request.effort },
      ...request.sessionId === undefined
        ? {}
        : { sessionId: request.sessionId },
      ...request.callId === undefined ? {} : { callId: request.callId },
      ...request.timeoutMs === undefined
        ? {}
        : { timeoutMs: request.timeoutMs },
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
    this.preflight();
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
        // A cancellation landing while the decision was being made must not be
        // recorded as the decision it interrupted: the conservative reading of
        // an aborted consultation is a verdict nobody gave ("accepted"), and an
        // aborted question still looks answerable. Cancelled is what happened.
        if (!signal.aborted) this.record(round, step);
        if (step.kind !== 'resume') {
          this.settle(
            end,
            signal.aborted
              ? 'cancelled'
              : step.kind === 'ask'
              ? 'needs_direction'
              : undefined,
          );
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
   * Say, before the first round, whether autonomy can actually act.
   *
   * This is the difference between autonomy that "sometimes works" and autonomy
   * a person can reason about. Every switch needs two things the switch itself
   * cannot provide — a model service in the composition, and a route to name on
   * it — and when either is missing the delegation still runs, still asks the
   * human, and still finishes, so nothing about the outcome reveals that the
   * setting was inert. Said once, at the start, on the record, and in the result.
   */
  private preflight(): void {
    const autonomy = this.autonomy;
    const on = (['decide', 'continue', 'review'] as const).filter((name) =>
      autonomy[name]
    );
    if (on.length === 0) return;
    const switches = on.map((name) => `autonomy.${name}`).join(', ');
    if (this.deps.advisor === undefined) {
      this.note(
        'warn',
        `${switches} is on, but this deployment has no model service to consult, so nothing can be decided automatically: a delegate's question goes to the user and the work stops when the delegate says it is done.`,
      );
      return;
    }
    const target = this.target();
    if (target === undefined) {
      this.note(
        'warn',
        `${switches} is on, but no model route could be resolved, so nothing can be decided automatically: a delegate's question goes to the user and the work stops when the delegate says it is done. Set autonomy.advisor.provider and autonomy.advisor.model to name the route.`,
      );
      return;
    }
    this.note(
      'info',
      `${switches} is on and decisions will be put to ${target.provider}/${target.model}.`,
    );
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
          ...this.request.timeoutMs === undefined
            ? {}
            : { timeoutMs: this.request.timeoutMs },
          ...this.request.resumeSession === undefined
            ? {}
            : { resume: this.request.resumeSession },
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
        const end = await started.settled;
        this.captureSession(started.snapshot.id);
        return end;
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
        if (answered === undefined) {
          // An unanswered QUESTION settles as needs_direction; an unanswered
          // CONSULT is the one outcome that must not pass through — the policy
          // chose the model because a route existed, and the route is read live,
          // so between that choice and the request it can have vanished. Settling
          // here would report the round as if nothing was ever due to be decided.
          // Re-deriving asks the policy again with fresh facts: it either finds
          // the route back (a flap), or falls back to whoever else can act.
          if (step.kind === 'consult') {
            step = nextStep(this.facts(round, end));
            continue;
          }
          return step;
        }
        // A review counts once its verdict is actually used. Counting it at the
        // consultation site instead counted reviews that never happened — one
        // interrupted by a user direction — and with the slot gone, the next
        // completed round silently skipped the review it was owed.
        if (step.kind === 'consult' && step.topic === 'review') {
          this.reviews += 1;
        }
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
    const target = this.target();
    if (advisor === undefined || target === undefined) {
      // The policy would not have raised this consultation without a route, and
      // the route is resolved live, so reaching here means it was lost between
      // the decision and the request. Saying so is what makes the next step
      // explainable: the caller re-derives it, and the fallback it lands on is
      // a change of decider, which a record must be able to show was deliberate.
      this.note(
        'warn',
        advisor === undefined
          ? `autonomy.${topic}: the session model was not consulted because this deployment has no model service, so nothing could be decided automatically.`
          : `autonomy.${topic}: no model route could be resolved when the decision was due, so the session model was not consulted. Set autonomy.advisor.provider and autonomy.advisor.model to name the route.`,
      );
      return undefined;
    }

    const evidence = topic === 'review'
      ? await this.evidence(signal)
      : undefined;
    const request = adviceRequest(topic, {
      task: this.request.task,
      directions: this.deps.directions.all(this.request.id).map((record) =>
        record.text
      ),
      summary: end.summary,
      ...this.autonomy.advisor.evidenceMaxBytes === undefined
        ? {}
        : { maxBytes: this.autonomy.advisor.evidenceMaxBytes },
      ...end.question === undefined ? {} : { question: end.question },
      ...evidence === undefined ? {} : { evidence },
    });

    try {
      const reply = await advisor.consult(request, target, signal);
      // The round counts as judged only once the consultation actually ran: an
      // interrupted one (a direction arriving) must not mark it, because the
      // re-derivation that follows is a fresh look at the same round.
      if (topic === 'continue') this.continueJudged = true;
      // An empty answer is the one outcome nobody can interpret from the
      // outside: the delegation just stops, looking as if DeepSeek shrugged. Say
      // why — and name a remedy only when there is one to name, because the
      // plugin imposes no output budget of its own. An answer that is empty
      // because the consultation was INTERRUPTED is a different fact entirely —
      // the interrupt itself is recorded as the decision that followed — so no
      // note claims the model failed when it was never given the chance.
      if (reply.text.trim().length === 0 && !signal.aborted) {
        const cap = this.autonomy.advisor.maxTokens;
        this.note(
          'warn',
          reply.finish === 'max-tokens' && cap !== undefined
            ? `autonomy.${topic}: ${target.provider}/${target.model} spent the configured output budget of ${
              String(cap)
            } tokens without answering — raise or remove autonomy.advisor.maxTokens (a reasoning model spends it thinking first)`
            : reply.finish === 'timeout'
            ? `autonomy.${topic}: ${target.provider}/${target.model} said nothing for the whole autonomy.advisor.timeoutMs of ${
              String(this.autonomy.advisor.timeoutMs)
            }ms and the consultation was cut off — raise autonomy.advisor.timeoutMs if the arbiter needs longer to think`
            : `autonomy.${topic}: ${target.provider}/${target.model} returned no answer${
              reply.finish === undefined ? '' : ` (stopped: ${reply.finish})`
            }`,
        );
      }
      const advice = parseAdvice(topic, reply.text);
      // A reply that was not the asked-for JSON is read CONSERVATIVELY —
      // finished, accepted — and that is the right reading, but it is also
      // indistinguishable from an arbiter that genuinely approved the work. Say
      // which one happened; a review that quietly never reviewed anything is the
      // hardest autonomy failure to spot from the outside.
      if (advice.malformed === true && reply.text.trim().length > 0) {
        this.note(
          'warn',
          `autonomy.${topic}: ${target.provider}/${target.model} answered with something other than the requested JSON, so the reply was read as "no change needed" — ${
            oneLineLabel(reply.text, 200)
          }`,
        );
      }
      return applyAdvice(advice, this.facts(round, end));
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

  /**
   * What the delegation produced, for a review.
   *
   * The supplied evidence is gathered outside this loop — a `git diff --stat`
   * against the base — and cannot be cancelled from in here. Racing it against
   * the signal keeps the review path responsive: a user direction or a
   * cancellation ends the wait, and the aborted consultation that follows is
   * settled by the caller exactly as any other interrupted consultation is.
   */
  private async evidence(signal: AbortSignal): Promise<Evidence> {
    const files = [...this.files].toSorted();
    const supplied = this.deps.evidence === undefined
      ? undefined
      : await Promise.race([
        this.deps.evidence().catch(() => undefined),
        new Promise<undefined>((resolve) => {
          signal.addEventListener('abort', () => resolve(undefined), {
            once: true,
          });
        }),
      ]);
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
      canAdvise: this.deps.advisor !== undefined && this.target() !== undefined,
      ...pending === undefined ? {} : { pendingDirection: pending },
    };
  }

  /**
   * The route this delegation's decisions would run on right now.
   *
   * Resolved fresh on every read rather than captured: the composition's default
   * route is read live, and a person may pick a model while the delegation is
   * already spending rounds.
   * @returns the route, or `undefined` when none can be named.
   */
  private target(): AdviceTarget | undefined {
    return adviceTarget(
      this.autonomy.advisor,
      this.request.agent?.options,
      this.deps.defaultRoute?.(),
    );
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
    // A stop that landed before any round could run is a cancellation, not a
    // failure: reporting "failed: the delegation spent no round" told the
    // caller to fix a cause that does not exist and call again, when the one
    // correct response to a cancellation is to stop and not retry.
    const settled = end ?? {
      status: status === 'cancelled' ? 'cancelled' : 'failed',
      summary: '',
      ...status === 'cancelled'
        ? {}
        : { error: 'the delegation spent no round' },
      durationMs: this.deps.now() - this.snapshot.startedAt,
    };
    const { question: _pending, ...rest } = this.snapshot;
    this.snapshot = {
      ...rest,
      status: status ?? settled.status,
      end: settled,
      finishedAt: this.deps.now(),
      directions: this.deps.directions.all(this.request.id),
      autonomy: this.report(),
    };
    this.publish();
  }

  /**
   * What autonomy was in force as the delegation ended.
   *
   * Reported with the outcome rather than left implicit, so a caller reading a
   * delegation that behaved unexpectedly can see the three switches and the
   * route in the same place as the result — instead of inferring them from
   * whether it was asked a question.
   * @returns the switches, and the route decisions ran on when there was one.
   */
  private report(): AutonomyReport {
    const autonomy = this.autonomy;
    const target = this.deps.advisor === undefined ? undefined : this.target();
    return {
      decide: autonomy.decide,
      continue: autonomy.continue,
      review: autonomy.review,
      ...target === undefined ? {} : { advisor: target },
    };
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

  /**
   * Copy a settled round's delegate session onto the delegation snapshot.
   *
   * The session id is bound onto the RUN only once the delegate's stream has
   * started, so it is read back from the registry after the round settles
   * rather than from the snapshot the start call returned. Carrying it on the
   * delegation — not just the run — is what lets a continuation resume the
   * session even after the run itself has been trimmed by retention.
   * @param run - the round's run id.
   */
  private captureSession(run: RunId): void {
    let session: string | undefined;
    try {
      session = this.deps.runs.get(run, this.request.sessionId)
        .delegateSessionId;
    } catch {
      return;
    }
    if (session === undefined || session === this.snapshot.delegateSessionId) {
      return;
    }
    this.snapshot = { ...this.snapshot, delegateSessionId: session };
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

  /**
   * Record one thing that happened around the rounds, and announce it.
   *
   * Both halves matter. The stream is what a person watching sees as it
   * happens; the snapshot is what the CALLER is handed afterwards, and a warning
   * that only ever reached the browser is a warning the model deciding what to do
   * next never saw.
   * @param level - how much it matters.
   * @param text - one self-contained sentence.
   */
  private note(level: DelegationNote['level'], text: string): void {
    const note: DelegationNote = { level, text, at: this.deps.now() };
    this.snapshot = {
      ...this.snapshot,
      notes: [...this.snapshot.notes, note],
    };
    this.deps.hub.publish(this.request.id, {
      kind: 'activity',
      activity: { type: 'notice', level, text },
    });
    this.publish();
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
