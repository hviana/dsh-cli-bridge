import { describe, expect, it } from 'vitest';
import {
  CLI_COMMAND_HELP,
  parseCliCommand,
  registerCommand,
  renderModels,
  renderState,
} from '../../src/host/command.ts';
import { Config } from '../../src/config.ts';
import type {
  CommandDefinition,
  CommandInvocation,
} from '@deepseek-ai/dsh-commands';
import { buildOperations, FakeContext } from '../support/host.ts';

describe('parseCliCommand', () => {
  it.each(['', '   ', 'status'])('reads %p as a status request', (line) => {
    expect(parseCliCommand(line)).toEqual({ kind: 'status' });
  });

  it('prints help on request', () => {
    // Help is an answer, not a failure: rendering it as an error made asking
    // for it look like doing something wrong.
    expect(parseCliCommand('help')).toEqual({
      kind: 'text',
      message: CLI_COMMAND_HELP,
    });
  });

  it('lists the models of one delegate, or every delegate', () => {
    expect(parseCliCommand('models')).toEqual({ kind: 'models' });
    expect(parseCliCommand('models claude')).toEqual({
      kind: 'models',
      cli: 'claude',
    });
    expect(parseCliCommand('models codex')).toEqual({
      kind: 'models',
      cli: 'codex',
    });
  });

  it.each(
    [
      ['install claude', { op: 'toolchain.install', cli: 'claude' }],
      ['update codex', { op: 'toolchain.install', cli: 'codex' }],
      ['login claude work', { op: 'account.login', cli: 'claude', id: 'work' }],
      ['cancel claude-3', { op: 'run.cancel', run: 'claude-3' }],
      ['account remove codex ci', {
        op: 'account.remove',
        cli: 'codex',
        id: 'ci',
      }],
      ['account default codex ci', {
        op: 'account.default',
        cli: 'codex',
        id: 'ci',
      }],
      ['account add claude work', {
        op: 'account.add',
        cli: 'claude',
        id: 'work',
        auth: 'session',
      }],
      ['stop d2', { op: 'delegation.cancel', delegation: 'd2' }],
      ['auto decide on', { op: 'autonomy.set', switch: 'decide', on: true }],
      ['auto continue off', {
        op: 'autonomy.set',
        switch: 'continue',
        on: false,
      }],
      ['auto review on', { op: 'autonomy.set', switch: 'review', on: true }],
    ] as const,
  )('parses %p', (line, request) => {
    expect(parseCliCommand(line)).toEqual({ kind: 'control', request });
  });

  it('reads the api-key flag with and without a reference', () => {
    expect(parseCliCommand('account add claude ci --api-key')).toEqual({
      kind: 'control',
      request: { op: 'account.add', cli: 'claude', id: 'ci', auth: 'api-key' },
    });
    expect(parseCliCommand('account add claude ci --api-key WORK_KEY')).toEqual(
      {
        kind: 'control',
        request: {
          op: 'account.add',
          cli: 'claude',
          id: 'ci',
          auth: 'api-key',
          credentialRef: 'WORK_KEY',
        },
      },
    );
  });

  it('reads a label alongside other flags, in any order', () => {
    expect(parseCliCommand('account add claude ci --label Work --api-key K'))
      .toEqual({
        kind: 'control',
        request: {
          op: 'account.add',
          cli: 'claude',
          id: 'ci',
          auth: 'api-key',
          credentialRef: 'K',
          label: 'Work',
        },
      });
  });

  it('reads the endpoint flags for an endpoint account', () => {
    expect(parseCliCommand(
      'account add claude ds --endpoint https://api.deepseek.com/anthropic --token DEEPSEEK_API_KEY --model deepseek-chat',
    )).toEqual({
      kind: 'control',
      request: {
        op: 'account.add',
        cli: 'claude',
        id: 'ds',
        auth: 'endpoint',
        baseUrl: 'https://api.deepseek.com/anthropic',
        credentialRef: 'DEEPSEEK_API_KEY',
        model: 'deepseek-chat',
      },
    });
  });

  it('allows an endpoint account without a model', () => {
    expect(
      parseCliCommand(
        'account add claude ds --endpoint https://x.example --token K',
      ),
    ).toEqual({
      kind: 'control',
      request: {
        op: 'account.add',
        cli: 'claude',
        id: 'ds',
        auth: 'endpoint',
        baseUrl: 'https://x.example',
        credentialRef: 'K',
      },
    });
  });

  it('keeps a direction as the user wrote it, spaces and all', () => {
    expect(parseCliCommand('direct d1  Keep   the public API stable.  '))
      .toEqual({
        kind: 'control',
        request: {
          op: 'delegation.direct',
          delegation: 'd1',
          text: 'Keep   the public API stable.',
        },
      });
  });

  it('tolerates repeated whitespace', () => {
    expect(parseCliCommand('   install    codex  ')).toEqual({
      kind: 'control',
      request: { op: 'toolchain.install', cli: 'codex' },
    });
  });

  it.each([
    ['an unknown verb', 'frobnicate', /unknown subcommand/u],
    ['an unknown delegate', 'install gemini', /usage: \/cli install/u],
    ['a missing delegate', 'install', /usage: \/cli install/u],
    ['a login without an account', 'login claude', /usage: \/cli login/u],
    ['a cancel without a run', 'cancel', /usage: \/cli cancel/u],
    ['a direction without a delegation', 'direct', /usage: \/cli direct/u],
    ['a direction with nothing to say', 'direct d1', /usage: \/cli direct/u],
    ['a stop without a delegation', 'stop', /usage: \/cli stop/u],
    ['an unknown autonomy switch', 'auto everything on', /usage: \/cli auto/u],
    ['an autonomy switch with no state', 'auto decide', /usage: \/cli auto/u],
    [
      'an autonomy state that is neither',
      'auto decide maybe',
      /usage: \/cli auto/u,
    ],
    [
      'an unknown account action',
      'account rename claude work',
      /unknown account action/u,
    ],
    ['an unknown delegate for models', 'models gemini', /usage: \/cli models/u],
    [
      'an account action without an id',
      'account remove claude',
      /usage: \/cli account/u,
    ],
  ])('refuses %s', (_label, line, message) => {
    const parsed = parseCliCommand(line);
    expect(parsed.kind).toBe('error');
    expect(parsed.kind === 'error' ? parsed.message : '').toMatch(message);
  });
});

describe('renderModels', () => {
  it('names the configured default and the deployment’s own ids', () => {
    const config = new Config({
      delegates: {
        claude: {
          defaultModel: 'claude-sonnet-5',
          extraModels: ['deepseek-chat'],
        },
      },
    });
    const text = renderModels(config, 'claude');
    expect(text).toContain('claude-opus-5');
    expect(text).toContain('deepseek-chat');
    expect(text).toContain('(no model named: claude-sonnet-5)');
    // One delegate's listing stays one delegate's listing.
    expect(text).not.toContain('gpt-5.6');
  });
});

describe('renderState', () => {
  it('shows delegates, accounts and runs, marking the default account', async () => {
    const { operations } = buildOperations({
      script: (
        argv,
      ) => (argv.includes('--version')
        ? { stdout: ['2.0.0'] }
        : { stdout: [] }),
    });
    await operations.accounts.add({
      cli: 'claude',
      id: 'work',
      label: 'Work seat',
      auth: 'session',
    });
    const text = renderState(await operations.state());
    expect(text).toContain('Claude Code: ready 2.0.0');
    expect(text).toContain('* claude/work — Claude Code login');
    expect(text).toContain('No runs yet.');
    expect(text).toContain('Autonomy: off');
  });

  it('names the automatic decisions the user switched on', async () => {
    const { operations } = buildOperations({
      script: () => ({ stdout: ['2.0.0'] }),
    });
    operations.setAutonomy('decide', true);
    operations.setAutonomy('review', true);
    expect(renderState(await operations.state())).toContain(
      'Autonomy: decide, review',
    );
  });

  it('shows a delegation with what it is waiting for and where its work is', async () => {
    const { operations } = buildOperations({
      script: () => ({ stdout: ['2.0.0'] }),
    });
    const state = await operations.state();
    const text = renderState({
      ...state,
      delegations: [{
        id: 'd1',
        batch: 'b1',
        label: 'port the parser',
        cli: 'claude',
        account: 'work',
        permission: 'workspace-write',
        status: 'awaiting-human',
        rounds: ['claude-1'],
        workspace: {
          mode: 'worktree',
          path: '/w/d1',
          branch: 'cli-bridge/d1',
          merge: 'conflict',
          detail: 'CONFLICT',
        },
        directions: [{
          id: 'dir-1',
          origin: 'user',
          text: 'keep the API stable',
          at: 0,
        }],
        decisions: [],
        notes: [],
        question: {
          run: 'claude-1',
          question: 'keep the alias?',
          context: '',
          askedAt: 0,
        },
        startedAt: 0,
      }],
    });
    expect(text).toContain('d1 [awaiting-human] work — port the parser');
    expect(text).toContain('direction pending: keep the API stable');
    expect(text).toContain('waiting on you: keep the alias?');
    expect(text).toContain('cli-bridge/d1: conflict — CONFLICT');
  });
});

/** Register the command and hand back its definition. */
function mount() {
  const built = buildOperations({
    script: (
      argv,
    ) => (argv.includes('--version') ? { stdout: ['1.0.0'] } : { stdout: [] }),
  });
  const registered: CommandDefinition[] = [];
  const ctx = new FakeContext().provide('commands', {
    register(definition: CommandDefinition) {
      registered.push(definition);
      return () => {
        registered.length = 0;
      };
    },
  });
  registerCommand(ctx.asContext(), built.operations);
  return { ...built, ctx, definition: registered[0] };
}

const invocation = (rawInput: string): CommandInvocation => ({
  commandId: 'cmd-1',
  agent: { id: 'session-a' },
  rawInput,
  signal: new AbortController().signal,
} as unknown as CommandInvocation);

describe('the /cli command', () => {
  it('registers itself as /cli', () => {
    expect(mount().definition).toMatchObject({ name: 'cli' });
  });

  it('is absent when the composition has no command registry', () => {
    const built = buildOperations();
    const ctx = new FakeContext();
    expect(() => registerCommand(ctx.asContext(), built.operations)).not
      .toThrow();
  });

  it('answers a bare invocation with the whole state', async () => {
    const { definition } = mount();
    const result = await definition!.handler(invocation(''));
    expect(result.kind).toBe('success');
    expect(result.kind === 'success' ? result.text : '').toContain('Accounts');
  });

  it('answers /cli models with the ids the delegates accept', async () => {
    const { definition } = mount();
    const result = await definition!.handler(invocation('models'));
    expect(result.kind).toBe('success');
    const text = result.kind === 'success' ? result.text : '';
    expect(text).toContain('claude-opus-5');
    expect(text).toContain('gpt-5.6-sol');
  });

  it('runs a control operation and answers with the refreshed state', async () => {
    const { definition, operations } = mount();
    const result = await definition!.handler(
      invocation('account add codex ci --label CI'),
    );
    expect(result.kind).toBe('success');
    expect(result.kind === 'success' ? result.text : '').toContain('codex/ci');
    expect(
      (await operations.accounts.list('codex')).map((account) => account.id),
    ).toContain('ci');
  });

  it('reports a refused operation as an error result', async () => {
    const { definition } = mount();
    const result = await definition!.handler(
      invocation('account remove codex ghost'),
    );
    expect(result).toEqual({
      kind: 'error',
      text: 'no codex account named "ghost"',
    });
  });

  it('reports a line that does not parse without touching anything', async () => {
    const { definition } = mount();
    const result = await definition!.handler(invocation('frobnicate'));
    expect(result.kind).toBe('error');
  });

  it('unregisters when the plugin unloads', async () => {
    const { ctx, definition } = mount();
    expect(definition).toBeDefined();
    await ctx.dispose();
  });
});
