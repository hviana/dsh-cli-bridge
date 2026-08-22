import { describe, expect, it } from 'vitest';
import { BridgePaths } from '../../src/runtime/paths.ts';
import {
  type ResumableSession,
  SessionLedger,
} from '../../src/runtime/sessions.ts';
import { MemoryFiles } from '../support/fakes.ts';

const paths = new BridgePaths('/state');

const session = (patch: Partial<ResumableSession> = {}): ResumableSession => ({
  delegation: 'd1',
  cli: 'claude',
  account: 'ambient',
  permission: 'workspace-write',
  delegateSessionId: 'sess-77',
  base: '/repo',
  batch: 'b1',
  label: 'Port the parser.',
  finishedAt: 1_700_000_000_000,
  ...patch,
});

describe('SessionLedger', () => {
  it('records, reads back, and lists a resume handle', async () => {
    const files = new MemoryFiles();
    const ledger = new SessionLedger(paths, files);
    await ledger.record(session());
    expect(await ledger.get('d1')).toEqual(session());
    expect(await ledger.list()).toEqual([session()]);
  });

  it('replaces an earlier record for the same delegation id', async () => {
    const files = new MemoryFiles();
    const ledger = new SessionLedger(paths, files);
    await ledger.record(session({ delegateSessionId: 'sess-old' }));
    await ledger.record(session({ delegateSessionId: 'sess-new' }));
    expect((await ledger.get('d1'))?.delegateSessionId).toBe('sess-new');
    expect(await ledger.list()).toHaveLength(1);
  });

  it('fences a persisted handle to the session that owns it', async () => {
    const files = new MemoryFiles();
    const ledger = new SessionLedger(paths, files);
    await ledger.record(session({ sessionId: 'session-a' }));
    expect(await ledger.get('d1', 'session-a')).toEqual(
      session({ sessionId: 'session-a' }),
    );
    expect(await ledger.get('d1', 'session-b')).toBeUndefined();
    expect(await ledger.list('session-b')).toEqual([]);
    // The unscoped human channel reaches everything.
    expect(await ledger.get('d1')).toBeDefined();
  });

  it('reports the highest delegation number, and zero when there is none', async () => {
    const files = new MemoryFiles();
    const ledger = new SessionLedger(paths, files);
    expect(await ledger.maxDelegationNumber()).toBe(0);
    await ledger.record(session({ delegation: 'd3' }));
    await ledger.record(session({ delegation: 'd10' }));
    await ledger.record(session({ delegation: 'd2' }));
    expect(await ledger.maxDelegationNumber()).toBe(10);
  });

  it('persists to the ledger document, so a reload reads it back', async () => {
    const files = new MemoryFiles();
    await new SessionLedger(paths, files).record(session());
    // A fresh ledger over the same store re-reads the file.
    const reloaded = new SessionLedger(paths, files);
    expect(await reloaded.get('d1')).toEqual(session());
  });

  it('treats a missing or corrupt document as empty, never as a failure', async () => {
    const files = new MemoryFiles();
    const ledger = new SessionLedger(paths, files);
    await files.writeText(paths.sessions, '{not json');
    expect(await ledger.list()).toEqual([]);
    expect(await ledger.maxDelegationNumber()).toBe(0);
  });
});
