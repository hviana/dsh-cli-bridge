/**
 * The delegate-CLI seam.
 *
 * One adapter per delegate, and everything that differs between Claude Code and
 * Codex lives behind this interface: the argv, the environment that selects an
 * account, the permission translation, and the projection of that CLI's own
 * event stream onto the shared {@link Activity} vocabulary.
 *
 * Every method is PURE. An adapter never spawns, never touches a filesystem and
 * never reads a clock, which is what makes the whole delegation matrix — CLI ×
 * model × effort × permission × resume — a table-driven unit test.
 *
 * @module dsh-cli-bridge/domain/adapters/contract
 */
import type {
  Activity,
  CliId,
  EffortLevel,
  PermissionMode,
  RunUsage,
} from '../../shared/protocol.ts';

/** A fully-specified process launch, ready for `ctx.subprocess`. */
export interface SpawnPlan {
  /** Executable and arguments; never shell-interpreted. */
  readonly argv: readonly string[];
  /**
   * Environment entries merged onto the harness's scrubbed parent environment.
   * An `undefined` value is a tombstone removing an inherited entry.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Text written to the child's stdin, then closed. Absent for interactive runs. */
  readonly stdin?: string;
}

/**
 * Where an account's CLI state lives and how it authenticates.
 *
 * A managed account owns a private home directory. The built-in AMBIENT account
 * has none: it runs the CLI exactly as the user configured it on this machine,
 * which is what makes a first run work with no setup at all.
 *
 * Beyond the home, the binding carries the account's authentication FACTS, and
 * the adapter decides which environment variable each one lives in. `apiKey` is
 * the CLI's own key; `baseUrl` + `authToken` together point the CLI at another
 * provider that speaks its protocol — the DeepSeek/OpenRouter shape.
 */
export interface AccountBinding {
  /**
   * Absolute path of the account's isolated CLI home. Absent for the ambient
   * account, whose whole point is to leave the CLI's own home alone.
   */
  readonly home?: string;
  /** Resolved API key, when the account authenticates with one. Never logged. */
  readonly apiKey?: string;
  /** Base URL of the endpoint the account reaches. */
  readonly baseUrl?: string;
  /** Resolved token for a custom endpoint. Never logged. */
  readonly authToken?: string;
}

/** What a delegated task run needs to know. */
export interface TaskPlanRequest {
  /** The full prompt, preamble included. */
  readonly prompt: string;
  /** Model id or alias, passed through verbatim; absent means the CLI's default. */
  readonly model?: string;
  /** Requested effort; each adapter clamps it to what its CLI accepts. */
  readonly effort?: EffortLevel;
  /** The harness permission mode this run inherits. */
  readonly permission: PermissionMode;
  /** Absolute working directory — also the workspace boundary. */
  readonly cwd: string;
  readonly account: AccountBinding;
  /** Delegate-side session to continue; absent starts a fresh one. */
  readonly resume?: string;
  /**
   * Deployment-supplied arguments appended verbatim. The escape hatch that
   * keeps this adapter from having to enumerate every flag its CLI will ever
   * grow; the plugin's own flags always win because they are stated first.
   */
  readonly extraArgs?: readonly string[];
}

/** What an interactive authentication run needs to know. */
export interface LoginPlanRequest {
  readonly account: AccountBinding;
  readonly cwd: string;
}

/** Terminal facts a decoder accumulated while the stream ran. */
export interface DecodedState {
  /** The delegate's last assistant message, unbounded. */
  readonly finalMessage?: string;
  /** The delegate's own session or thread id, for resuming. */
  readonly delegateSessionId?: string;
  /** Token and cost facts the delegate reported for itself. */
  readonly usage?: RunUsage;
  /** A failure the delegate reported in-band, independent of its exit code. */
  readonly failure?: string;
}

/**
 * Byte budget for the excerpt of a tool result an adapter publishes.
 *
 * The bound belongs HERE, at the seam where a delegate's bytes first enter the
 * plugin, and not in the view: a single `cat` of a large file would otherwise
 * travel through the channel and sit in every subscriber's memory before
 * anything decided it was too long to read. Generous enough for the output a
 * person actually reads at a glance; the untouched transcript stays one click
 * away in the raw log.
 */
export const TOOL_OUTPUT_BYTES = 2_000;

/**
 * Stateful projection of one delegate's stdout onto the shared vocabulary.
 *
 * `push` is called with complete lines in order; anything the decoder cannot
 * interpret yields no activity rather than an error, so a delegate that adds an
 * event type keeps streaming instead of breaking the run.
 */
export interface DelegateDecoder {
  /**
   * Consume one complete line of delegate stdout.
   * @param line - the line, terminator removed.
   * @returns activities to publish, in order; empty when the line carried none.
   */
  push(line: string): readonly Activity[];
  /** Facts accumulated so far; read once the stream has closed. */
  state(): DecodedState;
}

/** One delegate command-line agent, behind one shape. */
export interface CliAdapter {
  readonly id: CliId;
  /** Name shown in every human-facing surface. */
  readonly displayName: string;
  /** Default executable name, resolved on `PATH` or in the managed prefix. */
  readonly command: string;
  /** npm package the managed installer installs and updates. */
  readonly npmPackage: string;
  /** Directory the CLI keeps per-account state in, as an environment variable name. */
  readonly homeEnvVar: string;
  /** Environment variable carrying an API key, when the CLI accepts one. */
  readonly apiKeyEnvVar: string;
  /**
   * Environment variable redirecting the CLI to another provider's endpoint.
   * Absent when the CLI cannot be redirected this way.
   */
  readonly baseUrlEnvVar?: string;
  /**
   * Environment variable carrying the token for a redirected endpoint. Absent
   * when the CLI cannot be redirected this way.
   */
  readonly authTokenEnvVar?: string;
  /** Credential reference suggested for a new API-key account of this CLI. */
  readonly defaultCredentialRef: string;

  /**
   * Plan the version probe.
   * @returns argv appended to the executable.
   */
  versionArgv(): readonly string[];

  /**
   * Extract a version from the probe's output.
   * @param output - combined stdout of the version probe.
   * @returns the version, or `undefined` when the output was unrecognizable.
   */
  parseVersion(output: string): string | undefined;

  /**
   * Plan a delegated task run.
   * @param request - prompt, model, effort, inherited permission, and account.
   * @returns the launch plan.
   */
  planTask(request: TaskPlanRequest): SpawnPlan;

  /**
   * Plan the CLI's own interactive login, run under a real terminal.
   * @param request - the account whose private home receives the credentials.
   * @returns the launch plan; it never carries stdin.
   */
  planLogin(request: LoginPlanRequest): SpawnPlan;

  /**
   * Plan a non-interactive probe of an account's authentication state.
   * @param request - the account to probe.
   * @returns the launch plan.
   */
  planAuthStatus(request: LoginPlanRequest): SpawnPlan;

  /**
   * Start decoding one run's stdout.
   * @returns a fresh decoder; decoders are never shared between runs.
   */
  decoder(): DelegateDecoder;
}

/**
 * Whether an adapter can be redirected to another provider by environment.
 *
 * An `endpoint` account only means anything on a CLI that reads both a base-URL
 * and a token variable, so this is the check that keeps one from being created
 * for a delegate that could never act on it.
 * @param adapter - the adapter to test.
 * @returns true when the adapter declares both endpoint variables.
 */
export function supportsEndpoint(adapter: CliAdapter): boolean {
  return adapter.baseUrlEnvVar !== undefined &&
    adapter.authTokenEnvVar !== undefined;
}

/**
 * Build the account environment shared by every adapter.
 *
 * A managed account is ISOLATED: its home is pinned, and every authentication
 * variable the adapter knows about — API key, base URL, auth token — is always
 * stated, as the account's own value or as a tombstone, so a value lying around
 * in the harness's environment can never quietly authenticate a run as somebody
 * else, or quietly redirect it to somebody else's endpoint.
 *
 * The ambient account is the opposite by definition: it inherits the machine's
 * own CLI configuration untouched, and only an explicitly supplied fact is added.
 * @param adapter - the adapter whose variable names apply.
 * @param account - the account binding to project.
 * @returns environment entries to merge onto the scrubbed parent environment.
 */
export function accountEnv(
  adapter: Pick<
    CliAdapter,
    'homeEnvVar' | 'apiKeyEnvVar' | 'baseUrlEnvVar' | 'authTokenEnvVar'
  >,
  account: AccountBinding,
): Record<string, string | undefined> {
  const secrets: Record<string, string | undefined> = {
    ...adapter.baseUrlEnvVar === undefined
      ? {}
      : { [adapter.baseUrlEnvVar]: account.baseUrl },
    ...adapter.authTokenEnvVar === undefined
      ? {}
      : { [adapter.authTokenEnvVar]: account.authToken },
    [adapter.apiKeyEnvVar]: account.apiKey,
  };
  if (account.home === undefined) {
    const env: Record<string, string | undefined> = {};
    for (const [variable, value] of Object.entries(secrets)) {
      if (value !== undefined) env[variable] = value;
    }
    return env;
  }
  return { [adapter.homeEnvVar]: account.home, ...secrets };
}
