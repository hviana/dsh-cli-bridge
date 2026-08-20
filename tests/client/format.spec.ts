import { describe, expect, it } from 'vitest';
import {
  activityTone,
  boundTailChars,
  describeAccount,
  describeActivity,
  describeDelegation,
  describeMerge,
  directionCopy,
  formatBytes,
  formatDuration,
  formatUsage,
  pillLabel,
  runElapsed,
} from '../../src/client/format.ts';
import type {
  AccountSnapshot,
  Activity,
  DelegationSnapshot,
  RunSnapshot,
} from '../../src/shared/protocol.ts';

describe('boundTailChars', () => {
  it('keeps short text and the tail of long text', () => {
    expect(boundTailChars('abc', 5)).toBe('abc');
    expect(boundTailChars('abcdef', 3)).toBe('def');
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [2048, '2.0 KiB'],
    [5 * 1024 * 1024, '5.0 MiB'],
  ])('renders %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0ms'],
    [-5, '0ms'],
    [999, '999ms'],
    [1500, '1.5s'],
    [59_900, '59.9s'],
    [65_000, '1m 05s'],
    [3_600_000, '60m 00s'],
  ])('renders %i as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('runElapsed', () => {
  const snapshot = { startedAt: 1000 } as RunSnapshot;

  it('measures against now while a run is live', () => {
    expect(runElapsed(snapshot, 3500)).toBe('2.5s');
  });

  it('measures against settlement once it has one', () => {
    expect(runElapsed({ ...snapshot, finishedAt: 2000 }, 9999)).toBe('1.0s');
  });
});

describe('formatUsage', () => {
  it('is empty when the delegate reported nothing', () => {
    expect(formatUsage(undefined)).toBe('');
    expect(formatUsage({})).toBe('');
  });

  it('joins only what was reported', () => {
    expect(formatUsage({ inputTokens: 10, outputTokens: 2 })).toBe(
      '10 in · 2 out',
    );
    expect(formatUsage({ cachedInputTokens: 5, costUsd: 0.0125 })).toBe(
      '5 cached · $0.0125',
    );
  });
});

describe('describeActivity', () => {
  it.each<[string, Activity, string]>([
    ['a message', { type: 'message', text: 'hello' }, 'hello'],
    ['reasoning', { type: 'reasoning', text: 'thinking' }, 'thinking'],
    ['a bare tool', { type: 'tool', name: 'Bash', status: 'started' }, 'Bash'],
    ['a tool with detail', {
      type: 'tool',
      name: 'Bash',
      status: 'started',
      detail: 'npm test',
    }, 'Bash npm test'],
    [
      'a tool with an exit code',
      {
        type: 'tool',
        name: 'command',
        status: 'failed',
        detail: 'ls',
        exitCode: 2,
      },
      'command ls (exit 2)',
    ],
    [
      'a file change',
      { type: 'file', path: '/a.ts', change: 'update' },
      'update /a.ts',
    ],
    ['usage', { type: 'usage', usage: { outputTokens: 3 } }, '3 out'],
    [
      'a notice',
      { type: 'notice', level: 'warn', text: 'retrying' },
      'retrying',
    ],
  ])('describes %s', (_label, activity, expected) => {
    expect(describeActivity(activity)).toBe(expected);
  });
});

describe('describeDelegation', () => {
  const base = {
    id: 'd1',
    batch: 'b1',
    label: 'port the parser',
    cli: 'claude',
    account: 'work',
    permission: 'workspace-write',
    status: 'completed',
    rounds: ['claude-1'],
    workspace: { mode: 'inline', path: '/repo', merge: 'not-required' },
    directions: [],
    decisions: [],
    startedAt: 1000,
    finishedAt: 5200,
  } as const satisfies DelegationSnapshot;

  it('reads who ran it and for how long', () => {
    expect(describeDelegation(base, 9000)).toBe(
      'claude/work · workspace-write · 4.2s',
    );
  });

  it('counts the rounds only when there was more than one', () => {
    expect(
      describeDelegation({ ...base, rounds: ['claude-1', 'claude-2'] }, 9000),
    ).toContain('2 rounds');
  });

  it('measures a live delegation against now', () => {
    const { finishedAt: _live, ...running } = base;
    expect(describeDelegation({ ...running, status: 'running' }, 3000))
      .toContain('2.0s');
  });

  it('adds the model, the effort and the delegate’s own spend when they are known', () => {
    const described = describeDelegation({
      ...base,
      model: 'opus',
      effort: 'high',
      usage: { inputTokens: 90, outputTokens: 12 },
    }, 9000);
    expect(described).toContain('opus · high');
    expect(described).toContain('90 in · 12 out');
  });
});

describe('describeMerge', () => {
  it('says nothing about work done in the session workspace', () => {
    expect(
      describeMerge({ mode: 'inline', path: '/repo', merge: 'not-required' }),
    ).toBeUndefined();
  });

  it.each(
    [
      ['merged', 'merged cli-bridge/d1'],
      ['pending', 'working on cli-bridge/d1'],
      ['conflict', 'cli-bridge/d1 conflicts on merge'],
      ['failed', 'cli-bridge/d1 could not be merged'],
      ['skipped', 'cli-bridge/d1 was not merged'],
    ] as const,
  )('reports %p', (merge, expected) => {
    expect(
      describeMerge({
        mode: 'worktree',
        path: '/w/d1',
        branch: 'cli-bridge/d1',
        merge,
      }),
    )
      .toContain(expected);
  });

  it('carries the reason a merge could not happen', () => {
    expect(describeMerge({
      mode: 'worktree',
      path: '/w/d1',
      branch: 'cli-bridge/d1',
      merge: 'conflict',
      detail: 'CONFLICT in README.md',
    })).toContain('CONFLICT in README.md');
  });

  it('names the branch it does not know as such', () => {
    expect(
      describeMerge({ mode: 'worktree', path: '/w/d1', merge: 'not-required' }),
    ).toBe('its branch');
  });
});

describe('pillLabel', () => {
  it('says nothing but its name when nothing is happening', () => {
    expect(pillLabel({ waiting: 0, running: 0 })).toBe('delegates');
  });

  it('counts what is running', () => {
    expect(pillLabel({ waiting: 0, running: 2 })).toBe('delegates · 2 running');
  });

  it('puts a delegate waiting on the human ahead of busy ones', () => {
    // Nothing moves until somebody comes back, so that is the state to surface.
    expect(pillLabel({ waiting: 1, running: 3 })).toBe(
      'delegates · 1 waiting on you',
    );
  });
});

describe('directionCopy', () => {
  it('asks for an answer when a delegate asked something', () => {
    expect(directionCopy(true)).toEqual({
      placeholder: 'your answer',
      action: 'answer',
    });
  });

  it('offers to steer when nothing was asked', () => {
    expect(directionCopy(false)).toEqual({
      placeholder: 'steer this delegation',
      action: 'direct',
    });
  });
});

describe('describeAccount', () => {
  const base = {
    id: 'work',
    cli: 'claude',
    label: 'Work',
    auth: 'session',
    home: '/state/homes/claude/work',
    isDefault: false,
    createdAt: 0,
  } as const satisfies AccountSnapshot;

  it('names a login account', () => {
    expect(describeAccount(base)).toBe('login');
  });

  it('flags an API key whose credential is missing', () => {
    expect(describeAccount({ ...base, auth: 'api-key' })).toBe('api key');
    expect(
      describeAccount({
        ...base,
        auth: 'api-key',
        credentialConfigured: false,
      }),
    )
      .toBe('api key · credential missing');
  });

  it('names an endpoint account by its model and base URL', () => {
    expect(describeAccount({
      ...base,
      auth: 'endpoint',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-chat',
    })).toBe('endpoint · deepseek-chat @ https://api.deepseek.com/anthropic');
  });

  it('falls back to the base URL when an endpoint account names no model', () => {
    expect(
      describeAccount({
        ...base,
        auth: 'endpoint',
        baseUrl: 'https://x.example',
      }),
    )
      .toBe('endpoint · https://x.example');
  });
});

describe('activityTone', () => {
  it.each<[Activity, string]>([
    [{ type: 'notice', level: 'error', text: 'x' }, 'error'],
    [{ type: 'tool', name: 't', status: 'completed' }, 'completed'],
    [{ type: 'reasoning', text: 'x' }, 'reasoning'],
    [{ type: 'message', text: 'x' }, 'message'],
  ])('derives a tone for %o', (activity, expected) => {
    expect(activityTone(activity)).toBe(expected);
  });
});
