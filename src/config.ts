/**
 * Plugin configuration.
 *
 * Every value two deployments could reasonably want to set differently is a
 * field here — the harness's own rule for plugin authors. Nothing in the
 * runtime reads a literal that is not either a protocol constant or one of
 * these fields.
 *
 * An empty string means "not configured" for the few fields whose real default
 * can only be computed at load time (a path derived from the harness home, a
 * model the delegate CLI itself chooses). That keeps every field present and
 * typed rather than scattering optionality through the runtime.
 *
 * @module dsh-cli-bridge/config
 */
import Schema from '@deepseek-ai/schemastery';
import type { CliId, EffortLevel } from './shared/protocol.ts';
import {
  CLI_IDS,
  DEFAULT_BASE_PATH,
  EFFORT_LEVELS,
} from './shared/protocol.ts';
import {
  DEFAULT_DIRECTION_MARKER,
  DEFAULT_NEXT_STEPS_MARKER,
} from './domain/markers.ts';

/** Per-delegate settings. */
export interface DelegateConfig {
  /** Model id or alias used when a call does not name one; empty means the CLI's own default. */
  readonly defaultModel: string;
  /** Effort used when a call does not name one; empty means the CLI's own default. */
  readonly defaultEffort: EffortLevel | '';
  /** Absolute executable path, overriding both the managed prefix and `PATH`. */
  readonly executable: string;
  /** Arguments appended verbatim to every task run of this delegate. */
  readonly extraArgs: readonly string[];
}

/** How the delegate CLIs are obtained and kept current. */
export interface ToolchainConfig {
  /**
   * `managed` installs each CLI into a private prefix under the state directory
   * and prefers it; `path` uses whatever is already installed and never writes;
   * `disabled` refuses to install and reports a missing CLI as an error.
   */
  readonly mode: 'managed' | 'path' | 'disabled';
  /** Install a missing CLI on first use instead of failing the call. */
  readonly autoInstall: boolean;
  /** Milliseconds between update checks; `0` disables background update checks. */
  readonly updateIntervalMs: number;
  /** npm executable used by the managed installer. */
  readonly npmCommand: string;
  /** Registry passed to npm; empty uses the machine's configured registry. */
  readonly registry: string;
  /** Milliseconds an install or update may take before it is terminated. */
  readonly installTimeoutMs: number;
}

/** The Host → Web streaming channel. */
export interface ChannelConfig {
  /** Whether to mount the channel at all; a headless profile can turn it off. */
  readonly enabled: boolean;
  /** Absolute base path the channel's routes mount under. */
  readonly basePath: string;
  /** Bytes retained per stream so a late subscriber sees recent context. */
  readonly bufferBytesPerStream: number;
  /**
   * Non-loopback authorities allowed to reach the channel, as `host` or
   * `host:port`. The channel is same-origin with the harness web UI, so the
   * default empty list pins it to loopback exactly like the harness `/api` fence.
   */
  readonly trustedHosts: readonly string[];
}

/**
 * What the session's model may decide on its own.
 *
 * Every one of these is OFF by default, and that default is the product
 * decision, not a safety hedge: with autonomy off a delegate's question goes to
 * the human, and a finished delegate returns to the caller. Turning one on
 * spends a small, bounded model request at a decision point — never a turn, and
 * never the delegate's output.
 */
export interface AutonomyConfig {
  /** Answer the delegate's questions instead of asking the human. */
  readonly decide: boolean;
  /** Push the delegate through work it declared still remaining. */
  readonly continue: boolean;
  /** Review the finished work against the task and the directions, and request fixes. */
  readonly review: boolean;
  /** Hard bound on the rounds one delegation may spend, whatever the deciders say. */
  readonly maxRounds: number;
  /** How many fixes one review cycle may request before the delegation reports anyway. */
  readonly maxReviews: number;
  readonly advisor: AdvisorConfig;
}

/** The bounded model request behind every autonomous decision. */
export interface AdvisorConfig {
  /** Provider route; empty uses the calling session's own. */
  readonly provider: string;
  /** Model id; empty uses the calling session's own. */
  readonly model: string;
  /** Output cap for one decision. A decision is a sentence, not an essay. */
  readonly maxTokens: number;
  /** Wall-clock bound for one decision. */
  readonly timeoutMs: number;
  /** Bytes of evidence — summary, files, diffstat — handed to a review. */
  readonly evidenceMaxBytes: number;
}

/** How a delegation's work is isolated from the session workspace, and merged back. */
export interface IsolationConfig {
  /**
   * `auto` gives a delegation its own git worktree exactly when it could
   * collide with another one; `worktree` always does; `inline` never does and
   * runs in the session workspace.
   */
  readonly mode: 'auto' | 'worktree' | 'inline';
  /** Whether a finished worktree is committed and merged back automatically. */
  readonly merge: 'auto' | 'never';
  /** Branch-name prefix for the branches worktrees are created on. */
  readonly branchPrefix: string;
  /** Keep the branch and worktree when a merge conflicts, rather than unwinding them. */
  readonly keepOnConflict: boolean;
  /** Wall-clock bound for one git command. */
  readonly gitTimeoutMs: number;
}

/** How the human is asked when autonomy is off. */
export interface InquiryConfig {
  /** Whether to ask the human at all; off returns the question to the caller instead. */
  readonly enabled: boolean;
  /**
   * How long a question may wait, in milliseconds. `0` waits indefinitely —
   * the tool call is open anyway, and nothing is being billed while it waits.
   */
  readonly timeoutMs: number;
}

/** Bounds that keep a delegated run cheap for the caller. */
export interface LimitsConfig {
  /** Byte budget for the summary handed to the model. */
  readonly summaryMaxBytes: number;
  /** Byte budget for an error handed to the model. */
  readonly errorMaxBytes: number;
  /** Bytes of stderr retained to explain a failure. */
  readonly stderrTailBytes: number;
  /** Default wall-clock budget for one run; `0` means no deadline. */
  readonly runTimeoutMs: number;
  /** Runs that may execute at once across all delegates. */
  readonly maxConcurrentRuns: number;
  /** Grace period between SIGTERM and SIGKILL when a run is stopped. */
  readonly terminateGraceMs: number;
  /** Settled runs kept for listing and resuming, oldest evicted first. */
  readonly retainedRuns: number;
}

/** The protocol the delegate's final message is read through. */
export interface DirectionConfig {
  /** Marker line the delegate ends its final message with to ask for a decision. */
  readonly marker: string;
  /**
   * Marker line the delegate ends its final message with to declare remaining
   * work. Stated in the contract only while `autonomy.continue` can act on it.
   */
  readonly nextStepsMarker: string;
  /** Whether to state the contract in the delegated prompt. Off means runs never ask. */
  readonly preamble: boolean;
}

/** Resolved plugin configuration. */
export interface Config {
  /**
   * Directory holding account homes, the managed toolchain, and the account
   * registry. Empty derives `<harness home>/cli-bridge`.
   */
  readonly stateDir: string;
  /** Delegate used when a call does not name one. */
  readonly defaultCli: CliId;
  /** Expose account and toolchain management as model-facing tools. */
  readonly adminTools: boolean;
  readonly direction: DirectionConfig;
  readonly autonomy: AutonomyConfig;
  readonly isolation: IsolationConfig;
  readonly inquiry: InquiryConfig;
  readonly limits: LimitsConfig;
  readonly channel: ChannelConfig;
  readonly toolchain: ToolchainConfig;
  readonly delegates: Readonly<Record<CliId, DelegateConfig>>;
}

/** One delegate's schema; called once per delegate so the shape cannot drift. */
const delegateSchema = (): Schema<DelegateConfig> =>
  Schema.object({
    defaultModel: Schema.string().default(''),
    defaultEffort: Schema.union(['', ...EFFORT_LEVELS]).default(''),
    executable: Schema.string().default(''),
    extraArgs: Schema.array(Schema.string()).default([]),
  }) as unknown as Schema<DelegateConfig>;

/**
 * The schema is typed as `unknown` IN and {@link Config} OUT: it is fed raw
 * YAML from a cordis row, and what comes back is validated and defaulted.
 */
export const Config: Schema<unknown, Config> = Schema.object({
  stateDir: Schema.string().default(''),
  defaultCli: Schema.union([...CLI_IDS]).default('claude'),
  adminTools: Schema.boolean().default(true),
  direction: Schema.object({
    marker: Schema.string().default(DEFAULT_DIRECTION_MARKER),
    nextStepsMarker: Schema.string().default(DEFAULT_NEXT_STEPS_MARKER),
    preamble: Schema.boolean().default(true),
  }),
  autonomy: Schema.object({
    decide: Schema.boolean().default(false),
    continue: Schema.boolean().default(false),
    review: Schema.boolean().default(false),
    maxRounds: Schema.natural().min(1).default(6),
    maxReviews: Schema.natural().min(1).default(2),
    advisor: Schema.object({
      provider: Schema.string().default(''),
      model: Schema.string().default(''),
      maxTokens: Schema.natural().min(64).default(700),
      timeoutMs: Schema.natural().min(1000).default(60_000),
      evidenceMaxBytes: Schema.natural().min(256).default(4096),
    }),
  }),
  isolation: Schema.object({
    mode: Schema.union(['auto', 'worktree', 'inline'] as const).default('auto'),
    merge: Schema.union(['auto', 'never'] as const).default('auto'),
    branchPrefix: Schema.string().default('cli-bridge/'),
    keepOnConflict: Schema.boolean().default(true),
    gitTimeoutMs: Schema.natural().min(1000).default(120_000),
  }),
  inquiry: Schema.object({
    enabled: Schema.boolean().default(true),
    timeoutMs: Schema.natural().min(0).default(0),
  }),
  limits: Schema.object({
    summaryMaxBytes: Schema.natural().min(256).default(8192),
    errorMaxBytes: Schema.natural().min(128).default(2048),
    stderrTailBytes: Schema.natural().min(0).default(4096),
    runTimeoutMs: Schema.natural().min(0).default(3_600_000),
    maxConcurrentRuns: Schema.natural().min(1).default(4),
    terminateGraceMs: Schema.natural().min(100).default(5000),
    retainedRuns: Schema.natural().min(1).default(50),
  }),
  channel: Schema.object({
    enabled: Schema.boolean().default(true),
    basePath: Schema.string().default(DEFAULT_BASE_PATH),
    bufferBytesPerStream: Schema.natural().min(1024).default(262_144),
    trustedHosts: Schema.array(Schema.string()).default([]),
  }),
  toolchain: Schema.object({
    mode: Schema.union(['managed', 'path', 'disabled'] as const).default(
      'managed',
    ),
    autoInstall: Schema.boolean().default(true),
    updateIntervalMs: Schema.natural().min(0).default(86_400_000),
    npmCommand: Schema.string().default('npm'),
    registry: Schema.string().default(''),
    installTimeoutMs: Schema.natural().min(1000).default(600_000),
  }),
  delegates: Schema.object({
    claude: delegateSchema(),
    codex: delegateSchema(),
  }),
}) as unknown as Schema<unknown, Config>;
