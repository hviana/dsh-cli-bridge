/**
 * The Host → Web wire contract.
 *
 * This module is the single source of the vocabulary both halves speak, and it
 * is deliberately the only code they share. It carries no logic and no runtime
 * dependency, so the browser bundle and the Node plugin can never drift on the
 * shape of a frame.
 *
 * The channel exists so that delegate output reaches a human EYE without
 * reaching the DeepSeek CONTEXT. Nothing published here is ever appended to the
 * session log or handed to a model request: the model's whole view of a run is
 * the tool result described in `../domain/outcome.ts`.
 *
 * @module dsh-cli-bridge/shared/protocol
 */

/** The delegate command-line agents this plugin drives. */
export type CliId = 'claude' | 'codex';

/** Every delegate CLI, in the order surfaces list them. */
export const CLI_IDS: readonly CliId[] = ['claude', 'codex'];

/**
 * The DeepSeek Harness permission mode a run inherits, verbatim from
 * `ctx.sandboxPolicy`. The plugin owns no permission model of its own: this one
 * value decides what the delegate may do, and each adapter maps it onto that
 * CLI's own coarse flags.
 */
export type PermissionMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access';

/** Reasoning-effort levels, the intersection both CLIs accept. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Every effort level, in ascending order. */
export const EFFORT_LEVELS: readonly EffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** Registry-issued run identity, `<cli>-<n>`. */
export type RunId = string;

/** What a run was started for. */
export type RunKind =
  /** A delegated coding task. */
  | 'task'
  /** An interactive authentication flow that owns a terminal. */
  | 'login';

/**
 * Lifecycle of one run. The four terminal states are exactly the states the
 * model is told about, and every one of them ends the tool call — a delegate
 * that finishes, fails, is cancelled, or asks for direction all return control
 * to DeepSeek with a summary and nothing else.
 */
export type RunStatus = 'starting' | 'running' | TerminalRunStatus;

/**
 * How a run ended. Separate from {@link RunStatus} because a settled run can
 * never be `starting`, and the type system should say so wherever a settlement
 * is handled.
 */
export type TerminalRunStatus =
  | 'completed'
  | 'needs_direction'
  | 'failed'
  | 'cancelled';

/**
 * Whether a status is terminal.
 * @param status - the status to test.
 * @returns true when the run has settled, narrowing the status accordingly.
 */
export function isTerminalStatus(
  status: RunStatus,
): status is TerminalRunStatus {
  return status !== 'starting' && status !== 'running';
}

/** One of the child's standard output streams. */
export type OutputPipe = 'stdout' | 'stderr';

/** Token and cost facts the delegate CLI reported for itself. */
export interface RunUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

/** A run as every surface lists it: no output, no prompt text, no secrets. */
export interface RunSnapshot {
  readonly id: RunId;
  readonly cli: CliId;
  readonly kind: RunKind;
  /** Account id the run authenticates as. */
  readonly account: string;
  /** One-line human label — the first line of the prompt, or the login verb. */
  readonly label: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  readonly permission: PermissionMode;
  readonly cwd: string;
  readonly status: RunStatus;
  /** Epoch ms at registration. */
  readonly startedAt: number;
  /** Epoch ms at settlement; absent while live. */
  readonly finishedAt?: number;
  /** Bytes streamed on the channel so far — the size the model never sees. */
  readonly bytes: number;
  /** Whether the run accepts keystrokes (a terminal-backed login). */
  readonly interactive: boolean;
  /** Owning DeepSeek Harness session, when the run was started by an agent. */
  readonly sessionId?: string;
  /**
   * The tool call that started this run, when one did.
   *
   * This is how a tool card finds its own run: the card knows its call id from
   * the moment it renders, while the run id is issued later, inside `execute`.
   */
  readonly callId?: string;
  /** Delegate-side session identity, once known, for resuming the run. */
  readonly delegateSessionId?: string;
  readonly usage?: RunUsage;
}

/**
 * One decoded delegate action, normalized across CLIs.
 *
 * Both delegates emit their own JSON event stream; this union is what those
 * streams project onto, so the browser renders one vocabulary instead of two
 * and a third delegate would add an adapter rather than a view.
 */
export type Activity =
  /** Assistant prose addressed to the caller. */
  | { readonly type: 'message'; readonly text: string }
  /** Visible reasoning summary, when the delegate emits one. */
  | { readonly type: 'reasoning'; readonly text: string }
  /** A tool or command the delegate ran. */
  | {
    readonly type: 'tool';
    readonly name: string;
    readonly detail?: string;
    readonly status: 'started' | 'completed' | 'failed';
    readonly exitCode?: number;
  }
  /** A file the delegate created, changed, or removed. */
  | {
    readonly type: 'file';
    readonly path: string;
    readonly change: 'add' | 'update' | 'delete';
  }
  /** Accumulated token and cost facts. */
  | { readonly type: 'usage'; readonly usage: RunUsage }
  /** Anything the delegate reported that is not one of the above. */
  | {
    readonly type: 'notice';
    readonly level: 'info' | 'warn' | 'error';
    readonly text: string;
  };

/** How a run ended, as the channel announces it (the same facts the model receives). */
export interface RunEnd {
  readonly status: TerminalRunStatus;
  /** Final assistant message, already bounded. */
  readonly summary: string;
  /** The direction the delegate asked for; present exactly when status is `needs_direction`. */
  readonly question?: string;
  /** Failure detail; present on `failed`. */
  readonly error?: string;
  /**
   * Work the delegate declared still remaining, from its `NEXT_STEPS:` line.
   *
   * Present only when the run was told to state it — the contract asks for the
   * marker exactly when something is allowed to act on it.
   */
  readonly nextSteps?: string;
  readonly exitCode?: number;
  readonly durationMs: number;
  readonly usage?: RunUsage;
}

/**
 * Key of one stream on the channel.
 *
 * A stream is whatever has output worth watching: one delegate run, one
 * delegation across its rounds, or one synthetic installer. Sequence numbers are
 * per stream, so a reconnect resumes exactly one of them.
 */
export type StreamKey = string;

/** Common head of every frame: monotonic per stream, so a reconnect resumes exactly. */
interface FrameHead {
  /** Per-stream sequence number starting at 1. */
  readonly seq: number;
  /** Epoch ms the frame was produced. */
  readonly at: number;
  readonly stream: StreamKey;
}

/** One frame on the Host → Web channel. */
export type StreamFrame =
  /** The run's current listing state; sent first on subscribe and on every transition. */
  | (FrameHead & { readonly kind: 'snapshot'; readonly snapshot: RunSnapshot })
  /**
   * Raw delegate output, verbatim, for the terminal view.
   *
   * `pipe` names the child's standard stream. It is deliberately not called
   * `stream`: that word belongs to the channel key in the frame head.
   */
  | (FrameHead & {
    readonly kind: 'output';
    readonly pipe: OutputPipe;
    readonly text: string;
  })
  /** A decoded delegate action. */
  | (FrameHead & { readonly kind: 'activity'; readonly activity: Activity })
  /** Settlement of one run. No further run frames follow it. */
  | (FrameHead & { readonly kind: 'end'; readonly end: RunEnd })
  /**
   * The delegation's current state, on its own stream.
   *
   * A delegation spans several runs, so its rounds, directions, decisions and
   * workspace are announced separately from any one run's output.
   */
  | (FrameHead & {
    readonly kind: 'delegation';
    readonly delegation: DelegationSnapshot;
  });

/* ── Delegations ─────────────────────────────────────────────────────────── */

/** Registry-issued delegation identity, `d<n>`. */
export type DelegationId = string;

/** Registry-issued batch identity, `b<n>`. */
export type BatchId = string;

/**
 * Who decided what a delegation does after a round.
 *
 * Recorded on every decision so autonomy is inspectable rather than magic: a
 * reader can always see whether a resume came from the human, from the model,
 * or from a rule.
 */
export type DecisionSource =
  /** A standing instruction the human had already given. */
  | 'direction'
  /** The human answered the delegate's question. */
  | 'human'
  /** The session's model decided, under an autonomy setting. */
  | 'advisor'
  /** A deterministic rule, with nobody consulted. */
  | 'policy';

/** What happens to a delegation after one round. */
export type ContinuationKind =
  /** Send the delegate another message and run again. */
  | 'resume'
  /** Put the delegate's question to the human and wait. */
  | 'ask'
  /** Consult the session's model. */
  | 'consult'
  /** Stop, and report to the caller. */
  | 'finish';

/** One recorded decision between rounds. */
export interface DecisionRecord {
  /** The round the decision followed, 1-based. */
  readonly round: number;
  readonly source: DecisionSource;
  readonly kind: ContinuationKind;
  /** One line on why, in the vocabulary of the policy that produced it. */
  readonly reason: string;
  /** What was sent to the delegate, bounded; absent unless the decision resumed it. */
  readonly message?: string;
  readonly at: number;
}

/** A standing instruction for one delegation. */
export interface DirectionRecord {
  readonly id: string;
  /** Who supplied it. A user direction outranks every automatic decision. */
  readonly origin: 'user' | 'model';
  readonly text: string;
  readonly at: number;
  /** Round that consumed it as a delegate message; absent while pending. */
  readonly consumedRound?: number;
}

/** A delegate question waiting on the human. */
export interface PendingQuestion {
  readonly run: RunId;
  readonly question: string;
  /** Everything the delegate reported before asking, bounded. */
  readonly context: string;
  readonly askedAt: number;
}

/** What happened to a merge. */
export type MergeState =
  /** The delegation ran in the session workspace; there is nothing to merge. */
  | 'not-required'
  /** Waiting its turn in the merge queue. */
  | 'pending'
  | 'merged'
  /** The merge stopped on a conflict; the branch and worktree were kept. */
  | 'conflict'
  /** The merge could not be attempted; the branch and worktree were kept. */
  | 'failed'
  /** Merging was switched off, or the delegation produced nothing to merge. */
  | 'skipped';

/** Where a delegation's work happened, and what became of it. */
export interface WorkspaceState {
  /** `inline` shares the session workspace; `worktree` is an isolated checkout. */
  readonly mode: 'inline' | 'worktree';
  /** Absolute working directory the delegate ran in. */
  readonly path: string;
  /** Branch the worktree was created on. */
  readonly branch?: string;
  /** Branch the work merges back into — whatever was checked out when the batch started. */
  readonly base?: string;
  /**
   * The session workspace this one was cut from.
   *
   * Present only for a worktree, and load-bearing for a continuation: the
   * worktree is removed when the delegation ends, so carrying the work on means
   * starting from the repository it came from, not from a path that no longer
   * exists.
   */
  readonly origin?: string;
  readonly merge: MergeState;
  /** Commit the delegation produced, once its work was committed. */
  readonly commit?: string;
  /** Why a merge conflicted or failed, and what was left behind for the human. */
  readonly detail?: string;
}

/** Lifecycle of a delegation, which spans one or more runs. */
export type DelegationStatus = 'running' | 'awaiting-human' | TerminalRunStatus;

/** One delegation as every surface lists it. */
export interface DelegationSnapshot {
  readonly id: DelegationId;
  readonly batch: BatchId;
  /** The delegation this one continues, when a caller replied to a settled one. */
  readonly parent?: DelegationId;
  /** One-line human label — the first line of the original task. */
  readonly label: string;
  readonly cli: CliId;
  readonly account: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  /** The harness permission mode every round inherited. */
  readonly permission: PermissionMode;
  readonly status: DelegationStatus;
  /** Runs this delegation has spent, in round order. */
  readonly rounds: readonly RunId[];
  readonly workspace: WorkspaceState;
  readonly directions: readonly DirectionRecord[];
  readonly decisions: readonly DecisionRecord[];
  /** The question currently waiting on the human; absent otherwise. */
  readonly question?: PendingQuestion;
  /** Terminal facts, once it has settled. */
  readonly end?: RunEnd;
  /**
   * What every round of this delegation cost, added up.
   *
   * A delegation is billed per round, so the last round's figure would understate
   * a delegation that spent five. Absent when no round reported usage.
   */
  readonly usage?: RunUsage;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly sessionId?: string;
  /** The tool call that started this delegation, so its card can find it. */
  readonly callId?: string;
}

/** An installed (or missing) delegate CLI, as the panel reports it. */
export interface ToolchainStatus {
  readonly cli: CliId;
  /** Resolved executable path, absent when the CLI is not installed. */
  readonly path?: string;
  /** Version string the CLI reported, absent when unknown. */
  readonly version?: string;
  /** Where the executable came from. */
  readonly source: 'managed' | 'path' | 'configured' | 'missing';
  /** Epoch ms of the last successful install or update. */
  readonly updatedAt?: number;
}

/** How an account authenticates. */
export type AccountAuth =
  /** The CLI's own subscription or OAuth login, stored in the account's private home. */
  | 'session'
  /** An API key resolved from the DeepSeek Harness credential store at spawn time. */
  | 'api-key'
  /**
   * A custom Anthropic-compatible endpoint — DeepSeek, OpenRouter, any provider
   * that speaks Claude Code's protocol — reached by a base URL, a token resolved
   * from the credential store, and an optional default model.
   */
  | 'endpoint';

/** One delegate account: an isolated CLI home plus how it authenticates. */
export interface AccountSnapshot {
  readonly id: string;
  readonly cli: CliId;
  readonly label: string;
  readonly auth: AccountAuth;
  /** Credential reference supplying the key or token; present for `api-key` and `endpoint` accounts. */
  readonly credentialRef?: string;
  /** Whether the credential reference currently resolves. Never the value. */
  readonly credentialConfigured?: boolean;
  /** Endpoint an `endpoint` account reaches. */
  readonly baseUrl?: string;
  /** Default model an `endpoint` account uses when a call names none. */
  readonly model?: string;
  /** Absolute path of the account's private CLI home. */
  readonly home: string;
  /** Whether this account is the default for its CLI. */
  readonly isDefault: boolean;
  readonly createdAt: number;
  /** Epoch ms of the last run started under this account. */
  readonly lastUsedAt?: number;
}

/** Everything a panel needs in one read. */
export interface BridgeState {
  readonly runs: readonly RunSnapshot[];
  readonly delegations: readonly DelegationSnapshot[];
  readonly accounts: readonly AccountSnapshot[];
  readonly toolchain: readonly ToolchainStatus[];
  /** Which of DeepSeek's automatic decisions the user has switched on. */
  readonly autonomy: AutonomySwitches;
}

/**
 * The three things DeepSeek may do on its own between a delegation's rounds.
 *
 * All three are off until a person turns them on. With them off, a delegate's
 * question goes to the human and a delegation ends when its delegate says it is
 * done — which is the behaviour that never spends a token the user did not ask
 * for.
 */
export interface AutonomySwitches {
  /** Answer a delegate's question instead of putting it to the human. */
  readonly decide: boolean;
  /** Judge a declared next step and tell the delegate to carry on. */
  readonly continue: boolean;
  /** Review the finished work against the task and the directions. */
  readonly review: boolean;
}

/**
 * Panel → Host control operations. The browser never reaches a CLI or the
 * filesystem itself: it names an operation, and the host runs the same code
 * path the model-facing tools and the `/cli` commands run.
 */
export type ControlRequest =
  | {
    readonly op: 'account.add';
    readonly cli: CliId;
    /** Account id; absent means the host mints one, so a person never types it. */
    readonly id?: string;
    readonly label?: string;
    readonly auth: AccountAuth;
    readonly credentialRef?: string;
    readonly baseUrl?: string;
    readonly model?: string;
  }
  | { readonly op: 'account.remove'; readonly cli: CliId; readonly id: string }
  | { readonly op: 'account.default'; readonly cli: CliId; readonly id: string }
  | { readonly op: 'account.login'; readonly cli: CliId; readonly id: string }
  | { readonly op: 'toolchain.install'; readonly cli: CliId }
  | { readonly op: 'toolchain.update'; readonly cli: CliId }
  | { readonly op: 'run.cancel'; readonly run: RunId; readonly reason?: string }
  | { readonly op: 'run.input'; readonly run: RunId; readonly data: string }
  /**
   * Add a standing instruction to a live delegation.
   *
   * This is the override: a user direction is consumed before any automatic
   * decision, and its arrival cancels a decision already in flight — including
   * a question the human is being asked.
   */
  | {
    readonly op: 'delegation.direct';
    readonly delegation: DelegationId;
    readonly text: string;
  }
  /** Stop a delegation and every round it would still have spent. */
  | { readonly op: 'delegation.cancel'; readonly delegation: DelegationId }
  /**
   * Switch one of the automatic decisions on or off for this process.
   *
   * Only a person issues this: the model is never allowed to grant itself the
   * autonomy the user withheld. It takes effect at the next decision, including
   * for delegations already running.
   */
  | {
    readonly op: 'autonomy.set';
    readonly switch: keyof AutonomySwitches;
    readonly on: boolean;
  };

/** Uniform control reply: the refreshed state, or a message the panel shows verbatim. */
export type ControlResponse =
  | {
    readonly ok: true;
    readonly state: BridgeState;
    readonly run?: RunId;
    readonly delegation?: DelegationId;
  }
  | { readonly ok: false; readonly error: string };

/** Route names under the channel's configured base path. */
export const CHANNEL_ROUTES = {
  /** `GET` — Server-Sent Events; `?stream=<key>` scopes it, `?from=<seq>` resumes it. */
  events: 'events',
  /** `GET` — one {@link BridgeState} snapshot as JSON. */
  state: 'state',
  /** `POST` — one {@link ControlRequest}, answered with a {@link ControlResponse}. */
  control: 'control',
} as const;

/** Query parameter selecting a single stream on the events route. */
export const STREAM_QUERY_PARAM = 'stream';

/** Query parameter resuming the events route after a known sequence number. */
export const FROM_QUERY_PARAM = 'from';

/** Default base path the channel mounts under. */
export const DEFAULT_BASE_PATH = '/dsh-cli-bridge';
