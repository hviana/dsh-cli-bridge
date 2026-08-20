import { describe, expect, it } from 'vitest';
import { adapterFor, adapters } from '../../src/domain/adapters/index.ts';
import type { DelegateDecoder } from '../../src/domain/adapters/index.ts';
import type { Activity } from '../../src/shared/protocol.ts';

/** Feed a transcript line by line and collect everything it produced. */
function drain(
  decoder: DelegateDecoder,
  transcript: readonly string[],
): Activity[] {
  return transcript.flatMap((line) => [...decoder.push(line)]);
}

describe.each(adapters.map((adapter) => [adapter.id, adapter] as const))(
  'decoder resilience: %s',
  (_id, adapter) => {
    it.each([
      ['a blank line', ''],
      ['human prose', 'Welcome to the CLI'],
      ['truncated JSON', '{"type":"assist'],
      ['a JSON array', '[1,2]'],
      ['an unknown event type', '{"type":"quantum.event","payload":1}'],
    ])('ignores %s without throwing', (_label, line) => {
      const decoder = adapter.decoder();
      expect(decoder.push(line)).toEqual([]);
      expect(decoder.state()).toEqual({});
    });

    it('reports an empty state before anything arrives', () => {
      expect(adapter.decoder().state()).toEqual({});
    });
  },
);

describe('claude decoder', () => {
  const transcript = [
    '{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-5"}',
    '{"type":"assistant","parent_tool_use_id":null,"message":{"content":[' +
    '{"type":"thinking","thinking":"weigh the options"},' +
    '{"type":"text","text":"Starting."},' +
    '{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}}]}}',
    '{"type":"user","parent_tool_use_id":null,"message":{"content":[' +
    '{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}',
    '{"type":"assistant","parent_tool_use_id":null,"message":{"content":[' +
    '{"type":"tool_use","id":"t2","name":"Write","input":{"file_path":"/repo/a.ts"}}]}}',
    '{"type":"assistant","parent_tool_use_id":"t9","message":{"content":[{"type":"text","text":"subagent chatter"}]}}',
    '{"type":"system","subtype":"api_retry","attempt":2,"error":"overloaded"}',
    '{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"s1",' +
    '"total_cost_usd":0.42,"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":50}}',
  ];

  it('projects the transcript onto the shared vocabulary', () => {
    const decoder = adapterFor('claude').decoder();
    expect(drain(decoder, transcript)).toEqual([
      { type: 'reasoning', text: 'weigh the options' },
      { type: 'message', text: 'Starting.' },
      { type: 'tool', name: 'Bash', status: 'started', detail: 'npm test' },
      { type: 'tool', name: 'Bash', status: 'completed' },
      { type: 'tool', name: 'Write', status: 'started', detail: '/repo/a.ts' },
      { type: 'file', path: '/repo/a.ts', change: 'add' },
      { type: 'notice', level: 'warn', text: 'API retry 2: overloaded' },
      {
        type: 'usage',
        usage: {
          inputTokens: 100,
          cachedInputTokens: 50,
          outputTokens: 20,
          costUsd: 0.42,
        },
      },
    ]);
  });

  it('accumulates the terminal facts', () => {
    const decoder = adapterFor('claude').decoder();
    drain(decoder, transcript);
    expect(decoder.state()).toEqual({
      finalMessage: 'Done.',
      delegateSessionId: 's1',
      usage: {
        inputTokens: 100,
        cachedInputTokens: 50,
        outputTokens: 20,
        costUsd: 0.42,
      },
    });
  });

  it('drops sub-agent prose, which the spawning tool call already represents', () => {
    const decoder = adapterFor('claude').decoder();
    const activities = drain(decoder, transcript);
    expect(
      activities.some((activity) =>
        activity.type === 'message' && activity.text === 'subagent chatter'
      ),
    ).toBe(false);
  });

  it('records a failed tool result', () => {
    const decoder = adapterFor('claude').decoder();
    decoder.push(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}',
    );
    expect(
      decoder.push(
        '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true}]}}',
      ),
    )
      .toEqual([{ type: 'tool', name: 'Bash', status: 'failed' }]);
  });

  it('names an unmatched tool result generically instead of throwing', () => {
    const decoder = adapterFor('claude').decoder();
    expect(
      decoder.push(
        '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"gone"}]}}',
      ),
    )
      .toEqual([{ type: 'tool', name: 'tool', status: 'completed' }]);
  });

  it('stays quiet while the account is not throttled', () => {
    const decoder = adapterFor('claude').decoder();
    expect(
      decoder.push(
        '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour"}}',
      ),
    )
      .toEqual([]);
  });

  it('reports a throttled account, which otherwise just looks slow', () => {
    const decoder = adapterFor('claude').decoder();
    expect(decoder.push(
      '{"type":"rate_limit_event","rate_limit_info":' +
        '{"status":"rejected","rateLimitType":"five_hour","resetsAt":1787238600}}',
    )).toEqual([{
      type: 'notice',
      level: 'warn',
      text:
        'rate limit rejected (five_hour window, resets at 2026-08-20T15:10:00.000Z)',
    }]);
  });

  it('reports a throttled account even without the detail fields', () => {
    const decoder = adapterFor('claude').decoder();
    expect(
      decoder.push(
        '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}',
      ),
    )
      .toEqual([{
        type: 'notice',
        level: 'warn',
        text: 'rate limit rejected',
      }]);
  });

  it('turns an errored result into a failure', () => {
    const decoder = adapterFor('claude').decoder();
    decoder.push(
      '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"credit exhausted"}',
    );
    expect(decoder.state().failure).toBe('credit exhausted');
  });

  it('falls back to the result subtype when an error carries no text', () => {
    const decoder = adapterFor('claude').decoder();
    decoder.push(
      '{"type":"result","subtype":"error_max_turns","is_error":true}',
    );
    expect(decoder.state().failure).toBe('error_max_turns');
  });
});

describe('codex decoder', () => {
  const transcript = [
    '{"type":"thread.started","thread_id":"th1"}',
    '{"type":"turn.started"}',
    '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"pnpm build","status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"pnpm build","exit_code":0,"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"i2","type":"file_change","status":"completed","changes":[' +
    '{"path":"/repo/a.ts","kind":"update"},{"path":"/repo/b.ts","kind":"add"}]}}',
    '{"type":"item.completed","item":{"id":"i3","type":"reasoning","text":"weigh the options"}}',
    '{"type":"item.completed","item":{"id":"i4","type":"web_search","query":"rolldown banner"}}',
    '{"type":"item.completed","item":{"id":"i5","type":"agent_message","text":"All set."}}',
    '{"type":"turn.completed","usage":{"input_tokens":4547,"cached_input_tokens":2432,"output_tokens":8}}',
  ];

  it('projects the transcript onto the shared vocabulary', () => {
    const decoder = adapterFor('codex').decoder();
    expect(drain(decoder, transcript)).toEqual([
      {
        type: 'tool',
        name: 'command',
        status: 'started',
        detail: 'pnpm build',
      },
      {
        type: 'tool',
        name: 'command',
        status: 'completed',
        detail: 'pnpm build',
        exitCode: 0,
      },
      { type: 'file', path: '/repo/a.ts', change: 'update' },
      { type: 'file', path: '/repo/b.ts', change: 'add' },
      { type: 'reasoning', text: 'weigh the options' },
      {
        type: 'tool',
        name: 'web_search',
        status: 'completed',
        detail: 'rolldown banner',
      },
      { type: 'message', text: 'All set.' },
      {
        type: 'usage',
        usage: { inputTokens: 4547, cachedInputTokens: 2432, outputTokens: 8 },
      },
    ]);
  });

  it('accumulates the terminal facts', () => {
    const decoder = adapterFor('codex').decoder();
    drain(decoder, transcript);
    expect(decoder.state()).toEqual({
      finalMessage: 'All set.',
      delegateSessionId: 'th1',
      usage: { inputTokens: 4547, cachedInputTokens: 2432, outputTokens: 8 },
    });
  });

  it('keeps the last agent message as the final one', () => {
    const decoder = adapterFor('codex').decoder();
    drain(decoder, [
      '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}',
    ]);
    expect(decoder.state().finalMessage).toBe('second');
  });

  it('records a failed turn', () => {
    const decoder = adapterFor('codex').decoder();
    expect(
      decoder.push(
        '{"type":"turn.failed","error":{"message":"model refused"}}',
      ),
    )
      .toEqual([{ type: 'notice', level: 'error', text: 'model refused' }]);
    expect(decoder.state().failure).toBe('model refused');
  });

  it('keeps the first failure when several are reported', () => {
    const decoder = adapterFor('codex').decoder();
    decoder.push('{"type":"error","message":"first"}');
    decoder.push('{"type":"error","message":"second"}');
    expect(decoder.state().failure).toBe('first');
  });

  it('names an MCP call by server and tool', () => {
    const decoder = adapterFor('codex').decoder();
    expect(
      decoder.push(
        '{"type":"item.completed","item":{"type":"mcp_tool_call","server":"fs","tool":"read","status":"failed"}}',
      ),
    )
      .toEqual([{ type: 'tool', name: 'fs.read', status: 'failed' }]);
  });

  it('summarizes a plan update instead of mirroring it', () => {
    const decoder = adapterFor('codex').decoder();
    expect(
      decoder.push(
        '{"type":"item.completed","item":{"type":"todo_list","items":[{"text":"a"},{"text":"b"}]}}',
      ),
    )
      .toEqual([{
        type: 'notice',
        level: 'info',
        text: 'plan updated (2 items)',
      }]);
  });
});
