import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertAccountId,
  BridgePaths,
  InvalidAccountIdError,
  resolveStateDir,
} from '../../src/runtime/paths.ts';

describe('resolveStateDir', () => {
  it('derives from the harness home', () => {
    expect(resolveStateDir('', { DSH_HOME: '/srv/dsh' })).toBe(
      join(resolve('/srv/dsh'), 'cli-bridge'),
    );
  });

  it('falls back to the OS home when the harness home is unset', () => {
    expect(resolveStateDir('', {})).toBe(join(homedir(), '.dsh', 'cli-bridge'));
  });

  it('ignores a blank harness home', () => {
    expect(resolveStateDir('', { DSH_HOME: '   ' })).toBe(
      join(homedir(), '.dsh', 'cli-bridge'),
    );
  });

  it('honours an explicit configuration', () => {
    expect(resolveStateDir('/opt/bridge', { DSH_HOME: '/srv/dsh' })).toBe(
      resolve('/opt/bridge'),
    );
  });
});

describe('BridgePaths', () => {
  const paths = new BridgePaths('/state');

  it('places every artefact under one root', () => {
    expect(paths.registry).toBe(join('/state', 'accounts.json'));
    expect(paths.toolchainState).toBe(
      join('/state', 'toolchain', 'state.json'),
    );
    expect(paths.toolchainPrefix('claude')).toBe(
      join('/state', 'toolchain', 'claude'),
    );
    expect(paths.accountHome('codex', 'work')).toBe(
      join('/state', 'homes', 'codex', 'work'),
    );
  });
});

describe('assertAccountId', () => {
  it.each(['work', 'a', 'team-2', 'my.account_1', 'x'.repeat(64)])(
    'accepts %s',
    (id) => {
      expect(assertAccountId(id)).toBe(id);
    },
  );

  it.each([
    ['empty', ''],
    ['uppercase', 'Work'],
    ['a space', 'my account'],
    ['a slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a colon', 'a:b'],
    ['leading punctuation', '-work'],
    ['too long', 'x'.repeat(65)],
    ['a Windows device name', 'con'],
    ['a Windows device name with an extension', 'nul.txt'],
    ['a serial device name', 'com1'],
    ['a trailing dot', 'work.'],
  ])('rejects %s', (_label, id) => {
    expect(() => assertAccountId(id)).toThrow(InvalidAccountIdError);
  });

  it('explains why', () => {
    expect(() => assertAccountId('Work')).toThrow(/a–z/u);
    expect(() => assertAccountId('con')).toThrow(/reserved by Windows/u);
  });
});
