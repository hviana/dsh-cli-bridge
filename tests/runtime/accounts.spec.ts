import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AccountStore,
  AMBIENT_ACCOUNT_ID,
  describeAuth,
} from '../../src/runtime/accounts.ts';
import { adapterFor } from '../../src/domain/adapters/index.ts';
import { BridgeError } from '../../src/runtime/errors.ts';
import { BridgePaths } from '../../src/runtime/paths.ts';
import { fakeClock, MemoryFiles } from '../support/fakes.ts';

const paths = new BridgePaths('/state');

function build(secrets: Record<string, string> = {}) {
  const files = new MemoryFiles();
  const clock = fakeClock();
  const store = new AccountStore(paths, files, clock.now, {
    resolve: async (ref) => secrets[ref],
  });
  return { files, clock, store };
}

describe('the ambient account', () => {
  it('exists for every delegate before anything is configured', async () => {
    const { store } = build();
    const accounts = await store.list();
    expect(accounts.map((account) => [account.cli, account.id])).toEqual([
      ['claude', AMBIENT_ACCOUNT_ID],
      ['codex', AMBIENT_ACCOUNT_ID],
    ]);
    expect(accounts.every((account) => account.isDefault)).toBe(true);
  });

  it('resolves to no record, which binds to no environment', async () => {
    const { store } = build();
    const record = await store.resolve('claude');
    expect(record).toBeUndefined();
    expect(await store.bind('claude', record)).toEqual({});
  });

  it('cannot be added, removed, or given a home', async () => {
    const { store } = build();
    await expect(
      store.add({ cli: 'claude', id: AMBIENT_ACCOUNT_ID, auth: 'session' }),
    )
      .rejects.toMatchObject({ code: 'AMBIENT_ACCOUNT' });
    await expect(store.remove('claude', AMBIENT_ACCOUNT_ID))
      .rejects.toMatchObject({ code: 'AMBIENT_ACCOUNT' });
    expect(await store.prepareHome('claude', AMBIENT_ACCOUNT_ID))
      .toBeUndefined();
  });

  it('can be chosen as the default again', async () => {
    const { store } = build();
    await store.add({ cli: 'claude', id: 'work', auth: 'session' });
    await store.setDefault('claude', AMBIENT_ACCOUNT_ID);
    expect(await store.resolve('claude')).toBeUndefined();
  });
});

describe('adding accounts', () => {
  it('creates the private home and makes the first account the default', async () => {
    const { files, store } = build();
    await store.add({
      cli: 'claude',
      id: 'work',
      label: 'Work seat',
      auth: 'session',
    });
    expect(files.directories.has(join('/state', 'homes', 'claude', 'work')))
      .toBe(true);
    const [, work] = await store.list('claude');
    expect(work).toMatchObject({
      id: 'work',
      label: 'Work seat',
      isDefault: true,
      auth: 'session',
    });
  });

  it('does not steal the default from an existing account', async () => {
    const { store } = build();
    await store.add({ cli: 'claude', id: 'work', auth: 'session' });
    await store.add({ cli: 'claude', id: 'personal', auth: 'session' });
    const accounts = await store.list('claude');
    expect(accounts.find((account) => account.isDefault)?.id).toBe('work');
  });

  it('keeps each delegate’s accounts separate', async () => {
    const { store } = build();
    await store.add({ cli: 'claude', id: 'work', auth: 'session' });
    await store.add({ cli: 'codex', id: 'work', auth: 'session' });
    expect((await store.list('claude')).map((account) => account.id)).toEqual([
      AMBIENT_ACCOUNT_ID,
      'work',
    ]);
    expect((await store.list('codex')).map((account) => account.id)).toEqual([
      AMBIENT_ACCOUNT_ID,
      'work',
    ]);
  });

  it('refuses a duplicate id', async () => {
    const { store } = build();
    await store.add({ cli: 'claude', id: 'work', auth: 'session' });
    await expect(store.add({ cli: 'claude', id: 'work', auth: 'session' }))
      .rejects.toMatchObject({ code: 'DUPLICATE_ACCOUNT' });
  });

  it('refuses an id that is not a portable directory name', async () => {
    const { store } = build();
    await expect(store.add({ cli: 'claude', id: 'Work Seat', auth: 'session' }))
      .rejects.toMatchObject({ code: 'INVALID_ACCOUNT' });
  });

  it('defaults an API-key account to the CLI’s usual variable', async () => {
    const { store } = build({ ANTHROPIC_API_KEY: 'sk-live' });
    await store.add({ cli: 'claude', id: 'ci', auth: 'api-key' });
    const [, ci] = await store.list('claude');
    expect(ci).toMatchObject({
      credentialRef: 'ANTHROPIC_API_KEY',
      credentialConfigured: true,
    });
  });
});

describe('binding an account to a run', () => {
  it('pins the private home for a session account', async () => {
    const { store } = build();
    await store.add({ cli: 'claude', id: 'work', auth: 'session' });
    expect(await store.bind('claude', await store.resolve('claude', 'work')))
      .toEqual({ home: join('/state', 'homes', 'claude', 'work') });
  });

  it('resolves the credential for an API-key account', async () => {
    const { store } = build({ MY_KEY: 'sk-scoped' });
    await store.add({
      cli: 'codex',
      id: 'ci',
      auth: 'api-key',
      credentialRef: 'MY_KEY',
    });
    expect(await store.bind('codex', await store.resolve('codex', 'ci')))
      .toEqual({
        home: join('/state', 'homes', 'codex', 'ci'),
        apiKey: 'sk-scoped',
      });
  });

  it('refuses to run an API-key account whose credential is unset', async () => {
    const { store } = build();
    await store.add({ cli: 'codex', id: 'ci', auth: 'api-key' });
    await expect(store.bind('codex', await store.resolve('codex', 'ci')))
      .rejects.toMatchObject({ code: 'CREDENTIAL_MISSING' });
  });

  it('reports an unconfigured credential in the listing without failing', async () => {
    const { store } = build();
    await store.add({ cli: 'codex', id: 'ci', auth: 'api-key' });
    const [, ci] = await store.list('codex');
    expect(ci?.credentialConfigured).toBe(false);
  });
});

describe('endpoint accounts', () => {
  it('stores the endpoint, the token reference and the model', async () => {
    const { store } = build({ DEEPSEEK_API_KEY: 'ds' });
    await store.add({
      cli: 'claude',
      id: 'deepseek',
      auth: 'endpoint',
      baseUrl: 'https://api.deepseek.com/anthropic',
      credentialRef: 'DEEPSEEK_API_KEY',
      model: 'deepseek-chat',
    });
    const [, account] = await store.list('claude');
    expect(account).toMatchObject({
      auth: 'endpoint',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-chat',
      credentialRef: 'DEEPSEEK_API_KEY',
      credentialConfigured: true,
    });
  });

  it('binds the endpoint to a base URL and a resolved token', async () => {
    const { store } = build({ DEEPSEEK_API_KEY: 'ds-token' });
    await store.add({
      cli: 'claude',
      id: 'deepseek',
      auth: 'endpoint',
      baseUrl: 'https://api.deepseek.com/anthropic',
      credentialRef: 'DEEPSEEK_API_KEY',
    });
    expect(
      await store.bind('claude', await store.resolve('claude', 'deepseek')),
    ).toEqual({
      home: join('/state', 'homes', 'claude', 'deepseek'),
      baseUrl: 'https://api.deepseek.com/anthropic',
      authToken: 'ds-token',
    });
  });

  it('refuses an endpoint account without a base URL or a token', async () => {
    const { store } = build();
    await expect(
      store.add({
        cli: 'claude',
        id: 'x',
        auth: 'endpoint',
        credentialRef: 'K',
      }),
    )
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      store.add({
        cli: 'claude',
        id: 'x',
        auth: 'endpoint',
        baseUrl: 'https://api.deepseek.com/anthropic',
      }),
    )
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('refuses a base URL that is not http(s)', async () => {
    const { store } = build();
    await expect(store.add({
      cli: 'claude',
      id: 'x',
      auth: 'endpoint',
      baseUrl: 'ftp://nope',
      credentialRef: 'K',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('refuses an endpoint account for a delegate that cannot be redirected', async () => {
    const { store } = build();
    await expect(store.add({
      cli: 'codex',
      id: 'x',
      auth: 'endpoint',
      baseUrl: 'https://api.openai.com/v1',
      credentialRef: 'K',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('describes an endpoint account for the human', async () => {
    const { store } = build({ DEEPSEEK_API_KEY: 'ds' });
    await store.add({
      cli: 'claude',
      id: 'deepseek',
      auth: 'endpoint',
      baseUrl: 'https://api.deepseek.com/anthropic',
      credentialRef: 'DEEPSEEK_API_KEY',
      model: 'deepseek-chat',
    });
    const [, account] = await store.list('claude');
    expect(describeAuth(account!, adapterFor('claude')))
      .toBe(
        'deepseek-chat @ https://api.deepseek.com/anthropic (DEEPSEEK_API_KEY configured)',
      );
  });
});

describe('resolving accounts', () => {
  it('refuses an unknown name', async () => {
    const { store } = build();
    await expect(store.resolve('claude', 'ghost')).rejects.toMatchObject({
      code: 'UNKNOWN_ACCOUNT',
    });
  });

  it('says so when the missing account is the configured default', async () => {
    const { files, store } = build();
    await store.add({ cli: 'claude', id: 'work', auth: 'session' });
    // Simulate a registry whose default outlived its account.
    files.files.set(
      paths.registry,
      JSON.stringify({
        version: 1,
        accounts: [],
        defaults: { claude: 'work' },
      }),
    );
    const reloaded = new AccountStore(paths, files, fakeClock().now);
    await expect(reloaded.resolve('claude')).rejects.toThrow(
      /configured default/u,
    );
  });
});

describe('removing accounts', () => {
  let context: ReturnType<typeof build>;

  beforeEach(async () => {
    context = build();
    await context.store.add({ cli: 'claude', id: 'work', auth: 'session' });
  });

  it('deletes the home and the registry entry', async () => {
    await context.store.remove('claude', 'work');
    expect(
      context.files.directories.has(join('/state', 'homes', 'claude', 'work')),
    ).toBe(false);
    expect((await context.store.list('claude')).map((account) => account.id))
      .toEqual([AMBIENT_ACCOUNT_ID]);
  });

  it('hands the default back to the ambient account', async () => {
    await context.store.remove('claude', 'work');
    expect(await context.store.resolve('claude')).toBeUndefined();
  });

  it('refuses an unknown account', async () => {
    await expect(context.store.remove('claude', 'ghost')).rejects.toMatchObject(
      { code: 'UNKNOWN_ACCOUNT' },
    );
  });
});

describe('persistence', () => {
  it('survives a reload', async () => {
    const { files, store } = build();
    await store.add({ cli: 'claude', id: 'work', auth: 'session' });
    await store.setDefault('claude', 'work');
    const reloaded = new AccountStore(paths, files, fakeClock().now);
    expect((await reloaded.resolve('claude'))?.id).toBe('work');
  });

  it('records when an account last ran', async () => {
    const { clock, store } = build();
    await store.add({ cli: 'claude', id: 'work', auth: 'session' });
    clock.advance(5000);
    await store.touch('claude', 'work');
    const [, work] = await store.list('claude');
    expect(work?.lastUsedAt).toBe(clock.now());
  });

  it('ignores a touch of an account that is gone', async () => {
    const { store } = build();
    await expect(store.touch('claude', 'ghost')).resolves.toBeUndefined();
  });

  it.each([
    ['unreadable JSON', 'not json at all'],
    ['a JSON scalar', '42'],
    [
      'entries of the wrong shape',
      '{"version":1,"accounts":[{"id":5}],"defaults":null}',
    ],
  ])('starts empty rather than failing on %s', async (_label, contents) => {
    const files = new MemoryFiles();
    files.files.set(paths.registry, contents);
    const store = new AccountStore(paths, files, fakeClock().now);
    expect((await store.list('claude')).map((account) => account.id)).toEqual([
      AMBIENT_ACCOUNT_ID,
    ]);
  });
});

describe('describeAuth', () => {
  it('names each authentication style', async () => {
    const { store } = build({ ANTHROPIC_API_KEY: 'sk' });
    await store.add({ cli: 'claude', id: 'work', auth: 'session' });
    await store.add({ cli: 'claude', id: 'ci', auth: 'api-key' });
    const [ambient, work, ci] = await store.list('claude');
    const adapter = adapterFor('claude');
    expect(describeAuth(ambient!, adapter)).toBe('machine default');
    expect(describeAuth(work!, adapter)).toBe('Claude Code login');
    expect(describeAuth(ci!, adapter)).toBe('ANTHROPIC_API_KEY (configured)');
  });
});

describe('errors', () => {
  it('are all BridgeErrors, so surfaces can route on the code', async () => {
    const { store } = build();
    await expect(store.resolve('claude', 'ghost')).rejects.toBeInstanceOf(
      BridgeError,
    );
  });
});
