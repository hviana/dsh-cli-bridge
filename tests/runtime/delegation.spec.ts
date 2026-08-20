import { describe, expect, it } from 'vitest';
import { DEFAULT_NEXT_STEPS_MARKER as NEXT } from '../../src/domain/markers.ts';
import {
  buildDelegation,
  ScriptedAdvisor,
  ScriptedHuman,
  transcript,
} from '../support/delegation.ts';
import { until } from '../support/fakes.ts';

const ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4' };
const never = new AbortController().signal;

/** A script that answers each round from a list of final messages. */
const rounds = (...messages: string[]) =>
(
  argv: readonly string[],
  round: number,
) => (argv.includes('--print')
  ? { stdout: transcript(messages[round - 1] ?? 'Done.') }
  : { stdout: ['1.0.0'] });

describe('the default: one round, nobody consulted', () => {
  it('runs once and reports', async () => {
    const { delegation } = buildDelegation();
    const settled = await delegation.run(never);
    expect(settled).toMatchObject({
      status: 'completed',
      rounds: ['claude-1'],
    });
    expect(settled.end?.summary).toBe('Done.');
  });

  it('records that a rule decided, and why', async () => {
    const { delegation } = buildDelegation();
    const settled = await delegation.run(never);
    expect(settled.decisions).toEqual([{
      round: 1,
      source: 'policy',
      kind: 'finish',
      reason: 'the delegate reported the work finished',
      at: expect.any(Number),
    }]);
  });

  it('publishes its own snapshots on its own stream', async () => {
    const { delegation, frames } = buildDelegation();
    await delegation.run(never);
    const mine = frames.filter((frame) =>
      frame.stream === 'd1' && frame.kind === 'delegation'
    );
    expect(mine.length).toBeGreaterThan(1);
    expect(mine.at(-1)).toMatchObject({ delegation: { status: 'completed' } });
  });

  it('does not state the next-steps marker while nothing would act on it', async () => {
    const { delegation, process } = buildDelegation();
    await delegation.run(never);
    const stdin = process.spawns.at(-1)?.spec.stdio.stdin;
    expect(stdin).toMatchObject({
      data: expect.stringContaining('NEEDS_DIRECTION:'),
    });
    expect(stdin).not.toMatchObject({ data: expect.stringContaining(NEXT) });
  });
});

describe('a question, with autonomy off', () => {
  const asking = rounds(
    'Renamed it.\nNEEDS_DIRECTION: Keep the alias?',
    'Kept the alias.',
  );

  it('asks the human and resumes with the answer', async () => {
    const human = new ScriptedHuman(['keep it']);
    const { delegation, process } = buildDelegation({
      script: asking,
      inquiry: human,
    });
    const settled = await delegation.run(never);

    expect(human.asked[0]).toMatchObject({
      question: 'Keep the alias?',
      context: 'Renamed it.',
    });
    expect(settled).toMatchObject({
      status: 'completed',
      rounds: ['claude-1', 'claude-2'],
    });
    expect(settled.decisions[0]).toMatchObject({
      source: 'human',
      kind: 'resume',
      message: 'keep it',
    });
    expect(process.spawns.at(-1)?.spec.argv.join(' ')).toContain('--resume s1');
  });

  it('shows the pending question while it waits, and clears it after', async () => {
    const human = new ScriptedHuman([], true);
    const { delegation, directions, frames } = buildDelegation({
      script: asking,
      inquiry: human,
    });
    const running = delegation.run(never);
    await until(() => delegation.state.status === 'awaiting-human');
    expect(delegation.state.question).toMatchObject({
      question: 'Keep the alias?',
    });
    expect(
      frames.some((frame) =>
        frame.kind === 'delegation' &&
        frame.delegation.status === 'awaiting-human'
      ),
    ).toBe(true);

    directions.add('d1', 'user', 'keep it');
    await running;
    expect(delegation.state.question).toBeUndefined();
  });

  it('reports the question to the caller when nobody can answer', async () => {
    const { delegation } = buildDelegation({ script: asking });
    const settled = await delegation.run(never);
    expect(settled).toMatchObject({
      status: 'needs_direction',
      rounds: ['claude-1'],
    });
    expect(settled.end?.question).toBe('Keep the alias?');
  });

  it('reports the question when the human declines to answer', async () => {
    const { delegation } = buildDelegation({
      script: asking,
      inquiry: new ScriptedHuman([undefined]),
    });
    expect(await delegation.run(never)).toMatchObject({
      status: 'needs_direction',
    });
  });

  it('honours inquiry.enabled = false without asking', async () => {
    const human = new ScriptedHuman(['keep it']);
    const { delegation } = buildDelegation({
      script: asking,
      inquiry: human,
      config: { inquiry: { enabled: false } },
    });
    expect(await delegation.run(never)).toMatchObject({
      status: 'needs_direction',
    });
    expect(human.asked).toEqual([]);
  });
});

describe('a user direction overrides everything', () => {
  it('is consumed before a question is even asked', async () => {
    const human = new ScriptedHuman(['from the human']);
    const { delegation, directions } = buildDelegation({
      script: rounds('Renamed it.\nNEEDS_DIRECTION: Keep the alias?', 'Done.'),
      inquiry: human,
    });
    directions.add('d1', 'user', 'drop the alias');
    const settled = await delegation.run(never);

    expect(human.asked).toEqual([]);
    expect(settled.decisions[0]).toMatchObject({
      source: 'direction',
      message: 'drop the alias',
    });
    expect(settled.directions[0]?.consumedRound).toBe(1);
  });

  it('interrupts a question already put to the human', async () => {
    const human = new ScriptedHuman([], true);
    const { delegation, directions } = buildDelegation({
      script: rounds(
        'Renamed it.\nNEEDS_DIRECTION: Keep the alias?',
        'Dropped it.',
      ),
      inquiry: human,
    });
    const running = delegation.run(never);
    await until(() => delegation.state.status === 'awaiting-human');
    directions.add('d1', 'user', 'drop the alias');
    const settled = await running;

    expect(settled.decisions[0]).toMatchObject({
      source: 'direction',
      message: 'drop the alias',
    });
    expect(settled.status).toBe('completed');
  });

  it('interrupts the model mid-decision', async () => {
    const advisor = new ScriptedAdvisor([
      '{"answer":"the model says keep it"}',
    ]);
    const { delegation, directions } = buildDelegation({
      script: rounds(
        'Renamed it.\nNEEDS_DIRECTION: Keep the alias?',
        'Dropped it.',
      ),
      advisor,
      agentRoute: ROUTE,
      config: { autonomy: { decide: true } },
    });
    directions.add('d1', 'user', 'drop the alias');
    const settled = await delegation.run(never);
    expect(settled.decisions[0]).toMatchObject({ source: 'direction' });
    expect(advisor.asked).toEqual([]);
  });

  it('is not consumed twice', async () => {
    const { delegation, directions } = buildDelegation({
      script: rounds(
        'One.\nNEEDS_DIRECTION: a?',
        'Two.\nNEEDS_DIRECTION: b?',
        'Three.',
      ),
      inquiry: new ScriptedHuman(['second answer']),
    });
    directions.add('d1', 'user', 'first direction');
    const settled = await delegation.run(never);
    expect(settled.decisions.map((decision) => decision.source)).toEqual([
      'direction',
      'human',
      'policy',
    ]);
  });
});

describe('autonomy.decide', () => {
  const config = { autonomy: { decide: true } };

  it('answers the delegate with the session model', async () => {
    const advisor = new ScriptedAdvisor(['{"answer":"keep it as an alias"}']);
    const { delegation } = buildDelegation({
      script: rounds(
        'Renamed it.\nNEEDS_DIRECTION: Keep the alias?',
        'Kept it.',
      ),
      advisor,
      agentRoute: ROUTE,
      config,
    });
    const settled = await delegation.run(never);
    expect(advisor.targets[0]).toEqual(ROUTE);
    expect(advisor.asked[0]?.topic).toBe('decide');
    expect(advisor.asked[0]?.prompt).toContain('Keep the alias?');
    expect(settled.decisions[0]).toMatchObject({
      source: 'advisor',
      message: 'keep it as an alias',
    });
    expect(settled.status).toBe('completed');
  });

  it('carries the standing directions into the decision', async () => {
    const advisor = new ScriptedAdvisor([
      '{"answer":"per the direction, drop it"}',
    ]);
    const { delegation, directions } = buildDelegation({
      script: rounds(
        'Renamed it.\nNEEDS_DIRECTION: Keep the alias?',
        'Dropped it.',
      ),
      advisor,
      agentRoute: ROUTE,
      config,
    });
    directions.add('d1', 'model', 'prefer a clean break');
    await delegation.run(never);
    expect(advisor.asked[0]?.prompt).toContain('prefer a clean break');
  });

  it('falls back to the human when the session has no route to consult', async () => {
    const human = new ScriptedHuman(['human answer']);
    const advisor = new ScriptedAdvisor(['unused']);
    const { delegation } = buildDelegation({
      script: rounds('Renamed it.\nNEEDS_DIRECTION: Keep the alias?', 'Done.'),
      advisor,
      inquiry: human,
      config,
    });
    await delegation.run(never);
    expect(advisor.asked).toEqual([]);
    expect(human.asked).toHaveLength(1);
  });

  it('finishes rather than looping when the model cannot be reached', async () => {
    const advisor = {
      consult: async (): Promise<string> => {
        throw new Error('no adapter');
      },
    };
    const { delegation, frames } = buildDelegation({
      script: rounds('Renamed it.\nNEEDS_DIRECTION: Keep the alias?'),
      advisor,
      agentRoute: ROUTE,
      config,
    });
    const settled = await delegation.run(never);
    expect(settled.status).toBe('needs_direction');
    expect(
      frames.some((frame) =>
        frame.kind === 'activity' && frame.activity.type === 'notice' &&
        frame.activity.text.includes('no adapter')
      ),
    )
      .toBe(true);
  });
});

describe('autonomy.continue', () => {
  const config = { autonomy: { continue: true } };

  it('states the next-steps marker in the contract', async () => {
    const { delegation, process } = buildDelegation({ config });
    await delegation.run(never);
    expect(process.spawns[0]?.spec.stdio.stdin).toMatchObject({
      data: expect.stringContaining(NEXT),
    });
  });

  it('continues from the marker without consulting anyone', async () => {
    const advisor = new ScriptedAdvisor(['{"finished":true}']);
    const { delegation } = buildDelegation({
      script: rounds(
        `Step one done.\n${NEXT} wire the router`,
        'Router wired.',
      ),
      advisor,
      agentRoute: ROUTE,
      config,
    });
    const settled = await delegation.run(never);
    // Round one's marker was free; only round two, which left none, was asked.
    expect(advisor.asked).toHaveLength(1);
    expect(settled.rounds).toHaveLength(2);
    expect(settled.decisions[0]).toMatchObject({
      source: 'policy',
      message: expect.stringContaining('wire the router'),
    });
  });

  it('judges every round, not just the first', async () => {
    const advisor = new ScriptedAdvisor([
      '{"finished":false,"instruction":"step two"}',
      '{"finished":false,"instruction":"step three"}',
      '{"finished":true}',
    ]);
    const { delegation } = buildDelegation({
      advisor,
      agentRoute: ROUTE,
      config,
    });
    const settled = await delegation.run(never);
    expect(settled.rounds).toHaveLength(3);
    expect(advisor.asked.map((request) => request.topic)).toEqual([
      'continue',
      'continue',
      'continue',
    ]);
  });

  it('asks the model when the delegate left no marker', async () => {
    const advisor = new ScriptedAdvisor([
      '{"finished":false,"instruction":"add the tests"}',
      '{"finished":true}',
    ]);
    const { delegation } = buildDelegation({
      script: rounds('Implemented it.', 'Tests added.'),
      advisor,
      agentRoute: ROUTE,
      config,
    });
    const settled = await delegation.run(never);
    expect(advisor.asked.map((request) => request.topic)).toEqual([
      'continue',
      'continue',
    ]);
    expect(settled.rounds).toHaveLength(2);
    expect(settled.decisions[0]).toMatchObject({
      source: 'advisor',
      message: expect.stringContaining('add the tests'),
    });
  });

  it('stops when the model says the work is finished', async () => {
    const advisor = new ScriptedAdvisor(['{"finished":true}']);
    const { delegation } = buildDelegation({
      advisor,
      agentRoute: ROUTE,
      config,
    });
    expect((await delegation.run(never)).rounds).toHaveLength(1);
  });
});

describe('autonomy.review', () => {
  const config = { autonomy: { review: true } };

  it('reviews the finished work and accepts it', async () => {
    const advisor = new ScriptedAdvisor(['{"accepted":true}']);
    const { delegation } = buildDelegation({
      advisor,
      agentRoute: ROUTE,
      config,
    });
    const settled = await delegation.run(never);
    expect(advisor.asked[0]?.topic).toBe('review');
    expect(settled.rounds).toHaveLength(1);
    expect(settled.decisions.at(-1)).toMatchObject({
      kind: 'finish',
      reason: expect.stringContaining('accepted'),
    });
  });

  it('sends the fixes back to the delegate', async () => {
    const advisor = new ScriptedAdvisor([
      '{"accepted":false,"fixes":"the migration is missing"}',
      '{"accepted":true}',
    ]);
    const { delegation } = buildDelegation({
      script: rounds('Implemented it.', 'Migration added.'),
      advisor,
      agentRoute: ROUTE,
      config,
    });
    const settled = await delegation.run(never);
    expect(settled.rounds).toHaveLength(2);
    expect(settled.decisions[0]).toMatchObject({
      source: 'advisor',
      message: expect.stringContaining('the migration is missing'),
    });
  });

  it('reviews against the task and the files the delegate touched', async () => {
    const advisor = new ScriptedAdvisor(['{"accepted":true}']);
    const { delegation } = buildDelegation({
      script: (argv, round) => (argv.includes('--print')
        ? {
          stdout: [
            '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write",' +
            '"input":{"file_path":"/repo/parser.ts"}}]}}\n',
            ...transcript(`Round ${String(round)} done.`),
          ],
        }
        : { stdout: ['1.0.0'] }),
      advisor,
      agentRoute: ROUTE,
      config,
    });
    await delegation.run(never);
    expect(advisor.asked[0]?.prompt).toContain('Port the parser.');
    expect(advisor.asked[0]?.prompt).toContain('/repo/parser.ts');
  });

  it('stops at the review budget instead of arguing forever', async () => {
    const advisor = new ScriptedAdvisor(
      Array.from({ length: 8 }, () => '{"accepted":false,"fixes":"again"}'),
    );
    const { delegation, config: resolved } = buildDelegation({
      advisor,
      agentRoute: ROUTE,
      config,
    });
    const settled = await delegation.run(never);
    expect(advisor.asked).toHaveLength(resolved.autonomy.maxReviews);
    expect(settled.status).toBe('completed');
  });
});

describe('bounds and failures', () => {
  it('never exceeds the round budget', async () => {
    const advisor = new ScriptedAdvisor(
      Array.from(
        { length: 20 },
        () => '{"finished":false,"instruction":"more"}',
      ),
    );
    const { delegation } = buildDelegation({
      advisor,
      agentRoute: ROUTE,
      config: { autonomy: { continue: true, maxRounds: 3 } },
    });
    const settled = await delegation.run(never);
    expect(settled.rounds).toHaveLength(3);
    expect(settled.decisions.at(-1)?.reason).toContain('budget');
  });

  it('stops at a failed round without consulting anyone', async () => {
    const advisor = new ScriptedAdvisor(['unused']);
    const { delegation } = buildDelegation({
      script: (
        argv,
      ) => (argv.includes('--print')
        ? { exitCode: 2, stderr: ['boom'] }
        : { stdout: ['1.0.0'] }),
      advisor,
      agentRoute: ROUTE,
      config: { autonomy: { decide: true, continue: true, review: true } },
    });
    const settled = await delegation.run(never);
    expect(settled.status).toBe('failed');
    expect(advisor.asked).toEqual([]);
  });

  it('stops when the caller cancels', async () => {
    const control = new AbortController();
    const { delegation } = buildDelegation({
      script: (
        argv,
      ) => (argv.includes('--print') ? { hold: true } : { stdout: ['1.0.0'] }),
    });
    const running = delegation.run(control.signal);
    await until(() => delegation.state.rounds.length === 1);
    control.abort();
    expect((await running).status).toBe('cancelled');
  });

  it('reports a round that could not even start', async () => {
    const { delegation } = buildDelegation({
      script: rounds('Done.'),
      request: { account: 'ghost' },
    });
    const settled = await delegation.run(never);
    expect(settled.status).toBe('failed');
    expect(settled.end?.error).toContain('ghost');
  });

  it('reports a delegate that left no session to resume', async () => {
    const { delegation } = buildDelegation({
      script: (argv) => (argv.includes('--print')
        ? {
          stdout: [
            '{"type":"result","is_error":false,"result":"Step one done."}\n',
          ],
        }
        : { stdout: ['1.0.0'] }),
      inquiry: new ScriptedHuman(['carry on']),
      config: { autonomy: { continue: true } },
      advisor: new ScriptedAdvisor([
        '{"finished":false,"instruction":"keep going"}',
      ]),
      agentRoute: ROUTE,
    });
    const settled = await delegation.run(never);
    expect(settled.status).toBe('failed');
    expect(settled.end?.error).toContain('resume');
  });
});
