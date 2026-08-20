import { describe, expect, it } from 'vitest';
import {
  adapterFor,
  adapters,
  supportsEndpoint,
} from '../../src/domain/adapters/index.ts';
import type {
  CliAdapter,
  TaskPlanRequest,
} from '../../src/domain/adapters/index.ts';
import {
  CLI_IDS,
  EFFORT_LEVELS,
  type PermissionMode,
} from '../../src/shared/protocol.ts';

const account = { home: '/state/homes/claude/work' };

const baseRequest: TaskPlanRequest = {
  prompt: 'Refactor the parser.\nKeep the public API.',
  permission: 'workspace-write',
  cwd: '/repo',
  account,
};

const request = (patch: Partial<TaskPlanRequest> = {}): TaskPlanRequest => ({
  ...baseRequest,
  ...patch,
});

describe('adapter registry', () => {
  it('resolves one adapter per delegate id', () => {
    for (const id of CLI_IDS) expect(adapterFor(id).id).toBe(id);
    expect(adapters.map((adapter) => adapter.id)).toEqual([...CLI_IDS]);
  });
});

describe.each(
  adapters.map((adapter): [string, CliAdapter] => [adapter.id, adapter]),
)(
  'shared adapter contract: %s',
  (_id, adapter) => {
    it('never puts the prompt in argv', () => {
      const plan = adapter.planTask(request({ prompt: 'secret-prompt-token' }));
      expect(plan.argv.join(' ')).not.toContain('secret-prompt-token');
      expect(plan.stdin).toBe('secret-prompt-token');
    });

    it('binds the account home and tombstones an unused API key', () => {
      const plan = adapter.planTask(request());
      expect(plan.env[adapter.homeEnvVar]).toBe(account.home);
      expect(Object.hasOwn(plan.env, adapter.apiKeyEnvVar)).toBe(true);
      expect(plan.env[adapter.apiKeyEnvVar]).toBeUndefined();
    });

    it('passes an API key when the account carries one', () => {
      const plan = adapter.planTask(
        request({ account: { home: account.home, apiKey: 'sk-test' } }),
      );
      expect(plan.env[adapter.apiKeyEnvVar]).toBe('sk-test');
    });

    it('leaves the environment alone for the ambient account', () => {
      expect(adapter.planTask(request({ account: {} })).env).toEqual({});
    });

    it('adds only the key when the ambient account supplies one', () => {
      expect(adapter.planTask(request({ account: { apiKey: 'sk-amb' } })).env)
        .toEqual({ [adapter.apiKeyEnvVar]: 'sk-amb' });
    });

    it('omits model and effort flags when the call names none', () => {
      const argv = adapter.planTask(request()).argv.join(' ');
      expect(argv).not.toMatch(/--model|-m\b/u);
      expect(argv).not.toContain('effort');
    });

    it('passes the model through verbatim', () => {
      expect(adapter.planTask(request({ model: 'some-model-9' })).argv)
        .toContain('some-model-9');
    });

    it.each(EFFORT_LEVELS)('accepts effort %s', (effort) => {
      expect(adapter.planTask(request({ effort })).argv.join(' ')).toMatch(
        /effort/u,
      );
    });

    it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)(
      'maps the %s permission mode onto distinct flags',
      (permission: PermissionMode) => {
        const argv = adapter.planTask(request({ permission })).argv.join(' ');
        const others =
          (['read-only', 'workspace-write', 'danger-full-access'] as const)
            .filter((mode) => mode !== permission)
            .map((mode) =>
              adapter.planTask(request({ permission: mode })).argv.join(' ')
            );
        for (const other of others) expect(argv).not.toBe(other);
      },
    );

    it('appends deployment arguments after its own', () => {
      const argv =
        adapter.planTask(request({ extraArgs: ['--flag', 'value'] })).argv;
      expect(argv).toContain('--flag');
      expect(argv.indexOf('--flag')).toBeGreaterThan(0);
      expect(argv[argv.indexOf('--flag') + 1]).toBe('value');
    });

    it('plans a login that owns a terminal and carries no stdin', () => {
      const plan = adapter.planLogin({ account, cwd: '/repo' });
      expect(plan.stdin).toBeUndefined();
      expect(plan.env[adapter.homeEnvVar]).toBe(account.home);
    });

    it('plans an auth-status probe bound to the same home', () => {
      expect(
        adapter.planAuthStatus({ account, cwd: '/repo' })
          .env[adapter.homeEnvVar],
      ).toBe(account.home);
    });

    it('parses its own version output', () => {
      expect(adapter.parseVersion('2.1.234 (Claude Code)')).toBe('2.1.234');
      expect(adapter.parseVersion('codex-cli 0.55.1')).toBe('0.55.1');
      expect(adapter.parseVersion('command not found')).toBeUndefined();
    });

    it('starts a fresh decoder per run', () => {
      expect(adapter.decoder()).not.toBe(adapter.decoder());
    });
  },
);

describe('claude argv', () => {
  const claude = adapterFor('claude');

  it('runs headless with a streaming JSON transcript', () => {
    expect(claude.planTask(request()).argv).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
    ]);
  });

  it.each(
    [
      ['read-only', 'dontAsk'],
      ['workspace-write', 'acceptEdits'],
      ['danger-full-access', 'bypassPermissions'],
    ] as const,
  )('maps %s to --permission-mode %s', (permission, mode) => {
    const argv = claude.planTask(request({ permission })).argv;
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe(mode);
  });

  it('passes effort through unclamped', () => {
    const argv = claude.planTask(request({ effort: 'max' })).argv;
    expect(argv[argv.indexOf('--effort') + 1]).toBe('max');
  });

  it('resumes a delegate session', () => {
    const argv = claude.planTask(request({ resume: 'sess-1' })).argv;
    expect(argv[argv.indexOf('--resume') + 1]).toBe('sess-1');
  });
});

describe('codex argv', () => {
  const codex = adapterFor('codex');

  it('runs exec with a JSON event stream and the stdin prompt placeholder', () => {
    const argv = codex.planTask(request()).argv;
    expect(argv[0]).toBe('exec');
    expect(argv.at(-1)).toBe('-');
    expect(argv).toContain('--json');
    expect(argv).toContain('--skip-git-repo-check');
  });

  it.each(
    [
      ['read-only', ['--sandbox', 'read-only']],
      ['workspace-write', ['--sandbox', 'workspace-write']],
    ] as const,
  )(
    'maps %s onto %s and refuses to wait for an approver',
    (permission, expected) => {
      const argv = codex.planTask(request({ permission })).argv;
      expect(argv.join(' ')).toContain(expected.join(' '));
      expect(argv).toContain('approval_policy="never"');
    },
  );

  it('drops the sandbox and the approval gate together in full access', () => {
    const argv =
      codex.planTask(request({ permission: 'danger-full-access' })).argv;
    expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(argv).not.toContain('--sandbox');
    expect(argv.join(' ')).not.toContain('approval_policy');
  });

  it('clamps max effort onto the highest level codex accepts', () => {
    expect(codex.planTask(request({ effort: 'max' })).argv).toContain(
      'model_reasoning_effort="xhigh"',
    );
    expect(codex.planTask(request({ effort: 'high' })).argv).toContain(
      'model_reasoning_effort="high"',
    );
  });

  it('resumes with the exec resume verb before its flags', () => {
    const argv = codex.planTask(request({ resume: 'thread-9' })).argv;
    expect(argv.slice(0, 3)).toEqual(['exec', 'resume', 'thread-9']);
    expect(argv.at(-1)).toBe('-');
  });

  it('selects API-key auth only when a key is present', () => {
    expect(codex.planTask(request()).argv.join(' ')).not.toContain(
      'preferred_auth_method',
    );
    expect(
      codex.planTask(request({ account: { home: account.home, apiKey: 'sk' } }))
        .argv,
    )
      .toContain('preferred_auth_method="apikey"');
  });
});

describe('endpoint binding', () => {
  it('redirects claude to a provider by base URL and token', () => {
    const plan = adapterFor('claude').planTask(request({
      account: {
        home: account.home,
        baseUrl: 'https://api.deepseek.com/anthropic',
        authToken: 'ds-key',
      },
    }));
    expect(plan.env['ANTHROPIC_BASE_URL']).toBe(
      'https://api.deepseek.com/anthropic',
    );
    expect(plan.env['ANTHROPIC_AUTH_TOKEN']).toBe('ds-key');
  });

  it('tombstones the endpoint variables for an isolated claude account', () => {
    const plan = adapterFor('claude').planTask(request());
    expect(Object.hasOwn(plan.env, 'ANTHROPIC_BASE_URL')).toBe(true);
    expect(Object.hasOwn(plan.env, 'ANTHROPIC_AUTH_TOKEN')).toBe(true);
    expect(plan.env['ANTHROPIC_BASE_URL']).toBeUndefined();
    expect(plan.env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
  });

  it('keeps the endpoint variables out of the ambient account', () => {
    expect(adapterFor('claude').planTask(request({ account: {} })).env).toEqual(
      {},
    );
  });

  it('declares endpoint support only where the CLI can be redirected', () => {
    expect(supportsEndpoint(adapterFor('claude'))).toBe(true);
    expect(supportsEndpoint(adapterFor('codex'))).toBe(false);
  });

  it('leaves codex without endpoint variables in its environment', () => {
    const plan = adapterFor('codex').planTask(request());
    expect(Object.hasOwn(plan.env, 'ANTHROPIC_BASE_URL')).toBe(false);
    expect(Object.hasOwn(plan.env, 'ANTHROPIC_AUTH_TOKEN')).toBe(false);
  });
});
