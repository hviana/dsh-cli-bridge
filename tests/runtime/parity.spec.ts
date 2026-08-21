/**
 * Delegate parity.
 *
 * Every feature the delegation loop adds — rounds, resuming, the marker
 * protocol, autonomy, isolation, merging — has to behave identically whichever
 * CLI is behind it. The two delegates differ in their argv, their event streams
 * and where their final message lives, so each scenario here runs TWICE and
 * asserts on both projections.
 */
import { describe, expect, it } from 'vitest';
import type { CliId } from '../../src/shared/protocol.ts';
import {
  buildDelegation,
  ScriptedAdvisor,
  ScriptedHuman,
} from '../support/delegation.ts';
import type { SpawnRecord } from '../support/fakes.ts';

/** What each delegate looks like from the outside. */
const DELEGATES = [
  {
    cli: 'claude' as CliId,
    /** Recognises a task spawn, as opposed to a version probe. */
    isTask: (argv: readonly string[]) => argv.includes('--print'),
    /** How this delegate is told to continue a session. */
    resumeArgs: (session: string) => ['--resume', session],
    session: 'sess-1',
    /** A final message, in this delegate's own event vocabulary. */
    transcript: (text: string) => [
      `{"type":"result","is_error":false,"result":${
        JSON.stringify(text)
      },"session_id":"sess-1",` +
      '"usage":{"input_tokens":11,"output_tokens":3},"total_cost_usd":0.01}\n',
    ],
  },
  {
    cli: 'codex' as CliId,
    isTask: (argv: readonly string[]) => argv.includes('exec'),
    resumeArgs: (session: string) => ['exec', 'resume', session],
    session: 'th-1',
    transcript: (text: string) => [
      '{"type":"thread.started","thread_id":"th-1"}\n',
      `{"type":"item.completed","item":{"type":"agent_message","text":${
        JSON.stringify(text)
      }}}\n`,
      '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":3}}\n',
    ],
  },
] as const;

/** The task spawns of one run, in order. */
function tasks(
  spawns: readonly SpawnRecord[],
  delegate: typeof DELEGATES[number],
): readonly SpawnRecord[] {
  return spawns.filter((spawn) => delegate.isTask(spawn.spec.argv));
}

/** What one spawn was told on stdin. */
function promptOf(spawn: SpawnRecord | undefined): string {
  const stdin = spawn?.spec.stdio.stdin;
  return typeof stdin === 'object' && stdin !== null && 'data' in stdin
    ? String(stdin.data)
    : '';
}

describe.each(DELEGATES)('$cli', (delegate) => {
  it('reports the delegate’s own summary and usage, whatever the event vocabulary', async () => {
    const { delegation } = buildDelegation({
      request: { cli: delegate.cli },
      script: () => ({ stdout: delegate.transcript('Ported the parser.') }),
    });
    const snapshot = await delegation.run(new AbortController().signal);
    expect(snapshot.status).toBe('completed');
    expect(snapshot.end?.summary).toBe('Ported the parser.');
    expect(snapshot.usage).toMatchObject({ inputTokens: 11, outputTokens: 3 });
  });

  it('hands a question back deterministically, from the same marker', async () => {
    const { delegation } = buildDelegation({
      request: { cli: delegate.cli },
      script: () => ({
        stdout: delegate.transcript(
          'Renamed the module.\nNEEDS_DIRECTION: Keep the old export?',
        ),
      }),
    });
    const snapshot = await delegation.run(new AbortController().signal);
    expect(snapshot.status).toBe('needs_direction');
    expect(snapshot.end?.question).toBe('Keep the old export?');
    expect(snapshot.end?.summary).toBe('Renamed the module.');
  });

  it('resumes its own session for round two, in its own argv', async () => {
    const human = new ScriptedHuman(['Yes, keep it.']);
    const { delegation, process } = buildDelegation({
      request: { cli: delegate.cli },
      inquiry: human,
      script: (_argv, round) => ({
        stdout: round === 1
          ? delegate.transcript(
            'Renamed it.\nNEEDS_DIRECTION: Keep the old export?',
          )
          : delegate.transcript('Kept it.'),
      }),
    });
    const snapshot = await delegation.run(new AbortController().signal);

    expect(snapshot.status).toBe('completed');
    expect(snapshot.rounds).toHaveLength(2);
    expect(human.asked.map((inquiry) => inquiry.question)).toEqual([
      'Keep the old export?',
    ]);

    const second = tasks(process.spawns, delegate)[1];
    const argv = second?.spec.argv.join(' ') ?? '';
    expect(argv).toContain(delegate.resumeArgs(delegate.session).join(' '));
    expect(promptOf(second)).toContain('Yes, keep it.');
  });

  it('is carried on by the marker it declared, then stopped by the advisor', async () => {
    // One reply, for the ONE consultation this should need: the marker itself is
    // deterministic, so continuing on it costs no model request at all.
    const advisor = new ScriptedAdvisor(['{"finished":true}']);
    const { delegation, process } = buildDelegation({
      config: { autonomy: { continue: true } },
      request: { cli: delegate.cli },
      advisor,
      agentRoute: { provider: 'deepseek-official', model: 'deepseek-v4' },
      script: (_argv, round) => ({
        stdout: round === 1
          ? delegate.transcript(
            'Did the first half.\nNEXT_STEPS: wire the second half',
          )
          : delegate.transcript('All done.'),
      }),
    });
    const snapshot = await delegation.run(new AbortController().signal);

    expect(snapshot.rounds).toHaveLength(2);
    expect(
      snapshot.decisions.map((decision) =>
        `${decision.kind}:${decision.source}`
      ),
    )
      .toEqual(['resume:policy', 'finish:policy']);
    expect(advisor.asked.map((request) => request.topic)).toEqual(['continue']);

    const spawns = tasks(process.spawns, delegate);
    // The contract asked for the marker, and the declared work came back as the
    // instruction for the next round.
    expect(promptOf(spawns[0])).toContain('NEXT_STEPS:');
    expect(promptOf(spawns[1])).toContain('wire the second half');
    expect(snapshot.end?.summary).toBe('All done.');
  });

  it('is pushed on by the advisor when it declared nothing', async () => {
    const advisor = new ScriptedAdvisor([
      '{"finished":false,"instruction":"Add the tests."}',
      '{"finished":true}',
    ]);
    const { delegation, process } = buildDelegation({
      config: { autonomy: { continue: true } },
      request: { cli: delegate.cli },
      advisor,
      agentRoute: { provider: 'deepseek-official', model: 'deepseek-v4' },
      script: () => ({ stdout: delegate.transcript('Half of it is done.') }),
    });
    const snapshot = await delegation.run(new AbortController().signal);

    expect(snapshot.rounds).toHaveLength(2);
    expect(
      snapshot.decisions.map((decision) =>
        `${decision.kind}:${decision.source}`
      ),
    )
      .toEqual(['resume:advisor', 'finish:policy']);
    expect(promptOf(tasks(process.spawns, delegate)[1])).toContain(
      'Add the tests.',
    );
  });

  it('states the same contract to either delegate, whatever autonomy is set to', async () => {
    const { delegation, process } = buildDelegation({
      request: { cli: delegate.cli },
      script: () => ({ stdout: delegate.transcript('Done.') }),
    });
    await delegation.run(new AbortController().signal);
    const prompt = promptOf(tasks(process.spawns, delegate)[0]);
    expect(prompt).toContain('NEEDS_DIRECTION:');
    expect(prompt).toContain('NEXT_STEPS:');
  });

  it('takes a user direction over any automatic decision', async () => {
    const advisor = new ScriptedAdvisor([
      '{"answer":"the advisor would have said this"}',
    ]);
    const { delegation, directions, process } = buildDelegation({
      config: { autonomy: { decide: true } },
      request: { cli: delegate.cli },
      advisor,
      agentRoute: { provider: 'deepseek-official', model: 'deepseek-v4' },
      script: (_argv, round) => ({
        stdout: round === 1
          ? delegate.transcript('Waiting.\nNEEDS_DIRECTION: Which one?')
          : delegate.transcript('Done as directed.'),
      }),
    });
    directions.add('d1', 'user', 'Use the existing error type.');
    const snapshot = await delegation.run(new AbortController().signal);

    expect(snapshot.decisions[0]).toMatchObject({
      kind: 'resume',
      source: 'direction',
    });
    expect(promptOf(tasks(process.spawns, delegate)[1])).toContain(
      'Use the existing error type.',
    );
    // The model was never asked: the human had already spoken.
    expect(advisor.asked).toEqual([]);
  });

  it('runs in the workspace it was given, which is where an isolated delegation works', async () => {
    const { delegation, process } = buildDelegation({
      request: {
        cli: delegate.cli,
        workspace: {
          mode: 'worktree',
          path: '/state/worktrees/d1',
          branch: 'cli-bridge/d1',
          merge: 'pending',
        },
      },
      script: () => ({ stdout: delegate.transcript('Done.') }),
    });
    await delegation.run(new AbortController().signal);
    expect(tasks(process.spawns, delegate)[0]?.spec.cwd).toBe(
      '/state/worktrees/d1',
    );
  });

  it('stops its delegate when the caller cancels', async () => {
    const control = new AbortController();
    const { delegation, process } = buildDelegation({
      request: { cli: delegate.cli },
      script: () => ({ hold: true }),
    });
    const running = delegation.run(control.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    control.abort();
    const snapshot = await running;

    expect(snapshot.status).toBe('cancelled');
    expect(tasks(process.spawns, delegate).at(-1)?.aborted).toBe(true);
  });

  it('ends as failed, with the reason, when its delegate cannot run', async () => {
    const { delegation } = buildDelegation({
      request: { cli: delegate.cli },
      script: () => ({ exitCode: 1, stderr: ['not logged in'] }),
    });
    const snapshot = await delegation.run(new AbortController().signal);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.end?.error).toContain('not logged in');
  });
});
