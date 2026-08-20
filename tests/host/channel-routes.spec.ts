import { afterEach, describe, expect, it } from 'vitest';
import { registerChannelRoutes } from '../../src/host/channel-routes.ts';
import type { BridgeState, StreamFrame } from '../../src/shared/protocol.ts';
import {
  buildOperations,
  FakeCarrier,
  FakeContext,
  readEvents,
} from '../support/host.ts';

const CLAUDE_DONE = [
  '{"type":"system","subtype":"init","session_id":"sess-1"}\n',
  '{"type":"result","is_error":false,"result":"Done.","session_id":"sess-1"}\n',
];

interface Mounted {
  readonly url: string;
  readonly operations: ReturnType<typeof buildOperations>['operations'];
  readonly carrier: FakeCarrier;
  readonly close: () => Promise<void>;
}

const open: Mounted[] = [];

async function mount(
  options: Parameters<typeof buildOperations>[0] = {},
): Promise<Mounted> {
  const { operations } = buildOperations({
    script: () => ({ stdout: CLAUDE_DONE }),
    ...options,
  });
  const ctx = new FakeContext();
  const carrier = new FakeCarrier();
  ctx.provide('webServer', carrier);
  registerChannelRoutes(ctx.asContext(), operations, operations.config.channel);
  const server = await carrier.listen();
  const mounted: Mounted = {
    url: server.url,
    operations,
    carrier,
    close: async () => {
      await server.close();
      await ctx.dispose();
      await operations.dispose();
    },
  };
  open.push(mounted);
  return mounted;
}

afterEach(async () => {
  // oxlint-disable-next-line eslint/no-await-in-loop -- teardown is sequential
  for (const mounted of open.splice(0)) await mounted.close();
});

describe('mounting', () => {
  it('registers the three channel routes under the configured base path', async () => {
    const { carrier } = await mount();
    expect([...carrier.routes.keys()].toSorted()).toEqual([
      'exact /dsh-cli-bridge/control',
      'exact /dsh-cli-bridge/events',
      'exact /dsh-cli-bridge/state',
    ]);
  });

  it('honours a configured base path without a trailing slash', async () => {
    const { operations } = buildOperations();
    const ctx = new FakeContext();
    const carrier = new FakeCarrier();
    ctx.provide('webServer', carrier);
    registerChannelRoutes(ctx.asContext(), operations, {
      ...operations.config.channel,
      basePath: '/bridge/',
    });
    expect([...carrier.routes.keys()]).toContain('exact /bridge/events');
    await ctx.dispose();
  });

  it('mounts on the carrier under its other published name', async () => {
    const { operations } = buildOperations();
    const ctx = new FakeContext();
    const carrier = new FakeCarrier();
    ctx.provide('httpServer', carrier);
    registerChannelRoutes(
      ctx.asContext(),
      operations,
      operations.config.channel,
    );
    expect(carrier.routes.size).toBe(3);
    await ctx.dispose();
  });

  it('mounts once when a composition provides both names', async () => {
    const { operations } = buildOperations();
    const ctx = new FakeContext();
    const carrier = new FakeCarrier();
    ctx.provide('webServer', carrier).provide('httpServer', carrier);
    registerChannelRoutes(
      ctx.asContext(),
      operations,
      operations.config.channel,
    );
    expect(carrier.routes.size).toBe(3);
    await ctx.dispose();
  });

  it('mounts nothing when the channel is disabled', async () => {
    const { operations } = buildOperations();
    const ctx = new FakeContext();
    const carrier = new FakeCarrier();
    ctx.provide('webServer', carrier);
    registerChannelRoutes(ctx.asContext(), operations, {
      ...operations.config.channel,
      enabled: false,
    });
    expect(carrier.routes.size).toBe(0);
    await ctx.dispose();
  });

  it('mounts nothing when the composition has no HTTP carrier — a headless profile', async () => {
    const { operations } = buildOperations();
    const ctx = new FakeContext();
    expect(() =>
      registerChannelRoutes(
        ctx.asContext(),
        operations,
        operations.config.channel,
      )
    ).not.toThrow();
  });

  it('refuses to load with a malformed trusted authority', async () => {
    const { operations } = buildOperations();
    const ctx = new FakeContext();
    expect(() =>
      registerChannelRoutes(ctx.asContext(), operations, {
        ...operations.config.channel,
        trustedHosts: ['harness.internal/path'],
      })
    ).toThrow(/bare host/u);
  });
});

describe('telling the browser where the channel is', () => {
  it('leaves the index page alone on the default base path', async () => {
    const { carrier } = await mount();
    expect(carrier.indexTaps).toHaveLength(0);
  });

  it('injects the base path when a deployment moved the channel', async () => {
    const { operations } = buildOperations();
    const ctx = new FakeContext();
    const carrier = new FakeCarrier();
    ctx.provide('webServer', carrier);
    registerChannelRoutes(ctx.asContext(), operations, {
      ...operations.config.channel,
      basePath: '/bridge',
    });
    expect(carrier.renderIndex('<head><title>x</title></head>'))
      .toBe(
        '<head><title>x</title><script>globalThis.__DSH_CLI_BRIDGE_BASE__="/bridge"</script></head>',
      );
    await ctx.dispose();
  });

  it('escapes a path that would otherwise close the script element', async () => {
    const { operations } = buildOperations();
    const ctx = new FakeContext();
    const carrier = new FakeCarrier();
    ctx.provide('webServer', carrier);
    registerChannelRoutes(ctx.asContext(), operations, {
      ...operations.config.channel,
      basePath: '/x</script><script>alert(1)',
    });
    expect(carrier.renderIndex('<head></head>')).not.toContain(
      '</script><script>alert(1)',
    );
    await ctx.dispose();
  });
});

describe('the state route', () => {
  it('answers with runs, accounts and toolchain', async () => {
    const { url, operations } = await mount();
    await operations.accounts.add({
      cli: 'claude',
      id: 'work',
      auth: 'session',
    });
    const response = await fetch(`${url}/dsh-cli-bridge/state`);
    expect(response.status).toBe(200);
    const state = await response.json() as BridgeState;
    expect(state.accounts.map((account) => account.id)).toContain('work');
    expect(state.toolchain).toHaveLength(2);
    expect(state.runs).toEqual([]);
  });

  it('refuses a write', async () => {
    const { url } = await mount();
    const response = await fetch(`${url}/dsh-cli-bridge/state`, {
      method: 'PUT',
    });
    expect(response.status).toBe(405);
  });

  it('refuses a cross-site read', async () => {
    const { url } = await mount();
    const response = await fetch(`${url}/dsh-cli-bridge/state`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('forbidden');
  });
});

describe('the control route', () => {
  it('runs an operation and answers with the refreshed state', async () => {
    const { url } = await mount();
    const response = await fetch(`${url}/dsh-cli-bridge/control`, {
      method: 'POST',
      body: JSON.stringify({
        op: 'account.add',
        cli: 'codex',
        id: 'ci',
        auth: 'session',
      }),
    });
    const body = await response.json() as { ok: boolean; state: BridgeState };
    expect(body.ok).toBe(true);
    expect(
      body.state.accounts.some((account) =>
        account.cli === 'codex' && account.id === 'ci'
      ),
    ).toBe(true);
  });

  it('reports a refused operation as a message rather than a stack', async () => {
    const { url } = await mount();
    const response = await fetch(`${url}/dsh-cli-bridge/control`, {
      method: 'POST',
      body: JSON.stringify({ op: 'account.remove', cli: 'codex', id: 'ghost' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'no codex account named "ghost"',
    });
  });

  it('refuses a body that is not a control request', async () => {
    const { url } = await mount();
    const response = await fetch(`${url}/dsh-cli-bridge/control`, {
      method: 'POST',
      body: '"nope"',
    });
    expect(response.status).toBe(400);
  });

  it('refuses an oversized body', async () => {
    const { url } = await mount();
    const response = await fetch(`${url}/dsh-cli-bridge/control`, {
      method: 'POST',
      body: JSON.stringify({
        op: 'account.add',
        cli: 'codex',
        id: 'x',
        label: 'y'.repeat(100_000),
      }),
    });
    expect(response.status).toBe(413);
  });

  it('refuses a read', async () => {
    const { url } = await mount();
    expect((await fetch(`${url}/dsh-cli-bridge/control`)).status).toBe(405);
  });
});

describe('the events route', () => {
  it('streams a run from start to settlement', async () => {
    const { url, operations } = await mount();
    const response = await fetch(`${url}/dsh-cli-bridge/events`);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const started = await operations.startTask({
      cli: 'claude',
      prompt: 'do the thing',
      cwd: '/repo',
      permission: 'workspace-write',
    });
    await started.settled;

    const frames = await readEvents(
      response.body!,
      (collected) =>
        collected.some((frame) => (frame as StreamFrame).kind === 'end'),
    ) as StreamFrame[];

    expect(
      frames.some((frame) =>
        frame.kind === 'snapshot' && frame.snapshot.status === 'starting'
      ),
    ).toBe(true);
    expect(
      frames.some((frame) =>
        frame.kind === 'output' && frame.text.includes('"type":"result"')
      ),
    ).toBe(true);
    expect(frames.find((frame) => frame.kind === 'end')).toMatchObject({
      end: { status: 'completed', summary: 'Done.' },
    });
  });

  it('replays a run already in flight, scoped to that run', async () => {
    const { url, operations } = await mount();
    const started = await operations.startTask({
      cli: 'claude',
      prompt: 'first',
      cwd: '/repo',
      permission: 'workspace-write',
    });
    await started.settled;
    operations.hub.publish('other-run', {
      kind: 'output',
      pipe: 'stdout',
      text: 'not mine',
    });

    const response = await fetch(
      `${url}/dsh-cli-bridge/events?stream=${started.snapshot.id}`,
    );
    const frames = await readEvents(
      response.body!,
      (collected) =>
        collected.some((frame) => (frame as StreamFrame).kind === 'end'),
    ) as StreamFrame[];
    expect(frames.every((frame) => frame.stream === started.snapshot.id)).toBe(
      true,
    );
  });

  it('carries a delegation’s own snapshots on its own stream', async () => {
    const { url, operations } = await mount();
    const running = operations.startBatch({
      tasks: [{ cli: 'claude', prompt: 'Port the parser.' }],
      permission: 'workspace-write',
      base: '/repo',
      signal: new AbortController().signal,
    });
    const [entry] = await running;

    const response = await fetch(
      `${url}/dsh-cli-bridge/events?stream=${entry!.snapshot.id}`,
    );
    const frames = await readEvents(
      response.body!,
      (collected) =>
        collected.some((frame) =>
          (frame as StreamFrame).kind === 'delegation' &&
          ((frame as StreamFrame & { delegation: { status: string } })
            .delegation.status === 'completed')
        ),
    ) as StreamFrame[];

    // One stream per delegation, carrying the projection every surface reads.
    expect(frames.every((frame) => frame.stream === entry!.snapshot.id)).toBe(
      true,
    );
    expect(frames.every((frame) => frame.kind === 'delegation')).toBe(true);
    // The delegate's own transcript is on the ROUND's stream, never on this one.
    expect(JSON.stringify(frames)).not.toContain('Renamed');
  });

  it('answers with the delegations and the autonomy switches too', async () => {
    const { url, operations } = await mount();
    operations.setAutonomy('review', true);
    await operations.startBatch({
      tasks: [{ cli: 'claude', prompt: 'Port the parser.' }],
      permission: 'workspace-write',
      base: '/repo',
      signal: new AbortController().signal,
    });
    const state = await (await fetch(`${url}/dsh-cli-bridge/state`)).json() as {
      delegations: { id: string; status: string }[];
      autonomy: Record<string, boolean>;
    };
    expect(state.delegations.map((delegation) => delegation.id)).toEqual([
      'd1',
    ]);
    expect(state.autonomy).toEqual({
      decide: false,
      continue: false,
      review: true,
    });
  });

  it('resumes after a sequence number', async () => {
    const { url, operations } = await mount();
    for (const text of ['a', 'b', 'c']) {
      operations.hub.publish('claude-9', {
        kind: 'output',
        pipe: 'stdout',
        text,
      });
    }
    const response = await fetch(
      `${url}/dsh-cli-bridge/events?stream=claude-9&from=2`,
    );
    const frames = await readEvents(
      response.body!,
      (collected) => collected.length >= 1,
    ) as StreamFrame[];
    expect(frames[0]).toMatchObject({ seq: 3 });
  });

  it('resumes from the browser’s own Last-Event-ID header', async () => {
    const { url, operations } = await mount();
    for (const text of ['a', 'b']) {
      operations.hub.publish('claude-9', {
        kind: 'output',
        pipe: 'stdout',
        text,
      });
    }
    const response = await fetch(
      `${url}/dsh-cli-bridge/events?stream=claude-9`,
      {
        headers: { 'last-event-id': '1' },
      },
    );
    const frames = await readEvents(
      response.body!,
      (collected) => collected.length >= 1,
    ) as StreamFrame[];
    expect(frames[0]).toMatchObject({ seq: 2 });
  });

  it('refuses a cross-site subscription', async () => {
    const { url } = await mount();
    const response = await fetch(`${url}/dsh-cli-bridge/events`, {
      headers: { origin: 'http://evil.test' },
    });
    expect(response.status).toBe(403);
  });
});
