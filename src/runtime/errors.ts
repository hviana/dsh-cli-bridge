/**
 * The plugin's failure vocabulary.
 *
 * A delegate that fails is NOT an error here: a run that exits non-zero is a
 * successful tool call whose canonical value says `failed`, because the model
 * needs to read that outcome and decide. These errors are for the other kind of
 * failure — the call could not be attempted at all: an account that does not
 * exist, a CLI that is not installed, a run id that was never issued.
 *
 * Every one carries a stable `code`; surfaces route on the code and show the
 * message, and neither ever parses the other.
 *
 * @module dsh-cli-bridge/runtime/errors
 */

/** Stable, machine-routable failure classes. */
export type BridgeErrorCode =
  /** The named account does not exist for that delegate. */
  | 'UNKNOWN_ACCOUNT'
  /** An account with that id already exists for that delegate. */
  | 'DUPLICATE_ACCOUNT'
  /** The account id cannot be a directory name on every supported platform. */
  | 'INVALID_ACCOUNT'
  /** The account's API key reference does not resolve. */
  | 'CREDENTIAL_MISSING'
  /** The account is the built-in ambient one and cannot be changed. */
  | 'AMBIENT_ACCOUNT'
  /** The delegate CLI is not installed and could not be installed. */
  | 'CLI_MISSING'
  /** A managed install or update failed. */
  | 'INSTALL_FAILED'
  /** The composition disabled managed installs. */
  | 'TOOLCHAIN_DISABLED'
  /** The run id was never issued, or belongs to another session. */
  | 'UNKNOWN_RUN'
  /** The run does not accept input. */
  | 'NOT_INTERACTIVE'
  /** The concurrency limit is reached, and this caller may not wait for a slot. */
  | 'RUN_LIMIT'
  /** The caller gave up while waiting — for a slot, or for anything else queued. */
  | 'CANCELLED'
  /** The request itself is malformed. */
  | 'INVALID_REQUEST';

/**
 * A failure to attempt an operation.
 *
 * Deliberately not derived from the harness's own `HarnessError`: that base
 * lives in a package this plugin has no other reason to load at runtime, and a
 * second copy of it would break the harness's `instanceof` narrowing rather
 * than support it. The contract that matters — a stable `code` beside a
 * human-readable `message` — is reproduced exactly.
 */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;

  constructor(message: string, code: BridgeErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BridgeError';
    this.code = code;
  }
}

/**
 * Narrow a caught value to a {@link BridgeError}.
 * @param value - the caught value.
 * @returns whether it is one of this plugin's errors.
 */
export function isBridgeError(value: unknown): value is BridgeError {
  return value instanceof BridgeError;
}

/**
 * Render a caught value as a single human-readable line, cause chain included.
 * @param value - the caught value.
 * @returns the message, or a stringified fallback for a non-Error throw.
 */
export function describeError(value: unknown): string {
  if (!(value instanceof Error)) return String(value);
  const chain: string[] = [];
  let current: Error | undefined = value;
  while (current !== undefined && chain.length < 8) {
    if (chain.at(-1) !== current.message) chain.push(current.message);
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return chain.join(': ');
}
