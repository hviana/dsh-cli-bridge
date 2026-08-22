/**
 * The resumable-session ledger.
 *
 * A delegated run's most expensive asset is the DELEGATE's own conversation —
 * Claude Code or Codex keeps it on disk, and resuming it (`--resume` / `resume`)
 * is what re-reads the context instead of re-studying the project. The plugin
 * only ever held the POINTER to that session (the `session_id`) in memory, so a
 * plugin reload lost it and a `cli_reply` could no longer reach the session.
 *
 * This ledger writes that pointer — plus the origin a resumption needs (which
 * account, model, effort, permission, budget, and which workspace to run in) —
 * to `<stateDir>/sessions.json` whenever a delegation settles with a known
 * session. On the next boot it is read back, so a delegation id the caller is
 * still holding can be resumed even though the process that ran it is gone.
 *
 * @module dsh-cli-bridge/runtime/sessions
 */
import type {
  BatchId,
  CliId,
  DelegationId,
  EffortLevel,
  PermissionMode,
} from '../shared/protocol.ts';
import type { BridgePaths } from './paths.ts';
import type { FilePort } from './ports.ts';

/** Everything a resumption needs, and nothing the delegate holds itself. */
export interface ResumableSession {
  readonly delegation: DelegationId;
  readonly cli: CliId;
  readonly account: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  readonly permission: PermissionMode;
  readonly timeoutMs?: number;
  /** The delegate's own session identity — the resume handle. */
  readonly delegateSessionId: string;
  /** Where a continuation should run: the base repo, or the session workspace. */
  readonly base: string;
  readonly parent?: DelegationId;
  readonly batch: BatchId;
  /** One-line human label, so a listing can still name the work. */
  readonly label: string;
  /** Owning harness session, for fencing. */
  readonly sessionId?: string;
  readonly finishedAt: number;
}

/** The on-disk document. */
interface SessionsDocument {
  readonly version: 1;
  readonly sessions: readonly ResumableSession[];
}

const EMPTY: SessionsDocument = { version: 1, sessions: [] };

/**
 * The persisted resume handles.
 *
 * Reads are served from memory after the first load; every write persists
 * through the atomic file port before it returns, so a crash cannot leave the
 * ledger describing a session that was never actually recorded.
 */
export class SessionLedger {
  private document: SessionsDocument | undefined;

  constructor(
    private readonly paths: BridgePaths,
    private readonly files: FilePort,
  ) {}

  /**
   * Load the ledger from disk if it has not been loaded yet.
   *
   * A missing, empty, or unreadable document yields an empty ledger: the
   * sessions it described still live in the delegates' own homes, and a hard
   * failure here must not take the plugin down over a file the user can
   * recreate.
   * @returns the in-memory document.
   */
  private async read(): Promise<SessionsDocument> {
    if (this.document !== undefined) return this.document;
    const text = await this.files.readText(this.paths.sessions);
    this.document = text === undefined ? EMPTY : parseDocument(text);
    return this.document;
  }

  /**
   * Record one resumable session, replacing any earlier record for the same
   * delegation id. A failed write is swallowed: the in-memory record still
   * serves this process, and a broken disk must not fail a delegation whose
   * work is already done.
   * @param session - the resume handle to store.
   */
  async record(session: ResumableSession): Promise<void> {
    const document = await this.read();
    const next: SessionsDocument = {
      version: 1,
      sessions: [
        ...document.sessions.filter((kept) =>
          kept.delegation !== session.delegation
        ),
        session,
      ],
    };
    this.document = next;
    try {
      await this.files.writeText(
        this.paths.sessions,
        `${JSON.stringify(next, undefined, 2)}\n`,
      );
    } catch {
      // Deliberately quiet: see the method doc.
    }
  }

  /**
   * Read one resumable session, fenced to the asking session exactly as a live
   * delegation is.
   * @param delegation - the delegation id.
   * @param sessionId - the asking session; omit for the human channel.
   * @returns the handle, or `undefined` when it is unknown or belongs elsewhere.
   */
  async get(
    delegation: DelegationId,
    sessionId?: string,
  ): Promise<ResumableSession | undefined> {
    const document = await this.read();
    const found = document.sessions.find((entry) =>
      entry.delegation === delegation
    );
    return found === undefined || !visible(found, sessionId)
      ? undefined
      : found;
  }

  /** List every resumable session visible to one session. */
  async list(sessionId?: string): Promise<ResumableSession[]> {
    const document = await this.read();
    return document.sessions.filter((entry) => visible(entry, sessionId));
  }

  /**
   * The highest delegation number already persisted, so a process that has
   * reloaded continues the id sequence instead of minting a `d<n>` that would
   * overwrite an older resume handle.
   * @returns the largest `n` among persisted `d<n>` ids, or `0`.
   */
  async maxDelegationNumber(): Promise<number> {
    const document = await this.read();
    let max = 0;
    for (const entry of document.sessions) {
      const match = /^d(\d+)$/u.exec(entry.delegation);
      if (match !== null) {
        const n = Number(match[1]);
        if (Number.isSafeInteger(n)) max = Math.max(max, n);
      }
    }
    return max;
  }
}

/** Whether a session is reachable from here, the same rule live runs follow. */
function visible(session: ResumableSession, sessionId?: string): boolean {
  return sessionId === undefined || session.sessionId === undefined ||
    session.sessionId === sessionId;
}

/** Parse a ledger document, tolerating anything that is not one. */
function parseDocument(text: string): SessionsDocument {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null) return EMPTY;
    const candidate = raw as Partial<SessionsDocument>;
    return {
      version: 1,
      sessions: Array.isArray(candidate.sessions)
        ? candidate.sessions.filter(isSession)
        : [],
    };
  } catch {
    return EMPTY;
  }
}

/** Whether a parsed entry has the shape of a stored resume handle. */
function isSession(value: unknown): value is ResumableSession {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ResumableSession>;
  return typeof candidate.delegation === 'string' &&
    (candidate.cli === 'claude' || candidate.cli === 'codex') &&
    typeof candidate.account === 'string' &&
    (candidate.permission === 'read-only' ||
      candidate.permission === 'workspace-write' ||
      candidate.permission === 'danger-full-access') &&
    typeof candidate.delegateSessionId === 'string' &&
    typeof candidate.base === 'string' &&
    typeof candidate.batch === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.finishedAt === 'number';
}
