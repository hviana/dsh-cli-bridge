/**
 * The Host → Web channel, as HTTP.
 *
 * Three routes on the harness's own web carrier, and the important one is a
 * Server-Sent Events stream that exists so delegate output can reach a human
 * without passing through a model request. It is deliberately NOT the harness's
 * `/api` bridge: that carries session events, which are durable and
 * model-visible, and a delegate's transcript must be neither.
 *
 * @module dsh-cli-bridge/host/channel-routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { ControlRequest, StreamFrame } from '../shared/protocol.ts';
import {
  CHANNEL_ROUTES,
  DEFAULT_BASE_PATH,
  FROM_QUERY_PARAM,
  STREAM_QUERY_PARAM,
} from '../shared/protocol.ts';
import type { ChannelConfig } from '../config.ts';
import { describeError } from '../runtime/errors.ts';
import type { BridgeOperations } from '../runtime/operations.ts';
import { assertTrustedAuthority, isTrustedRequest } from './trust.ts';

/** Largest control request body accepted, in bytes. */
const MAX_CONTROL_BODY_BYTES = 64 * 1024;

/** Interval between SSE keep-alive comments, in milliseconds. */
const KEEPALIVE_MS = 25_000;

/**
 * Service keys the harness has published its HTTP carrier under.
 *
 * The route contract is identical across both names; only the key changed
 * between harness releases. Accepting either is what keeps this plugin working
 * across a developer-preview rename instead of failing to mount its channel.
 */
const CARRIER_KEYS = ['webServer', 'httpServer'] as const;

/** The slice of the carrier this plugin uses. */
interface HttpCarrier {
  register(route: WebRoute): () => void;
  /** Present on carriers that let a plugin transform the served index page. */
  tapIndex?(transform: (html: string) => string): () => void;
}

/**
 * Global the browser half reads to find a non-default channel base path.
 *
 * Mirrors how the harness hands its own boot manifest to the shell: a tiny
 * script at the top of the page. It is injected ONLY when the configured path
 * differs from the protocol default, so an ordinary deployment's index page is
 * left exactly as the harness served it.
 */
const BASE_PATH_GLOBAL = '__DSH_CLI_BRIDGE_BASE__';

/**
 * Mount a callback on whichever HTTP carrier this composition provides.
 * @param ctx - the host plugin context.
 * @param mount - receives the injected scope and the carrier.
 */
function withCarrier(
  ctx: Context,
  mount: (scope: Context, carrier: HttpCarrier) => void,
): void {
  let mounted = false;
  for (const key of CARRIER_KEYS) {
    ctx.inject([key], (scope: Context) => {
      // Only one key exists in a given harness, but a composition that somehow
      // provided both must still mount exactly one channel.
      if (mounted) return;
      const carrier =
        (scope as unknown as Record<string, HttpCarrier | undefined>)[key];
      if (carrier === undefined) return;
      mounted = true;
      scope.effect(() => () => {
        mounted = false;
      }, 'cli-bridge: carrier claim');
      mount(scope, carrier);
    });
  }
}

/**
 * Mount the channel when the composition has a web carrier.
 *
 * A headless profile simply has no `ctx.webServer`, so the injection never
 * fires and the plugin runs without a channel — the model-facing surface does
 * not depend on it.
 * @param ctx - the host plugin context.
 * @param operations - the shared implementation.
 * @param config - the channel's configuration.
 */
export function registerChannelRoutes(
  ctx: Context,
  operations: BridgeOperations,
  config: ChannelConfig,
): void {
  if (!config.enabled) return;
  for (const entry of config.trustedHosts) assertTrustedAuthority(entry);

  withCarrier(ctx, (scope, carrier) => {
    const base = config.basePath.replace(/\/+$/u, '');
    const guard = (
      handler: (
        req: IncomingMessage,
        res: ServerResponse,
      ) => void | Promise<void>,
    ) =>
    async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (!isTrustedRequest(req, config.trustedHosts)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      try {
        await handler(req, res);
      } catch (error) {
        // A broken pipe or a malformed request must never take the host down.
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain' });
        }
        res.end(describeError(error));
      }
    };

    const streams = new Set<ServerResponse>();

    scope.effect(() =>
      carrier.register({
        kind: 'exact',
        path: `${base}/${CHANNEL_ROUTES.events}`,
        handler: guard((req, res) => {
          subscribe(operations, streams, req, res);
        }),
      }), 'cli-bridge: channel events route');

    scope.effect(() =>
      carrier.register({
        kind: 'exact',
        path: `${base}/${CHANNEL_ROUTES.state}`,
        handler: guard(async (req, res) => {
          if (!isReadMethod(req, res)) return;
          sendJson(res, 200, await operations.state());
        }),
      }), 'cli-bridge: channel state route');

    scope.effect(() =>
      carrier.register({
        kind: 'exact',
        path: `${base}/${CHANNEL_ROUTES.control}`,
        handler: guard(async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST' });
            res.end();
            return;
          }
          const body = await readBody(req);
          if (body === undefined) {
            sendJson(res, 413, {
              ok: false,
              error: 'control request too large',
            });
            return;
          }
          const request = parseControl(body);
          if (request === undefined) {
            sendJson(res, 400, {
              ok: false,
              error: 'control request must be a JSON object with an "op"',
            });
            return;
          }
          sendJson(res, 200, await operations.control(request));
        }),
      }), 'cli-bridge: channel control route');

    if (base !== DEFAULT_BASE_PATH && carrier.tapIndex !== undefined) {
      const tap = carrier.tapIndex.bind(carrier);
      // `<` is escaped so a configured path can never close the script element.
      const script = `<script>globalThis.${BASE_PATH_GLOBAL}=${
        JSON.stringify(base).replaceAll('<', '\\u003c')
      }</script>`;
      scope.effect(
        () => tap((html) => html.replace('</head>', `${script}</head>`)),
        'cli-bridge: base path tap',
      );
    }

    // Held-open responses never end on their own; teardown has to close them.
    scope.effect(() => () => {
      for (const response of streams) response.end();
      streams.clear();
    }, 'cli-bridge: channel subscribers');
  });
}

/**
 * Open one Server-Sent Events subscription.
 *
 * A subscriber that names a stream gets that stream's backlog first, so a
 * browser attaching to work already in flight sees context instead of a blank pane;
 * `Last-Event-ID` (or `?from=`) resumes exactly where a dropped socket stopped.
 * @param operations - the shared implementation.
 * @param streams - the live response set, for teardown.
 * @param req - the incoming request.
 * @param res - the response held open for the stream.
 */
function subscribe(
  operations: BridgeOperations,
  streams: Set<ServerResponse>,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (!isReadMethod(req, res)) return;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const stream = url.searchParams.get(STREAM_QUERY_PARAM) ?? undefined;
  // Sequence numbers are per-stream, so a resume point only means something
  // inside one stream. A subscription that follows every stream ignores it —
  // including the `Last-Event-ID` a browser replays on reconnect, which would
  // otherwise cut every other stream's backlog at one stream's sequence.
  const from = stream === undefined
    ? undefined
    : readFrom(req, url.searchParams.get(FROM_QUERY_PARAM));

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    // Proxies that buffer would defeat the entire point of this route.
    'x-accel-buffering': 'no',
  });
  // An opening comment proves the channel is live even before the first frame.
  res.write(': open\n\n');
  streams.add(res);

  const write = (frame: StreamFrame): void => {
    // The event id is what a reconnect resumes from, so it must be the
    // per-stream sequence number and nothing else.
    res.write(`id: ${String(frame.seq)}\ndata: ${JSON.stringify(frame)}\n\n`);
  };

  const { backlog, dispose } = operations.hub.subscribe(write, {
    ...stream === undefined ? {} : { stream },
    ...from === undefined ? {} : { from },
  });
  for (const frame of backlog) write(frame);

  const keepalive = setInterval(
    () => res.write(': keepalive\n\n'),
    KEEPALIVE_MS,
  );
  keepalive.unref?.();
  const close = (): void => {
    clearInterval(keepalive);
    dispose();
    streams.delete(res);
  };
  res.on('close', close);
  res.on('error', close);
}

/** Refuse anything but a read on the two GET routes. */
function isReadMethod(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  res.writeHead(405, { allow: 'GET, HEAD' });
  res.end();
  return false;
}

/** Resume point: the explicit query parameter, else the browser's own header. */
function readFrom(
  req: IncomingMessage,
  query: string | null,
): number | undefined {
  const header = req.headers['last-event-id'];
  const raw = query ?? (Array.isArray(header) ? header[0] : header);
  if (raw === undefined || raw === null) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Read a bounded JSON body. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_CONTROL_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parse a control request without trusting a byte of it. */
function parseControl(body: string): ControlRequest | undefined {
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value !== 'object' || value === null) return undefined;
    return typeof (value as { op?: unknown }).op === 'string'
      ? value as ControlRequest
      : undefined;
  } catch {
    return undefined;
  }
}

/** Answer with JSON. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
