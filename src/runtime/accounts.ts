/**
 * The account registry.
 *
 * An account is a directory plus a way to authenticate — nothing more. The
 * plugin stores no tokens of its own: a `session` account is the CLI's own
 * login living in a private home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), and an
 * `api-key` account is a REFERENCE into the harness credential store, resolved
 * per run and never written down here.
 *
 * Every delegate also has one account that is not stored at all: the AMBIENT
 * account, which runs the CLI exactly as the user already configured it on this
 * machine. It exists so the plugin works before anybody configures anything.
 *
 * @module dsh-cli-bridge/runtime/accounts
 */
import type {
  AccountAuth,
  AccountSnapshot,
  CliId,
} from '../shared/protocol.ts';
import { CLI_IDS } from '../shared/protocol.ts';
import type { AccountBinding, CliAdapter } from '../domain/adapters/index.ts';
import { adapterFor, supportsEndpoint } from '../domain/adapters/index.ts';
import { BridgeError } from './errors.ts';
import {
  assertAccountId,
  type BridgePaths,
  InvalidAccountIdError,
} from './paths.ts';
import type { CredentialPort, FilePort } from './ports.ts';

/** Id of the built-in account that inherits the machine's own CLI configuration. */
export const AMBIENT_ACCOUNT_ID = 'ambient';

/** One stored account. */
export interface AccountRecord {
  readonly id: string;
  readonly cli: CliId;
  readonly label: string;
  readonly auth: AccountAuth;
  readonly credentialRef?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly createdAt: number;
  readonly lastUsedAt?: number;
}

/** The on-disk registry document. */
interface RegistryDocument {
  readonly version: 1;
  readonly accounts: readonly AccountRecord[];
  /** Chosen default per delegate; absent entries fall back to the ambient account. */
  readonly defaults: Partial<Record<CliId, string>>;
}

const EMPTY: RegistryDocument = { version: 1, accounts: [], defaults: {} };

/** What one account needs to be added. */
export interface AddAccountRequest {
  readonly cli: CliId;
  readonly id: string;
  readonly label?: string;
  readonly auth: AccountAuth;
  /** Credential reference for an `api-key` or `endpoint` account; defaults to the CLI's usual variable only for `api-key`. */
  readonly credentialRef?: string;
  /** Base URL for an `endpoint` account. */
  readonly baseUrl?: string;
  /** Default model for an `endpoint` account. */
  readonly model?: string;
}

/**
 * The account registry: one JSON document, one directory per account.
 *
 * Reads are served from memory after the first load; every write persists
 * before it returns, so a crash cannot leave the registry disagreeing with the
 * directories it describes.
 */
export class AccountStore {
  private document: RegistryDocument | undefined;

  constructor(
    private readonly paths: BridgePaths,
    private readonly files: FilePort,
    private readonly now: () => number,
    private readonly credentials?: CredentialPort,
  ) {}

  /**
   * Load the registry from disk if it has not been loaded yet.
   *
   * A document that is missing, empty, or unreadable yields an empty registry:
   * the accounts it described are directories, still on disk, and a hard failure
   * here would take down the whole plugin over a file the user can recreate.
   * @returns the in-memory document.
   */
  private async read(): Promise<RegistryDocument> {
    if (this.document !== undefined) return this.document;
    const text = await this.files.readText(this.paths.registry);
    this.document = text === undefined ? EMPTY : parseDocument(text);
    return this.document;
  }

  /**
   * Persist a new document.
   * @param next - the document to write.
   */
  private async write(next: RegistryDocument): Promise<void> {
    this.document = next;
    await this.files.writeText(
      this.paths.registry,
      `${JSON.stringify(next, undefined, 2)}\n`,
    );
  }

  /**
   * List every account of one delegate, or of all of them.
   *
   * The ambient account is synthesized first for each delegate, so a surface
   * always has something to offer and never has to special-case emptiness.
   * @param cli - restrict to one delegate; omit for all.
   * @returns snapshots in listing order.
   */
  async list(cli?: CliId): Promise<AccountSnapshot[]> {
    const document = await this.read();
    const wanted = cli === undefined ? CLI_IDS : [cli];
    // Credential probes are independent, so they resolve together rather than
    // one account at a time.
    const groups = await Promise.all(
      wanted.map(async (id): Promise<AccountSnapshot[]> => {
        const chosen = document.defaults[id];
        const stored = await Promise.all(
          document.accounts
            .filter((account) => account.cli === id)
            .map(async (record) => this.snapshot(record, record.id === chosen)),
        );
        stored.unshift(
          this.ambientSnapshot(
            id,
            chosen === undefined || chosen === AMBIENT_ACCOUNT_ID,
          ),
        );
        return stored;
      }),
    );
    return groups.flat();
  }

  /**
   * Resolve the account a run should use.
   * @param cli - the delegate.
   * @param id - the requested account; omit for the delegate's default.
   * @returns the record, or `undefined` for the ambient account.
   * @throws {BridgeError} `UNKNOWN_ACCOUNT` when a named account does not exist.
   */
  async resolve(cli: CliId, id?: string): Promise<AccountRecord | undefined> {
    const document = await this.read();
    const wanted = id ?? document.defaults[cli] ?? AMBIENT_ACCOUNT_ID;
    if (wanted === AMBIENT_ACCOUNT_ID) return undefined;
    const record = document.accounts.find((account) =>
      account.cli === cli && account.id === wanted
    );
    if (record !== undefined) return record;
    throw new BridgeError(
      `no ${cli} account named ${JSON.stringify(wanted)}${
        id === undefined ? ' (it is the configured default)' : ''
      }`,
      'UNKNOWN_ACCOUNT',
    );
  }

  /**
   * Build the binding a run spawns with, resolving any credential reference.
   * @param cli - the delegate.
   * @param record - the resolved account, or `undefined` for the ambient one.
   * @returns the binding an adapter turns into environment entries.
   * @throws {BridgeError} `CREDENTIAL_MISSING` when a credential-backed account has no value.
   */
  async bind(
    cli: CliId,
    record: AccountRecord | undefined,
  ): Promise<AccountBinding> {
    if (record === undefined) return {};
    const home = this.paths.accountHome(cli, record.id);
    if (record.auth !== 'api-key' && record.auth !== 'endpoint') {
      return { home };
    }
    const ref = record.credentialRef ?? adapterFor(cli).defaultCredentialRef;
    const value = await this.credentials?.resolve(ref);
    if (value === undefined || value.length === 0) {
      throw new BridgeError(
        `account ${record.id} authenticates with the credential ${ref}, which is not configured`,
        'CREDENTIAL_MISSING',
      );
    }
    return record.auth === 'endpoint'
      ? {
        home,
        ...record.baseUrl === undefined ? {} : { baseUrl: record.baseUrl },
        authToken: value,
      }
      : { home, apiKey: value };
  }

  /**
   * Register a new account and create its private CLI home.
   * @param request - the account to add.
   * @returns its snapshot.
   * @throws {BridgeError} for an invalid, reserved, or duplicate id.
   */
  async add(request: AddAccountRequest): Promise<AccountSnapshot> {
    const id = validateId(request.id);
    if (id === AMBIENT_ACCOUNT_ID) {
      throw new BridgeError(
        `${AMBIENT_ACCOUNT_ID} is the built-in account and cannot be redefined`,
        'AMBIENT_ACCOUNT',
      );
    }
    const document = await this.read();
    if (
      document.accounts.some((account) =>
        account.cli === request.cli && account.id === id
      )
    ) {
      throw new BridgeError(
        `a ${request.cli} account named ${JSON.stringify(id)} already exists`,
        'DUPLICATE_ACCOUNT',
      );
    }
    const adapter = adapterFor(request.cli);
    const record: AccountRecord = {
      id,
      cli: request.cli,
      label: request.label ?? id,
      auth: request.auth,
      ...credentialFields(adapter, request),
      createdAt: this.now(),
    };
    // The directory is the account; create it before the registry claims it exists.
    await this.files.makeDirectory(this.paths.accountHome(request.cli, id));
    const isFirst = document.defaults[request.cli] === undefined;
    await this.write({
      ...document,
      accounts: [...document.accounts, record],
      defaults: isFirst
        ? { ...document.defaults, [request.cli]: id }
        : document.defaults,
    });
    return this.snapshot(record, isFirst);
  }

  /**
   * Remove an account, its private home, and any default pointing at it.
   * @param cli - the delegate.
   * @param id - the account id.
   * @throws {BridgeError} when the account is unknown or built in.
   */
  async remove(cli: CliId, id: string): Promise<void> {
    if (id === AMBIENT_ACCOUNT_ID) {
      throw new BridgeError(
        `${AMBIENT_ACCOUNT_ID} is the built-in account and cannot be removed`,
        'AMBIENT_ACCOUNT',
      );
    }
    const document = await this.read();
    if (
      !document.accounts.some((account) =>
        account.cli === cli && account.id === id
      )
    ) {
      throw new BridgeError(
        `no ${cli} account named ${JSON.stringify(id)}`,
        'UNKNOWN_ACCOUNT',
      );
    }
    const defaults = { ...document.defaults };
    if (defaults[cli] === id) delete defaults[cli];
    await this.write({
      ...document,
      accounts: document.accounts.filter((account) =>
        !(account.cli === cli && account.id === id)
      ),
      defaults,
    });
    await this.files.removeDirectory(this.paths.accountHome(cli, id));
  }

  /**
   * Choose the account a delegate uses when a call names none.
   * @param cli - the delegate.
   * @param id - the account id, or the ambient id.
   * @throws {BridgeError} `UNKNOWN_ACCOUNT` when the account does not exist.
   */
  async setDefault(cli: CliId, id: string): Promise<void> {
    const document = await this.read();
    if (
      id !== AMBIENT_ACCOUNT_ID &&
      !document.accounts.some((account) =>
        account.cli === cli && account.id === id
      )
    ) {
      throw new BridgeError(
        `no ${cli} account named ${JSON.stringify(id)}`,
        'UNKNOWN_ACCOUNT',
      );
    }
    await this.write({
      ...document,
      defaults: { ...document.defaults, [cli]: id },
    });
  }

  /**
   * Record that an account just ran, for the listing's "last used" column.
   * @param cli - the delegate.
   * @param id - the account id; the ambient account is not tracked.
   */
  async touch(cli: CliId, id: string): Promise<void> {
    if (id === AMBIENT_ACCOUNT_ID) return;
    const document = await this.read();
    const index = document.accounts.findIndex((account) =>
      account.cli === cli && account.id === id
    );
    const target = document.accounts[index];
    if (target === undefined) return;
    const accounts = [...document.accounts];
    accounts[index] = { ...target, lastUsedAt: this.now() };
    await this.write({ ...document, accounts });
  }

  /**
   * Ensure an account's home exists before a login writes into it.
   * @param cli - the delegate.
   * @param id - the account id.
   * @returns the home directory, or `undefined` for the ambient account.
   */
  async prepareHome(cli: CliId, id: string): Promise<string | undefined> {
    if (id === AMBIENT_ACCOUNT_ID) return undefined;
    const home = this.paths.accountHome(cli, id);
    await this.files.makeDirectory(home);
    return home;
  }

  /** Project one stored account, asking the credential store only whether it resolves. */
  private async snapshot(
    record: AccountRecord,
    isDefault: boolean,
  ): Promise<AccountSnapshot> {
    const ref = record.auth === 'api-key' || record.auth === 'endpoint'
      ? record.credentialRef ?? adapterFor(record.cli).defaultCredentialRef
      : undefined;
    const configured = ref === undefined
      ? undefined
      : (await this.credentials?.resolve(ref).catch(() => undefined));
    return {
      id: record.id,
      cli: record.cli,
      label: record.label,
      auth: record.auth,
      ...ref === undefined ? {} : {
        credentialRef: ref,
        credentialConfigured: (configured ?? '').length > 0,
      },
      ...record.baseUrl === undefined ? {} : { baseUrl: record.baseUrl },
      ...record.model === undefined ? {} : { model: record.model },
      home: this.paths.accountHome(record.cli, record.id),
      isDefault,
      createdAt: record.createdAt,
      ...record.lastUsedAt === undefined
        ? {}
        : { lastUsedAt: record.lastUsedAt },
    };
  }

  /** Project the built-in ambient account of one delegate. */
  private ambientSnapshot(cli: CliId, isDefault: boolean): AccountSnapshot {
    return {
      id: AMBIENT_ACCOUNT_ID,
      cli,
      label: `${adapterFor(cli).displayName} as configured on this machine`,
      auth: 'session',
      home: '',
      isDefault,
      createdAt: 0,
    };
  }
}

/**
 * Describe how an account authenticates, for a human-facing listing.
 * @param snapshot - the account.
 * @param adapter - its adapter, for the credential variable's usual name.
 * @returns a short phrase.
 */
export function describeAuth(
  snapshot: AccountSnapshot,
  adapter: CliAdapter,
): string {
  if (snapshot.id === AMBIENT_ACCOUNT_ID) return 'machine default';
  if (snapshot.auth === 'session') return `${adapter.displayName} login`;
  if (snapshot.auth === 'endpoint') {
    const target = snapshot.model === undefined
      ? snapshot.baseUrl ?? 'custom endpoint'
      : `${snapshot.model} @ ${snapshot.baseUrl ?? 'custom endpoint'}`;
    return `${target} (${snapshot.credentialRef ?? 'token'} ${
      snapshot.credentialConfigured === true ? 'configured' : 'not configured'
    })`;
  }
  const ref = snapshot.credentialRef ?? adapter.defaultCredentialRef;
  return `${ref} (${
    snapshot.credentialConfigured === true ? 'configured' : 'not configured'
  })`;
}

/** Shape of a harness credential reference: a POSIX environment-variable name. */
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Validate a credential reference.
 *
 * The harness brands references and validates them in its own constructor; this
 * plugin reproduces the rule so a malformed reference is refused where the user
 * typed it, rather than at the first run that tries to resolve it.
 * @param ref - the candidate reference.
 * @returns the same reference, proven well-formed.
 * @throws {BridgeError} `INVALID_REQUEST` when it is not an environment-variable name.
 */
function validateCredentialRef(ref: string): string {
  if (CREDENTIAL_REF.test(ref)) return ref;
  throw new BridgeError(
    `credential reference ${
      JSON.stringify(ref)
    } must be an environment-variable name`,
    'INVALID_REQUEST',
  );
}

/**
 * The fields a new account stores, validated for its kind.
 *
 * An `api-key` account needs only the credential reference (defaulting to the
 * CLI's usual variable). An `endpoint` account needs a base URL and a token
 * reference — there is no "usual variable" for a third-party provider — and may
 * name a default model. A `session` account stores none of them.
 * @param adapter - the adapter the account belongs to.
 * @param request - what the caller asked for.
 * @returns the fields to store on the record.
 * @throws {BridgeError} `INVALID_REQUEST` when the kind cannot carry them.
 */
function credentialFields(
  adapter: CliAdapter,
  request: AddAccountRequest,
): {
  readonly credentialRef?: string;
  readonly baseUrl?: string;
  readonly model?: string;
} {
  switch (request.auth) {
    case 'api-key':
      return {
        credentialRef: validateCredentialRef(
          request.credentialRef ?? adapter.defaultCredentialRef,
        ),
      };
    case 'endpoint': {
      if (!supportsEndpoint(adapter)) {
        throw new BridgeError(
          `${adapter.displayName} cannot be pointed at another endpoint`,
          'INVALID_REQUEST',
        );
      }
      if (
        request.baseUrl === undefined || request.baseUrl.trim().length === 0
      ) {
        throw new BridgeError(
          'an endpoint account needs a base URL',
          'INVALID_REQUEST',
        );
      }
      if (request.credentialRef === undefined) {
        throw new BridgeError(
          'an endpoint account needs a token credential reference',
          'INVALID_REQUEST',
        );
      }
      return {
        baseUrl: validateBaseUrl(request.baseUrl),
        credentialRef: validateCredentialRef(request.credentialRef),
        ...request.model === undefined || request.model.trim().length === 0
          ? {}
          : { model: request.model.trim() },
      };
    }
    default:
      return {};
  }
}

/**
 * Validate an endpoint base URL.
 * @param url - the candidate URL.
 * @returns the same URL, proven http(s).
 * @throws {BridgeError} `INVALID_REQUEST` when it is not one.
 */
function validateBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;
  } catch {
    // fall through to the refusal
  }
  throw new BridgeError(
    `base URL ${JSON.stringify(url)} must be an http(s) URL`,
    'INVALID_REQUEST',
  );
}

/** Validate an id, restating the failure in this module's vocabulary. */
function validateId(id: string): string {
  try {
    return assertAccountId(id);
  } catch (error) {
    if (error instanceof InvalidAccountIdError) {
      throw new BridgeError(error.message, 'INVALID_ACCOUNT', { cause: error });
    }
    throw error;
  }
}

/** Parse a registry document, tolerating anything that is not one. */
function parseDocument(text: string): RegistryDocument {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null) return EMPTY;
    const candidate = raw as Partial<RegistryDocument>;
    return {
      version: 1,
      accounts: Array.isArray(candidate.accounts)
        ? candidate.accounts.filter(isRecord)
        : [],
      defaults:
        typeof candidate.defaults === 'object' && candidate.defaults !== null
          ? candidate.defaults
          : {},
    };
  } catch {
    return EMPTY;
  }
}

/** Whether a parsed entry has the shape of a stored account. */
function isRecord(value: unknown): value is AccountRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AccountRecord>;
  return typeof candidate.id === 'string' &&
    typeof candidate.label === 'string' &&
    (candidate.cli === 'claude' || candidate.cli === 'codex') &&
    (candidate.auth === 'session' || candidate.auth === 'api-key' ||
      candidate.auth === 'endpoint') &&
    typeof candidate.createdAt === 'number';
}
