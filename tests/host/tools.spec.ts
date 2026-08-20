import { describe, expect, it } from 'vitest';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { registerTools } from '../../src/host/tools.ts';
import type { PermissionMode } from '../../src/shared/protocol.ts';
import { buildOperations, FakeContext } from '../support/host.ts';
import type { ProcessScript } from '../support/fakes.ts';
import type { UserQuestionsPort } from '../../src/runtime/inquiry.ts';
import type { LlmPort } from '../../src/runtime/advisor.ts';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';

const CLAUDE_DONE = [
  '{"type":"system","subtype":"init","session_id":"sess-1"}\n',
  '{"type":"result","is_error":false,"result":"Renamed 3 files.","session_id":"sess-1",' +
  '"usage":{"input_tokens":90,"output_tokens":12},"total_cost_usd":0.031}\n',
];

const NEEDS_DIRECTION = [
  '{"type":"system","subtype":"init","session_id":"sess-2"}\n',
  '{"type":"result","is_error":false,"session_id":"sess-2",' +
  '"result":"Renamed the module.\\nNEEDS_DIRECTION: Keep the old export as an alias?"}\n',
];

/** A tool registry that just collects definitions. */
class FakeTools {
  readonly registered = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): () => void {
    this.registered.set(definition.name, definition);
    return () => {
      this.registered.delete(definition.name);
    };
  }
}

function mount(options: {
  script?: (argv: readonly string[]) => ProcessScript;
  permission?: PermissionMode;
  adminTools?: boolean;
  withPolicy?: boolean;
  questions?: UserQuestionsPort;
  llm?: LlmPort;
  config?: Record<string, unknown>;
} = {}) {
  const built = buildOperations({
    script: options.script ??
      ((
        argv,
      ) => (argv.includes('--version')
        ? { stdout: ['1.0.0'] }
        : { stdout: CLAUDE_DONE })),
    config: {
      ...options.config,
      ...options.adminTools === undefined
        ? {}
        : { adminTools: options.adminTools },
    },
    ...options.questions === undefined ? {} : { questions: options.questions },
    ...options.llm === undefined ? {} : { llm: options.llm },
  });
  const tools = new FakeTools();
  const ctx = new FakeContext().provide('tools', tools);
  if (options.withPolicy !== false) {
    ctx.provide('sandboxPolicy', {
      resolve: () => ({
        mode: options.permission ?? 'workspace-write',
        workspaceRoot: '/repo',
      }),
    });
  }
  registerTools(ctx.asContext(), built.operations);
  return { ...built, ctx, tools };
}

/** A minimal execution context: identity, cancellation, and an optional agent. */
function execution(
  options: { session?: string; signal?: AbortSignal; route?: boolean } = {},
): ToolRunContext {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'cli_delegate',
    arguments: {},
    signal: options.signal ?? new AbortController().signal,
    token: Symbol('token'),
    deferContext: () => {},
    concludeTurn: () => {},
    ...options.session === undefined ? {} : {
      agent: {
        id: options.session,
        session: {},
        // The advisor asks on the session's own route, so a test that expects a
        // consultation has to give the session one.
        ...options.route === true
          ? { options: { provider: 'deepseek-official', model: 'deepseek-v4' } }
          : {},
      },
    },
  } as unknown as ToolRunContext;
}

/** Read a tool's rendered text for a canonical value. */
function renderText(
  tool: ToolDefinition,
  args: unknown,
  value: unknown,
): string {
  return tool.output.render(args, value as never)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

describe('registration', () => {
  it('registers the delegation surface, and the admin surface when enabled', () => {
    expect([...mount().tools.registered.keys()].toSorted())
      .toEqual([
        'cli_accounts',
        'cli_delegate',
        'cli_delegate_all',
        'cli_reply',
        'cli_toolchain',
      ]);
  });

  it('keeps the admin schemas out of the prompt when they are turned off', () => {
    expect([...mount({ adminTools: false }).tools.registered.keys()].toSorted())
      .toEqual(['cli_delegate', 'cli_delegate_all', 'cli_reply']);
  });

  it('unregisters everything when the plugin unloads', async () => {
    const { ctx, tools } = mount();
    await ctx.dispose();
    expect(tools.registered.size).toBe(0);
  });
});

describe('cli_delegate', () => {
  it('returns the summary, the usage, and the byte count it kept out of context', async () => {
    const { tools } = mount();
    const tool = tools.registered.get('cli_delegate')!;
    const value = await tool.execute(
      { prompt: 'Rename the parser.' },
      execution(),
    ) as Record<string, unknown>;
    expect(value).toMatchObject({
      delegation: 'd1',
      cli: 'claude',
      account: 'ambient',
      status: 'completed',
      summary: 'Renamed 3 files.',
      rounds: 1,
      usage: { inputTokens: 90, outputTokens: 12, costUsd: 0.031 },
      workspace: { mode: 'inline', path: '/repo', merge: 'not-required' },
    });
    expect(value['streamedBytes']).toBe(CLAUDE_DONE.join('').length);
  });

  it('never returns the transcript', async () => {
    const { tools } = mount();
    const tool = tools.registered.get('cli_delegate')!;
    const value = await tool.execute({ prompt: 'x' }, execution());
    expect(JSON.stringify(value)).not.toContain('"type":"result"');
  });

  it('inherits the session’s permission mode rather than choosing one', async () => {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one mount per mode
    for (
      const [permission, flag] of [
        ['read-only', 'dontAsk'],
        ['workspace-write', 'acceptEdits'],
        ['danger-full-access', 'bypassPermissions'],
      ] as const
    ) {
      const { tools, process } = mount({ permission });
      // oxlint-disable-next-line eslint/no-await-in-loop
      await tools.registered.get('cli_delegate')!.execute(
        { prompt: 'x' },
        execution(),
      );
      expect(process.spawns.at(-1)?.spec.argv.join(' ')).toContain(
        `--permission-mode ${flag}`,
      );
    }
  });

  it('falls back to the most restrictive mode when the harness has no policy seam', async () => {
    const { tools, process } = mount({ withPolicy: false });
    await tools.registered.get('cli_delegate')!.execute(
      { prompt: 'x' },
      execution(),
    );
    expect(process.spawns.at(-1)?.spec.argv.join(' ')).toContain(
      '--permission-mode dontAsk',
    );
  });

  it('runs in the session workspace, which the model cannot override', async () => {
    const { tools, process } = mount();
    const tool = tools.registered.get('cli_delegate')!;
    await tool.execute({ prompt: 'x' }, execution());
    expect(process.spawns.at(-1)?.spec.cwd).toBe('/repo');
    expect(Object.keys(tool.parameters['properties'] as object)).not.toContain(
      'cwd',
    );
  });

  it('fences the run to the calling session', async () => {
    const { tools, operations } = mount();
    await tools.registered.get('cli_delegate')!.execute(
      { prompt: 'x' },
      execution({ session: 'session-a' }),
    );
    expect(operations.runs.list('session-a')).toHaveLength(1);
    expect(operations.runs.list('session-b')).toHaveLength(0);
  });

  it('reports a direction request with the question the delegate asked', async () => {
    const { tools } = mount({ script: () => ({ stdout: NEEDS_DIRECTION }) });
    const tool = tools.registered.get('cli_delegate')!;
    const value = await tool.execute({ prompt: 'x' }, execution()) as Record<
      string,
      unknown
    >;
    expect(value).toMatchObject({
      status: 'needs_direction',
      summary: 'Renamed the module.',
      question: 'Keep the old export as an alias?',
    });
    expect(renderText(tool, { prompt: 'x' }, value)).toContain(
      'cli_reply(delegation: "d1"',
    );
  });

  it('reports a failure as a value, not a throw — the model has to read it', async () => {
    const { tools } = mount({
      script: () => ({ exitCode: 1, stderr: ['auth required'] }),
    });
    const value = await tools.registered.get('cli_delegate')!.execute({
      prompt: 'x',
    }, execution());
    expect(value).toMatchObject({
      status: 'failed',
      error: 'exited with code 1: auth required',
    });
  });

  it('reports an account that does not exist as a failed delegation, not a thrown call', async () => {
    // One bad account in a batch must not sink the delegations beside it, so an
    // unusable account is an outcome like any other failure.
    const { tools } = mount();
    const value = await tools.registered.get('cli_delegate')!
      .execute({ prompt: 'x', account: 'ghost' }, execution());
    expect(value).toMatchObject({
      status: 'failed',
      rounds: 0,
      error: 'no claude account named "ghost"',
    });
  });

  it('cancels the delegate when the tool call itself is cancelled', async () => {
    const control = new AbortController();
    const { tools, process } = mount({
      script: (
        argv,
      ) => (argv.includes('--print') ? { hold: true } : { stdout: ['1.0.0'] }),
    });
    const running = tools.registered.get('cli_delegate')!
      .execute({ prompt: 'x' }, execution({ signal: control.signal }));
    await new Promise((resolve) => setImmediate(resolve));
    control.abort();
    expect(await running).toMatchObject({ status: 'cancelled' });
    expect(process.spawns.at(-1)?.aborted).toBe(true);
  });

  it('describes the pending call as an execution card', () => {
    const view = mount().tools.registered.get('cli_delegate')!.presentCall?.({
      prompt: 'Fix the build\nthen test',
    });
    expect(view).toMatchObject({
      card: 'generic',
      kind: 'execute',
      title: 'Claude Code: Fix the build',
    });
  });

  it('renders a completed delegation without repeating its output', () => {
    const tool = mount().tools.registered.get('cli_delegate')!;
    const text = renderText(tool, { prompt: 'x' }, {
      delegation: 'd1',
      cli: 'claude',
      account: 'work',
      status: 'completed',
      summary: 'All done.',
      rounds: 2,
      durationMs: 4200,
      streamedBytes: 2048,
      directions: ['Keep the public API stable.'],
      decisions: [{
        round: 1,
        kind: 'resume',
        source: 'advisor',
        reason: 'more work remains',
      }],
      workspace: {
        mode: 'worktree',
        path: '/w/d1',
        branch: 'cli-bridge/d1',
        merge: 'merged',
      },
    });
    expect(text).toContain(
      'claude delegation d1 (work) completed in 4.2s over 2 rounds',
    );
    expect(text).toContain('All done.');
    expect(text).toContain('Keep the public API stable.');
    expect(text).toContain('round 1: resume by advisor');
    expect(text).toContain('merged back');
    expect(text).toContain(
      '2.0 KiB of delegate output streamed to the user interface',
    );
  });

  it.each(
    [
      ['failed', 'could not be merged and is still on cli-bridge/d1'],
      ['skipped', 'was not merged'],
      ['pending', 'is on cli-bridge/d1'],
    ] as const,
  )('reports a %p merge', (merge, expected) => {
    const tool = mount().tools.registered.get('cli_delegate')!;
    const text = renderText(tool, { prompt: 'x' }, {
      delegation: 'd1',
      status: 'completed',
      workspace: {
        mode: 'worktree',
        path: '/w/d1',
        branch: 'cli-bridge/d1',
        merge,
      },
    });
    expect(text).toContain(expected);
  });

  it('says the delegate reported no usage rather than inventing a zero', () => {
    const tool = mount().tools.registered.get('cli_delegate')!;
    expect(renderText(tool, { prompt: 'x' }, { delegation: 'd1', usage: {} }))
      .toContain('Delegate usage: not reported');
  });

  it('reports the work the delegate says is still left', () => {
    const tool = mount().tools.registered.get('cli_delegate')!;
    expect(
      renderText(tool, { prompt: 'x' }, {
        delegation: 'd1',
        nextSteps: 'wire the CLI',
      }),
    )
      .toContain('It says the remaining work is: wire the CLI');
  });

  it('scales the streamed byte count it kept out of context', () => {
    const tool = mount().tools.registered.get('cli_delegate')!;
    expect(
      renderText(tool, { prompt: 'x' }, {
        delegation: 'd1',
        streamedBytes: 3_000_000,
      }),
    )
      .toContain('2.9 MiB of delegate output');
  });

  it('names the branch that still holds work that could not be merged', () => {
    const tool = mount().tools.registered.get('cli_delegate')!;
    const text = renderText(tool, { prompt: 'x' }, {
      delegation: 'd1',
      status: 'completed',
      workspace: {
        mode: 'worktree',
        path: '/w/d1',
        branch: 'cli-bridge/d1',
        merge: 'conflict',
        detail: 'CONFLICT',
      },
    });
    expect(text).toContain('conflicts on merge and is still on cli-bridge/d1');
  });

  it('renders a value logged by an older version without throwing', () => {
    const tool = mount().tools.registered.get('cli_delegate')!;
    expect(() => renderText(tool, { prompt: 'x' }, {})).not.toThrow();
  });
});

describe('cli_delegate_all', () => {
  it('returns one delegation per task, in the order they were asked for', async () => {
    const { tools, operations } = mount();
    await operations.accounts.add({
      cli: 'claude',
      id: 'work',
      auth: 'session',
    });
    const value = await tools.registered.get('cli_delegate_all')!.execute({
      tasks: [
        { prompt: 'Build the auth stack.', account: 'work' },
        { prompt: 'Build the BI stack.' },
      ],
    }, execution()) as {
      delegations: { delegation: string; account: string }[];
    };
    expect(value.delegations.map((entry) => entry.delegation)).toEqual([
      'd1',
      'd2',
    ]);
    expect(value.delegations.map((entry) => entry.account)).toEqual([
      'work',
      'ambient',
    ]);
  });

  it('refuses an empty list rather than reporting a batch that did nothing', async () => {
    await expect(
      mount().tools.registered.get('cli_delegate_all')!.execute(
        { tasks: [] },
        execution(),
      ),
    )
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('describes the pending call by how many delegations it starts', () => {
    const view = mount().tools.registered.get('cli_delegate_all')!
      .presentCall?.({ tasks: [{ prompt: 'a' }, { prompt: 'b' }] });
    expect(view).toMatchObject({
      card: 'generic',
      kind: 'execute',
      title: '2 delegations in parallel',
    });
  });

  it('renders every delegation of a batch', () => {
    const tool = mount().tools.registered.get('cli_delegate_all')!;
    const text = renderText(tool, {}, {
      delegations: [
        {
          delegation: 'd1',
          cli: 'claude',
          status: 'completed',
          summary: 'auth done',
        },
        { delegation: 'd2', cli: 'codex', status: 'failed', error: 'boom' },
      ],
    });
    expect(text).toContain('claude delegation d1');
    expect(text).toContain('codex delegation d2');
    expect(text).toContain('Failed: boom');
  });

  it('renders a value logged by an older version without throwing', () => {
    const tool = mount().tools.registered.get('cli_delegate_all')!;
    expect(renderText(tool, {}, {})).toBe('No delegations ran.');
  });
});

describe('cli_reply', () => {
  it('resumes the delegate session of a settled delegation', async () => {
    const { tools, process } = mount();
    const first = await tools.registered.get('cli_delegate')!
      .execute({ prompt: 'x' }, execution()) as { delegation: string };
    const value = await tools.registered.get('cli_reply')!
      .execute(
        { delegation: first.delegation, message: 'Yes, keep it.' },
        execution(),
      );
    expect(value).toMatchObject({ status: 'completed', delegation: 'd2' });
    expect(process.spawns.at(-1)?.spec.argv.join(' ')).toContain(
      '--resume sess-1',
    );
  });

  it('refuses a delegation from another session', async () => {
    const { tools } = mount();
    const first = await tools.registered.get('cli_delegate')!
      .execute({ prompt: 'x' }, execution({ session: 'session-a' })) as {
        delegation: string;
      };
    await expect(tools.registered.get('cli_reply')!
      .execute(
        { delegation: first.delegation, message: 'hi' },
        execution({ session: 'session-b' }),
      ))
      .rejects.toMatchObject({ code: 'UNKNOWN_RUN' });
  });

  it('refuses a delegation nobody started', async () => {
    await expect(mount().tools.registered.get('cli_reply')!
      .execute({ delegation: 'd9', message: 'hi' }, execution()))
      .rejects.toMatchObject({ code: 'UNKNOWN_RUN' });
  });
});

/** A model that answers each consultation with one scripted reply. */
function fakeLlm(replies: readonly string[]) {
  const asked: GenerateOptions[] = [];
  const llm: LlmPort = {
    stream(generate: GenerateOptions): AsyncIterable<StreamChunk> {
      asked.push(generate);
      const reply = replies[asked.length - 1] ?? '';
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'text-delta',
            index: 0,
            text: reply,
          } satisfies StreamChunk;
        },
      };
    },
  };
  return { llm, asked };
}

describe('a delegate question, with autonomy on', () => {
  it('is answered by DeepSeek, on the session’s own route, and never reaches the user', async () => {
    const asked: string[] = [];
    const questions: UserQuestionsPort = {
      async ask(request) {
        asked.push(request.questions[0]?.question ?? '');
        return { answers: [] };
      },
    };
    const { llm, asked: consulted } = fakeLlm([
      '{"answer":"Yes, keep the alias."}',
    ]);
    let round = 0;
    const { tools, process } = mount({
      questions,
      llm,
      config: { autonomy: { decide: true } },
      script: (argv) => {
        if (argv.includes('--version')) return { stdout: ['1.0.0'] };
        round += 1;
        return { stdout: round === 1 ? NEEDS_DIRECTION : CLAUDE_DONE };
      },
    });
    const value = await tools.registered.get('cli_delegate')!
      .execute(
        { prompt: 'x' },
        execution({ session: 'session-a', route: true }),
      ) as Record<string, unknown>;

    expect(value).toMatchObject({ status: 'completed', rounds: 2 });
    expect(value['decisions']).toMatchObject([
      { round: 1, source: 'advisor', kind: 'resume' },
      { round: 2, source: 'policy', kind: 'finish' },
    ]);
    // The human was never troubled, and the delegate got the model's answer.
    expect(asked).toEqual([]);
    expect(consulted).toHaveLength(1);
    expect(process.spawns.at(-1)?.spec.stdio.stdin)
      .toMatchObject({ data: expect.stringContaining('Yes, keep the alias.') });
  });

  it('falls back to the user when the composition has no model to consult', async () => {
    const asked: string[] = [];
    const questions: UserQuestionsPort = {
      async ask(request) {
        asked.push(request.questions[0]?.question ?? '');
        return {
          answers: [{ id: request.questions[0]?.id ?? '', selected: ['Yes'] }],
        };
      },
    };
    let round = 0;
    const { tools } = mount({
      questions,
      config: { autonomy: { decide: true } },
      script: (argv) => {
        if (argv.includes('--version')) return { stdout: ['1.0.0'] };
        round += 1;
        return { stdout: round === 1 ? NEEDS_DIRECTION : CLAUDE_DONE };
      },
    });
    const value = await tools.registered.get('cli_delegate')!
      .execute(
        { prompt: 'x' },
        execution({ session: 'session-a', route: true }),
      );
    expect(asked).toEqual(['Keep the old export as an alias?']);
    expect(value).toMatchObject({ status: 'completed' });
  });
});

describe('a delegate question, with autonomy off', () => {
  it('goes to the user, and their answer resumes the delegate', async () => {
    const asked: string[] = [];
    const questions: UserQuestionsPort = {
      async ask(request) {
        asked.push(request.questions[0]?.question ?? '');
        return {
          answers: [{
            id: request.questions[0]?.id ?? '',
            selected: [],
            custom: 'Yes, keep the alias.',
          }],
        };
      },
    };
    let round = 0;
    const { tools, process } = mount({
      questions,
      script: (argv) => {
        if (argv.includes('--version')) return { stdout: ['1.0.0'] };
        round += 1;
        return { stdout: round === 1 ? NEEDS_DIRECTION : CLAUDE_DONE };
      },
    });
    const value = await tools.registered.get('cli_delegate')!
      .execute({ prompt: 'x' }, execution()) as Record<string, unknown>;
    expect(asked).toEqual(['Keep the old export as an alias?']);
    expect(value).toMatchObject({ status: 'completed', rounds: 2 });
    expect(value['decisions']).toMatchObject([
      { round: 1, kind: 'resume', source: 'human' },
      { round: 2, kind: 'finish', source: 'policy' },
    ]);
    expect(process.spawns.at(-1)?.spec.argv.join(' ')).toContain(
      '--resume sess-2',
    );
  });

  it('comes back for the model to answer when the harness cannot reach a user', async () => {
    const { tools } = mount({
      script: (
        argv,
      ) => (argv.includes('--version')
        ? { stdout: ['1.0.0'] }
        : { stdout: NEEDS_DIRECTION }),
    });
    const value = await tools.registered.get('cli_delegate')!.execute({
      prompt: 'x',
    }, execution());
    expect(value).toMatchObject({ status: 'needs_direction', rounds: 1 });
  });
});

describe('cli_accounts', () => {
  it('lists the ambient account of every delegate', async () => {
    const { tools } = mount();
    const value = await tools.registered.get('cli_accounts')!.execute({
      op: 'list',
    }, execution()) as {
      accounts: { id: string }[];
      message: string;
    };
    expect(value.accounts.map((account) => account.id)).toEqual([
      'ambient',
      'ambient',
    ]);
    expect(value.message).toContain('machine default');
  });

  it('adds, defaults and removes an account', async () => {
    const { tools, operations } = mount();
    const tool = tools.registered.get('cli_accounts')!;
    await tool.execute(
      { op: 'add', cli: 'claude', id: 'work', label: 'Work' },
      execution(),
    );
    expect(
      (await operations.accounts.list('claude')).map((account) => account.id),
    ).toEqual(['ambient', 'work']);
    await tool.execute(
      { op: 'set_default', cli: 'claude', id: 'ambient' },
      execution(),
    );
    expect(await operations.accounts.resolve('claude')).toBeUndefined();
    await tool.execute(
      { op: 'remove', cli: 'claude', id: 'work' },
      execution(),
    );
    expect(
      (await operations.accounts.list('claude')).map((account) => account.id),
    ).toEqual(['ambient']);
  });

  it('starts a sign-in the user finishes in the interface', async () => {
    const { tools, operations } = mount();
    const tool = tools.registered.get('cli_accounts')!;
    await tool.execute(
      { op: 'add', cli: 'codex', id: 'personal' },
      execution(),
    );
    const value = await tool.execute({
      op: 'login',
      cli: 'codex',
      id: 'personal',
    }, execution()) as {
      run?: string;
      message: string;
    };
    expect(value.run).toBe('codex-1');
    expect(value.message).toContain('sign-in started');
    expect(operations.runs.get('codex-1').interactive).toBe(true);
  });

  it('requires the arguments each operation needs', async () => {
    const tool = mount().tools.registered.get('cli_accounts')!;
    await expect(tool.execute({ op: 'add', id: 'work' }, execution())).rejects
      .toThrow(/cli is required/u);
    await expect(tool.execute({ op: 'add', cli: 'claude' }, execution()))
      .rejects.toThrow(/id is required/u);
  });
});

describe('cli_toolchain', () => {
  it('reports where each delegate came from', async () => {
    const value = await mount().tools.registered.get('cli_toolchain')!
      .execute({ op: 'status' }, execution()) as {
        toolchain: { cli: string; source: string }[];
      };
    expect(value.toolchain).toEqual([
      {
        cli: 'claude',
        source: 'path',
        version: '1.0.0',
        path: '/usr/bin/claude',
      },
      {
        cli: 'codex',
        source: 'path',
        version: '1.0.0',
        path: '/usr/bin/codex',
      },
    ]);
  });

  it('requires a delegate to install', async () => {
    await expect(
      mount().tools.registered.get('cli_toolchain')!.execute(
        { op: 'install' },
        execution(),
      ),
    )
      .rejects.toThrow(/cli is required/u);
  });

  it('surfaces an install failure', async () => {
    const { tools } = mount({
      script: (
        argv,
      ) => (argv.includes('install')
        ? { exitCode: 1, stderr: ['E404'] }
        : { stdout: ['1.0.0'] }),
    });
    await expect(
      tools.registered.get('cli_toolchain')!.execute({
        op: 'install',
        cli: 'claude',
      }, execution()),
    )
      .rejects.toMatchObject({ code: 'INSTALL_FAILED' });
  });
});
