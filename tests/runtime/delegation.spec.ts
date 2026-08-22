import { describe, expect, it } from 'vitest';
import { DEFAULT_NEXT_STEPS_MARKER as NEXT } from '../../src/domain/markers.ts';
import type { AdviceRequest, Evidence } from '../../src/domain/advice.ts';
import type { AdvisorPort } from '../../src/runtime/advisor.ts';
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

  it('states both markers whatever autonomy is set to', async () => {
    // Asking for the declaration only while `autonomy.continue` happened to be
    // on made the same task report differently from one run to the next, for a
    // reason the delegate cannot see. Both markers are always asked for and
    // always parsed; autonomy decides whether to ACT on the declaration, and
    // the caller is told about it either way.
    const { delegation, process } = buildDelegation();
    await delegation.run(never);
    const stdin = process.spawns.at(-1)?.spec.stdio.stdin;
    expect(stdin).toMatchObject({
      data: expect.stringContaining('NEEDS_DIRECTION:'),
    });
    expect(stdin).toMatchObject({ data: expect.stringContaining(NEXT) });
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
      consult: async (): Promise<never> => {
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

  it('settles a timed-out round as resumable, with the session surfaced', async () => {
    const { delegation } = buildDelegation({
      config: { limits: { runTimeoutMs: 10 } },
      script: (argv) => (argv.includes('--print')
        ? {
          stdout: [
            '{"type":"system","subtype":"init","session_id":"s1"}\n',
          ],
          hold: true,
        }
        : { stdout: ['1.0.0'] }),
    });
    const settled = await delegation.run(never);
    expect(settled.status).toBe('timed_out');
    expect(settled.delegateSessionId).toBe('s1');
    expect(settled.end?.error).toContain('timed out after');
  });

  it('resumes a session by id when a continuation has no run to reply to', async () => {
    const { delegation, process } = buildDelegation({
      request: { resumeSession: 's1' },
    });
    const settled = await delegation.run(never);
    expect(settled.status).toBe('completed');
    expect(process.spawns.at(-1)?.spec.argv.join(' ')).toContain('--resume s1');
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

describe('an empty consultation', () => {
  it('says on the channel why no decision was made', async () => {
    // The delegation stops either way; what must not happen is stopping in
    // silence, which reads as DeepSeek shrugging at a question it was asked to
    // answer. The remedy is named because the cause is knowable.
    const advisor = new ScriptedAdvisor([''], 'max-tokens');
    const { delegation, frames } = buildDelegation({
      script: rounds('Renamed it.\nNEEDS_DIRECTION: Keep the alias?'),
      advisor,
      agentRoute: ROUTE,
      // The remedy is named only when a ceiling was actually configured: the
      // plugin imposes none of its own.
      config: { autonomy: { decide: true, advisor: { maxTokens: 512 } } },
    });
    const settled = await delegation.run(never);

    expect(settled.status).toBe('needs_direction');
    const notices = frames.flatMap((frame) =>
      frame.kind === 'activity' && frame.activity.type === 'notice'
        ? [frame.activity.text]
        : []
    );
    expect(notices.some((text) => text.includes('maxTokens'))).toBe(true);
    expect(notices.some((text) => text.includes('512 tokens'))).toBe(true);
  });

  it('names the route when the model simply had nothing to say', async () => {
    const advisor = new ScriptedAdvisor([''], 'stop');
    const { delegation, frames } = buildDelegation({
      script: rounds('Renamed it.\nNEEDS_DIRECTION: Keep the alias?'),
      advisor,
      agentRoute: ROUTE,
      config: { autonomy: { decide: true } },
    });
    await delegation.run(never);
    const notices = frames.flatMap((frame) =>
      frame.kind === 'activity' && frame.activity.type === 'notice'
        ? [frame.activity.text]
        : []
    );
    expect(
      notices.some((text) =>
        text.includes('deepseek-official/deepseek-v4') &&
        text.includes('no answer')
      ),
    ).toBe(true);
  });
});

describe('autonomy that cannot act says so before the first round', () => {
  it('warns when no model service exists to consult', async () => {
    // Autonomy "sometimes working" was this case in disguise: with no advisor in
    // the composition the delegation still runs, still completes, and still
    // reports — nothing in the outcome showed that the switch was inert. The
    // warning is on the record before round one, in the result and on the stream.
    const { delegation, frames } = buildDelegation({
      config: { autonomy: { decide: true } },
    });
    const settled = await delegation.run(never);

    expect(settled.status).toBe('completed');
    const note = settled.notes.find((entry) => entry.level === 'warn');
    expect(note?.text).toContain('autonomy.decide is on');
    expect(note?.text).toContain('no model service to consult');
    expect(
      frames.some((frame) =>
        frame.kind === 'activity' && frame.activity.type === 'notice' &&
        frame.activity.level === 'warn' &&
        frame.activity.text.includes('no model service')
      ),
    ).toBe(true);
  });

  it('warns, and names the remedy, when no route could be resolved', async () => {
    const advisor = new ScriptedAdvisor(['unused']);
    const { delegation } = buildDelegation({
      config: { autonomy: { decide: true } },
      advisor,
    });
    const settled = await delegation.run(never);

    expect(settled.status).toBe('completed');
    expect(advisor.asked).toEqual([]);
    const note = settled.notes.find((entry) => entry.level === 'warn');
    expect(note?.text).toContain('no model route could be resolved');
    expect(note?.text).toContain(
      'Set autonomy.advisor.provider and autonomy.advisor.model',
    );
  });

  it('names the route when autonomy can act', async () => {
    const advisor = new ScriptedAdvisor(['unused']);
    const { delegation } = buildDelegation({
      config: { autonomy: { decide: true } },
      advisor,
      agentRoute: ROUTE,
    });
    const settled = await delegation.run(never);

    // A consultation is only spent on a question, and the task raised none.
    expect(advisor.asked).toEqual([]);
    const note = settled.notes.find((entry) => entry.level === 'info');
    expect(note?.text).toContain(
      'decisions will be put to deepseek-official/deepseek-v4',
    );
  });

  it('reports the switches and the route with the outcome', async () => {
    const advisor = new ScriptedAdvisor(['unused']);
    const { delegation } = buildDelegation({
      config: { autonomy: { decide: true } },
      advisor,
      agentRoute: ROUTE,
    });
    const settled = await delegation.run(never);
    expect(settled.autonomy).toEqual({
      decide: true,
      continue: false,
      review: false,
      advisor: ROUTE,
    });
  });

  it('reports the switches alone when no route could be named', async () => {
    const { delegation } = buildDelegation({
      config: { autonomy: { decide: true, continue: true } },
    });
    const settled = await delegation.run(never);
    expect(settled.autonomy).toEqual({
      decide: true,
      continue: true,
      review: false,
    });
  });
});

describe('an answer that is not the asked-for JSON', () => {
  it('is read conservatively, and says so', async () => {
    // Prose instead of {"finished":…} is read as "finished" — the safe
    // reading — but that is indistinguishable from a genuine approval, so the
    // note is what tells the caller the arbiter never actually answered.
    const advisor = new ScriptedAdvisor(['looks done to me']);
    const { delegation } = buildDelegation({
      config: { autonomy: { continue: true } },
      advisor,
      agentRoute: ROUTE,
    });
    const settled = await delegation.run(never);

    expect(settled.rounds).toHaveLength(1);
    expect(settled.status).toBe('completed');
    const note = settled.notes.find((entry) => entry.level === 'warn');
    expect(note?.text).toContain('something other than the requested JSON');
    expect(note?.text).toContain('looks done to me');
  });
});

describe('an empty consultation with no configured ceiling', () => {
  it('does not invent a budget to blame', async () => {
    // Nothing to raise: the plugin imposed no cap, so the notice reports what
    // happened instead of prescribing a setting that is not in play.
    const advisor = new ScriptedAdvisor([''], 'max-tokens');
    const { delegation, frames } = buildDelegation({
      script: rounds('Renamed it.\nNEEDS_DIRECTION: Keep the alias?'),
      advisor,
      agentRoute: ROUTE,
      config: { autonomy: { decide: true } },
    });
    await delegation.run(never);
    const notices = frames.flatMap((frame) =>
      frame.kind === 'activity' && frame.activity.type === 'notice'
        ? [frame.activity.text]
        : []
    );
    expect(notices.some((text) => text.includes('maxTokens'))).toBe(false);
    expect(
      notices.some((text) =>
        text.includes('no answer') && text.includes('max-tokens')
      ),
    ).toBe(true);
  });
});

describe('autonomy that loses its route mid-decision', () => {
  // The route is read live on every decision, so between the policy choosing
  // the model and the request itself it can vanish. The round must not settle
  // as if nothing was due: the decision is re-derived with fresh facts.
  //
  // `reads <= 2` survives the preflight read and the policy's own read, so the
  // loss happens exactly at the moment the consultation is about to run.
  const flapAfter = (reads: { count: number }) => () => {
    reads.count += 1;
    return reads.count <= 2 ? ROUTE : undefined;
  };

  it('re-derives and finishes as policy, with the loss on the record', async () => {
    const advisor = new ScriptedAdvisor(['']);
    const { delegation } = buildDelegation({
      advisor,
      defaultRoute: flapAfter({ count: 0 }),
      config: { autonomy: { continue: true } },
    });
    const settled = await delegation.run(never);

    expect(settled.status).toBe('completed');
    // The model was never actually asked: the consultation is abandoned the
    // moment its route is gone, so no empty reply gets recorded as one.
    expect(advisor.asked).toEqual([]);
    expect(settled.decisions.at(-1)).toMatchObject({
      source: 'policy',
      kind: 'finish',
    });
    const note = settled.notes.find((entry) => entry.level === 'warn');
    expect(note?.text).toContain('no model route could be resolved');
  });

  it('falls back to the human for a question the model lost its route to', async () => {
    const human = new ScriptedHuman(['keep it']);
    const advisor = new ScriptedAdvisor(['unused']);
    const { delegation } = buildDelegation({
      script: rounds(
        'Renamed it.\nNEEDS_DIRECTION: Keep the alias?',
        'Kept the alias.',
      ),
      advisor,
      inquiry: human,
      defaultRoute: flapAfter({ count: 0 }),
      config: { autonomy: { decide: true } },
    });
    const settled = await delegation.run(never);

    expect(human.asked).toHaveLength(1);
    expect(human.asked[0]?.question).toContain('Keep the alias?');
    expect(settled.decisions[0]).toMatchObject({ source: 'human' });
    expect(settled.status).toBe('completed');
    const note = settled.notes.find((entry) => entry.level === 'warn');
    expect(note?.text).toContain('no model route could be resolved');
  });

  it('a direction that interrupts a consultation is the decision, not a model failure', async () => {
    // The direction aborts the consultation, which then comes back empty — but
    // an interrupted ask is not the model "returning no answer". The record
    // shows the direction, and nothing may claim the model failed when it was
    // never given the chance.
    const asked: AdviceRequest[] = [];
    const advisor: AdvisorPort = {
      async consult(request, _target, signal) {
        asked.push(request);
        await new Promise<void>((resolve) => {
          if (signal?.aborted === true) resolve();
          else {signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });}
        });
        return { text: '' };
      },
    };
    const { delegation, directions } = buildDelegation({
      script: rounds(
        'Renamed it.\nNEEDS_DIRECTION: Keep the alias?',
        'Dropped the alias.',
      ),
      advisor,
      agentRoute: ROUTE,
      config: { autonomy: { decide: true } },
    });
    const running = delegation.run(never);
    await until(() => asked.length === 1);
    directions.add('d1', 'user', 'drop the alias');
    const settled = await running;

    expect(settled.status).toBe('completed');
    expect(settled.decisions[0]).toMatchObject({
      source: 'direction',
      message: 'drop the alias',
    });
    expect(
      settled.notes.some((note) => note.text.includes('returned no answer')),
    ).toBe(false);
  });
});

describe('a review a user direction interrupted', () => {
  it('does not consume the review slot, so the next round is still reviewed', async () => {
    // The review count used to tick when the consultation was RAISED, so a
    // direction landing during it spent the slot without any review happening —
    // and with `maxReviews: 1` the next completed round silently skipped the
    // review it was owed. A review counts once its verdict is actually used.
    let first = true;
    const asked: AdviceRequest[] = [];
    const advisor: AdvisorPort = {
      async consult(request, _target, signal) {
        asked.push(request);
        if (!first) return { text: '{"accepted":true}' };
        first = false;
        await new Promise<void>((resolve) => {
          if (signal?.aborted === true) resolve();
          else {signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });}
        });
        return { text: '' };
      },
    };
    const { delegation, directions } = buildDelegation({
      script: rounds('Done.', 'Dropped the alias.'),
      advisor,
      agentRoute: ROUTE,
      config: { autonomy: { review: true, maxReviews: 1 } },
    });
    const running = delegation.run(never);
    await until(() => asked.length === 1);
    directions.add('d1', 'user', 'drop the alias');
    const settled = await running;

    expect(settled.status).toBe('completed');
    expect(settled.decisions[0]).toMatchObject({
      source: 'direction',
      message: 'drop the alias',
    });
    // The second round was still reviewed, and the review's verdict is the
    // last decision on the record.
    expect(asked).toHaveLength(2);
    expect(settled.decisions.at(-1)).toMatchObject({
      reason: expect.stringContaining('accepted'),
    });
  });
});

describe('a cancellation that lands on the final decision', () => {
  it('settles as cancelled and records no verdict nobody gave', async () => {
    // Cancelling while the last consultation was running used to settle the
    // delegation as completed, with "the session model accepted the work" on
    // the record — a verdict the model never gave, read from an aborted ask.
    const asked: AdviceRequest[] = [];
    const advisor: AdvisorPort = {
      async consult(request, _target, signal) {
        asked.push(request);
        await new Promise<void>((resolve) => {
          if (signal?.aborted === true) resolve();
          else {signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });}
        });
        return { text: '' };
      },
    };
    const control = new AbortController();
    const { delegation } = buildDelegation({
      advisor,
      agentRoute: ROUTE,
      config: { autonomy: { review: true } },
    });
    const running = delegation.run(control.signal);
    await until(() => asked.length === 1);
    control.abort();
    const settled = await running;

    expect(settled.status).toBe('cancelled');
    expect(settled.decisions).toEqual([]);
  });
});

describe('a direction that lands while the review gathers evidence', () => {
  it('gets through instead of waiting on the evidence', async () => {
    // Evidence comes from outside the loop — a `git diff --stat` — and cannot
    // be cancelled from in here. The wait is raced against the signal, so a
    // direction during the gathering is not stuck behind it.
    let evidenceStarted = false;
    let gathers = 0;
    const advisor = new ScriptedAdvisor(['{"accepted":true}']);
    const { delegation, directions } = buildDelegation({
      script: rounds('Done.', 'Dropped the alias.'),
      advisor,
      agentRoute: ROUTE,
      config: { autonomy: { review: true } },
      evidence: () => {
        evidenceStarted = true;
        gathers += 1;
        return gathers === 1
          ? new Promise<Evidence>(() => {})
          : Promise.resolve({ files: [] });
      },
    });
    const running = delegation.run(never);
    await until(() => evidenceStarted);
    directions.add('d1', 'user', 'drop the alias');
    const settled = await running;

    expect(settled.status).toBe('completed');
    expect(settled.decisions[0]).toMatchObject({
      source: 'direction',
      message: 'drop the alias',
    });
    // The round after the direction was reviewed as it should have been.
    expect(advisor.asked.at(-1)?.topic).toBe('review');
    expect(settled.decisions.at(-1)).toMatchObject({
      reason: expect.stringContaining('accepted'),
    });
  });
});

describe('a cancellation that lands before any round', () => {
  it('settles as cancelled, not as a failure with nothing to fix', async () => {
    // A stop that won the race against the first round used to settle with
    // "failed: the delegation spent no round" — an error that names a cause
    // which does not exist and invites a retry, when the one correct response
    // to a cancellation is to stop.
    const control = new AbortController();
    control.abort();
    const { delegation } = buildDelegation();
    const settled = await delegation.run(control.signal);
    expect(settled.status).toBe('cancelled');
    expect(settled.end).toMatchObject({ status: 'cancelled' });
    expect(settled.end?.error).toBeUndefined();
  });
});

describe('a cancellation between rounds', () => {
  it('keeps the round as it was and cancels the delegation', async () => {
    // The delegation's terminal state and the last round's own outcome are two
    // facts: a stop can land after a round completed, while its next decision
    // was still being made. The round completed; the delegation was cancelled.
    // The model-facing projection reads the DELEGATION's status, so both must
    // stay truthful here.
    let consults = 0;
    const advisor: AdvisorPort = {
      async consult(_request, _target, signal) {
        consults += 1;
        // The first consultation answers "not finished" so a second round
        // runs; the second one holds until the caller gives up.
        if (consults === 1) {
          return { text: '{"finished":false,"instruction":"finish it"}' };
        }
        await new Promise<void>((resolve) => {
          if (signal?.aborted === true) resolve();
          else {signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });}
        });
        return { text: '' };
      },
    };
    const control = new AbortController();
    const { delegation } = buildDelegation({
      script: rounds('First part done.', 'All done.'),
      advisor,
      agentRoute: ROUTE,
      config: { autonomy: { continue: true } },
    });
    const running = delegation.run(control.signal);
    await until(() => consults === 2);
    control.abort();
    const settled = await running;

    expect(settled.status).toBe('cancelled');
    expect(settled.end?.status).toBe('completed');
    expect(settled.end?.summary).toBe('All done.');
    // The round-1 continuation was decided BEFORE the stop, so it stays on the
    // record; what must not appear is a round-2 verdict nobody ever gave.
    expect(settled.decisions).toEqual([{
      round: 1,
      source: 'advisor',
      kind: 'resume',
      reason: 'the session model found declared work remaining',
      message: expect.any(String),
      at: expect.any(Number),
    }]);
  });
});
