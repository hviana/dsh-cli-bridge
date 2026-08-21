import { describe, expect, it } from 'vitest';
import {
  activityKindLabel,
  activityTone,
  boundTailChars,
  describeAccount,
  describeActivity,
  describeDecision,
  describeDelegation,
  describeMerge,
  directionCopy,
  displayCommand,
  displayPath,
  foldTranscript,
  formatBytes,
  formatDuration,
  formatTokens,
  formatUsage,
  interestingDecisions,
  pillLabel,
  runElapsed,
  showsKindLabel,
  statusLabel,
  toolchainSourceLabel,
  toolOutcome,
} from '../../src/client/format.ts';
import type {
  AccountSnapshot,
  Activity,
  DecisionRecord,
  DelegationSnapshot,
  RunSnapshot,
  ToolchainStatus,
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
  });

  it('shows the tokens AND the cost, so neither delegate hides half of it', () => {
    expect(formatUsage({ cachedInputTokens: 5, costUsd: 0.0125 })).toBe(
      '5 cached · $0.0125',
    );
    expect(
      formatUsage({
        inputTokens: 4,
        cachedInputTokens: 58_626,
        outputTokens: 163,
        costUsd: 0.0752238,
      }),
    ).toBe('4 in · 58.6k cached · 163 out · $0.0752');
  });

  it('contributes no price when the delegate reports none', () => {
    expect(
      formatUsage({
        inputTokens: 30_027,
        cachedInputTokens: 25_088,
        outputTokens: 119,
      }),
    ).toBe('30.0k in · 25.1k cached · 119 out');
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
    expect(describeDelegation(base, 9000)).toBe('claude/work · 4.2s');
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
    expect(pillLabel({ waiting: 0, running: 0 })).toBe('Claude Code & Codex');
  });

  it('counts what is running', () => {
    expect(pillLabel({ waiting: 0, running: 2 })).toBe(
      'Claude Code & Codex · 2 running',
    );
  });

  it('puts a task waiting on the human ahead of busy ones', () => {
    // Nothing moves until somebody comes back, so that is the state to surface.
    expect(pillLabel({ waiting: 1, running: 3 })).toBe(
      'Claude Code & Codex · 1 waiting on you',
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
      placeholder: 'steer this task',
      action: 'steer',
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
      .toBe('api key · not configured');
  });

  it('names an endpoint account by its model and base URL', () => {
    expect(describeAccount({
      ...base,
      auth: 'endpoint',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-chat',
    })).toBe(
      'custom provider · deepseek-chat @ https://api.deepseek.com/anthropic',
    );
  });

  it('falls back to the base URL when an endpoint account names no model', () => {
    expect(
      describeAccount({
        ...base,
        auth: 'endpoint',
        baseUrl: 'https://x.example',
      }),
    )
      .toBe('custom provider · https://x.example');
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

describe('activityKindLabel', () => {
  it.each<[Activity['type'], string]>([
    ['message', 'message'],
    ['reasoning', 'thinking'],
    ['tool', 'tool'],
    ['file', 'file'],
    ['usage', 'usage'],
    ['notice', 'notice'],
  ])('labels %s', (type, expected) => {
    expect(activityKindLabel(type)).toBe(expected);
  });
});

describe('describeDecision', () => {
  const base = { round: 1, reason: 'x', at: 0 } as const;

  it.each<[DecisionRecord, string]>([
    [{ ...base, kind: 'resume', source: 'human' }, 'you answered'],
    [{ ...base, kind: 'resume', source: 'direction' }, 'you steered it'],
    [{ ...base, kind: 'resume', source: 'advisor' }, 'DeepSeek continued it'],
    [{ ...base, kind: 'resume', source: 'policy' }, 'it carried on'],
    [{ ...base, kind: 'finish', source: 'policy' }, 'it finished'],
  ])('describes %o', (decision, expected) => {
    expect(describeDecision(decision)).toBe(expected);
  });
});

describe('toolchainSourceLabel', () => {
  it.each<[ToolchainStatus['source'], string]>([
    ['managed', 'ready'],
    ['path', 'ready'],
    ['configured', 'custom'],
    ['missing', 'not ready'],
  ])('labels %s', (source, expected) => {
    expect(toolchainSourceLabel(source)).toBe(expected);
  });
});

describe('statusLabel', () => {
  it.each<[string, string]>([
    ['needs_direction', 'asks you'],
    ['awaiting-human', 'waiting on you'],
    ['running', 'running'],
    ['completed', 'completed'],
  ])('labels %s', (status, expected) => {
    expect(statusLabel(status)).toBe(expected);
  });
});

describe('foldTranscript', () => {
  it('folds one call reported twice into one row that fills in', () => {
    const activities: Activity[] = [
      { type: 'tool', id: 't1', name: 'Bash', status: 'started', detail: 'ls' },
      {
        type: 'tool',
        id: 't1',
        name: 'Bash',
        status: 'completed',
        exitCode: 0,
        output: 'a.ts',
      },
    ];
    expect(foldTranscript(activities)).toEqual([{
      key: '0-tool',
      activity: {
        type: 'tool',
        id: 't1',
        name: 'Bash',
        status: 'completed',
        detail: 'ls',
        exitCode: 0,
        output: 'a.ts',
      },
    }]);
  });

  it('keeps the command the call was started with', () => {
    const [row] = foldTranscript([
      {
        type: 'tool',
        id: 't1',
        name: 'command',
        status: 'started',
        detail: 'pnpm build',
      },
      { type: 'tool', id: 't1', name: 'command', status: 'failed' },
    ]);
    expect(row?.activity).toMatchObject({
      status: 'failed',
      detail: 'pnpm build',
    });
  });

  it('leaves unidentified calls apart, rather than merging strangers', () => {
    const rows = foldTranscript([
      { type: 'tool', name: 'Bash', status: 'started', detail: 'one' },
      { type: 'tool', name: 'Bash', status: 'started', detail: 'two' },
    ]);
    expect(rows).toHaveLength(2);
  });

  it('does not fold two different calls together', () => {
    const rows = foldTranscript([
      { type: 'tool', id: 'a', name: 'Bash', status: 'started' },
      { type: 'tool', id: 'b', name: 'Bash', status: 'started' },
    ]);
    expect(rows).toHaveLength(2);
  });

  it('takes the counters out of the conversation', () => {
    const rows = foldTranscript([
      { type: 'message', text: 'hi' },
      { type: 'usage', usage: { outputTokens: 3 } },
    ]);
    expect(rows.map((row) => row.activity.type)).toEqual(['message']);
  });

  it('preserves the order things first appeared in', () => {
    const rows = foldTranscript([
      { type: 'tool', id: 't1', name: 'Bash', status: 'started' },
      { type: 'message', text: 'between' },
      { type: 'tool', id: 't1', name: 'Bash', status: 'completed' },
      { type: 'file', path: '/repo/a.ts', change: 'add' },
    ]);
    expect(rows.map((row) => row.activity.type)).toEqual([
      'tool',
      'message',
      'file',
    ]);
  });

  it('gives every row a key of its own', () => {
    const rows = foldTranscript([
      { type: 'message', text: 'one' },
      { type: 'message', text: 'two' },
      { type: 'notice', level: 'info', text: 'three' },
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });
});

describe('displayPath', () => {
  it.each<[string, string | undefined, string]>([
    ['/repo/src/a.ts', '/repo', 'src/a.ts'],
    ['/repo/src/a.ts', '/repo/', 'src/a.ts'],
    ['/repo/src/a.ts', undefined, '/repo/src/a.ts'],
    ['/repo/src/a.ts', '', '/repo/src/a.ts'],
    ['/elsewhere/a.ts', '/repo', '/elsewhere/a.ts'],
    ['/repository/a.ts', '/repo', '/repository/a.ts'],
  ])('renders %s under %s', (path, root, expected) => {
    expect(displayPath(path, root)).toBe(expected);
  });

  it('reads a file activity relative to the workspace', () => {
    expect(
      describeActivity(
        { type: 'file', path: '/repo/a.ts', change: 'add' },
        '/repo',
      ),
    ).toBe('add a.ts');
  });
});

describe('formatTokens', () => {
  it.each<[number, string]>([
    [0, '0'],
    [42, '42'],
    [999, '999'],
    [1000, '1.0k'],
    [58_626, '58.6k'],
    [1_000_000, '1.0M'],
    [2_450_000, '2.5M'],
  ])('abbreviates %s', (tokens, expected) => {
    expect(formatTokens(tokens)).toBe(expected);
  });
});

describe('toolOutcome', () => {
  it('says nothing about a call that simply worked', () => {
    expect(toolOutcome({ type: 'tool', name: 'Bash', status: 'completed' }))
      .toBeUndefined();
    expect(
      toolOutcome({
        type: 'tool',
        name: 'command',
        status: 'completed',
        exitCode: 0,
      }),
    ).toBeUndefined();
  });

  it('reports the two states a watcher must not miss', () => {
    expect(toolOutcome({ type: 'tool', name: 'Bash', status: 'started' }))
      .toBe('running');
    expect(toolOutcome({ type: 'tool', name: 'Bash', status: 'failed' }))
      .toBe('failed');
    expect(
      toolOutcome({
        type: 'tool',
        name: 'command',
        status: 'completed',
        exitCode: 2,
      }),
    ).toBe('exit 2');
    expect(
      toolOutcome({
        type: 'tool',
        name: 'command',
        status: 'failed',
        exitCode: 127,
      }),
    ).toBe('exit 127');
  });
});

describe('displayCommand', () => {
  it.each<[string, string]>([
    ['/bin/bash -lc "printf \'hi\'"', "printf 'hi'"],
    ["bash -lc 'ls -1'", 'ls -1'],
    ['/usr/bin/sh -c "echo one"', 'echo one'],
    ["zsh -ic 'echo two'", 'echo two'],
  ])('peels the shell wrapper off %s', (detail, expected) => {
    expect(displayCommand(detail)).toBe(expected);
  });

  it.each<[string, string]>([
    ['npm test', 'npm test'],
    ['/repo/src/a.ts', '/repo/src/a.ts'],
    ["bash -lc ''", "bash -lc ''"],
    ['bash -lc "unbalanced\'', 'bash -lc "unbalanced\''],
  ])('leaves %s exactly as it came', (detail, expected) => {
    expect(displayCommand(detail)).toBe(expected);
  });
});

describe('showsKindLabel', () => {
  it('labels everything except prose', () => {
    expect(showsKindLabel('message')).toBe(false);
    for (
      const type of ['reasoning', 'tool', 'file', 'usage', 'notice'] as const
    ) {
      expect(showsKindLabel(type)).toBe(true);
    }
  });
});

/** One recorded decision, shaped for the filter under test. */
function decisionRecord(
  kind: DecisionRecord['kind'],
  round: number,
): DecisionRecord {
  return { round, source: 'policy', kind, reason: 'because', at: 0 };
}

describe('interestingDecisions', () => {
  it('drops the terminal decision the badge already states', () => {
    expect(interestingDecisions([decisionRecord('finish', 1)])).toEqual([]);
  });

  it('keeps what a person would want to audit', () => {
    const kept = interestingDecisions([
      decisionRecord('ask', 1),
      decisionRecord('resume', 2),
      decisionRecord('consult', 3),
      decisionRecord('finish', 4),
    ]);
    expect(kept.map((entry) => entry.kind)).toEqual([
      'ask',
      'resume',
      'consult',
    ]);
  });
});
