/**
 * Host-layer test doubles: a minimal cordis context, an HTTP carrier, and a
 * fully wired {@link BridgeOperations} over the fake ports.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import { Config } from '../../src/config.ts';
import type { Config as ResolvedConfig } from '../../src/config.ts';
import type { LlmPort } from '../../src/runtime/advisor.ts';
import type { UserQuestionsPort } from '../../src/runtime/inquiry.ts';
import { BridgeOperations } from '../../src/runtime/operations.ts';
import type { RuntimePorts } from '../../src/runtime/ports.ts';
import {
  fakeClock,
  FakeProcessPort,
  MemoryFiles,
  type ProcessScript,
} from './fakes.ts';

/**
 * Enough of a cordis context for a plugin surface to mount against: services,
 * `inject` gating, and effect-scoped disposal.
 */
export class FakeContext {
  private readonly services = new Map<string, unknown>();
  private readonly disposers: (() => unknown)[] = [];

  /**
   * Publish a service under a key.
   *
   * Real cordis exposes a service as a PROPERTY of the context as well as
   * through `get`, and consumers read it both ways, so the fake does too.
   */
  provide(key: string, value: unknown): this {
    this.services.set(key, value);
    Object.defineProperty(this, key, {
      value,
      configurable: true,
      enumerable: true,
    });
    return this;
  }

  /** Read a service, cordis-style. */
  get(key: string): unknown {
    return this.services.get(key);
  }

  /** Run the callback when every named service is present. */
  inject(keys: readonly string[], callback: (scope: Context) => void): void {
    if (keys.every((key) => this.services.has(key))) callback(this.asContext());
  }

  /** Register an effect; the returned disposer runs on {@link dispose}. */
  effect(factory: () => (() => unknown) | undefined, _label?: string): void {
    const disposer = factory();
    if (disposer !== undefined) this.disposers.push(disposer);
  }

  /** Unwind every effect, newest first. */
  async dispose(): Promise<void> {
    // oxlint-disable-next-line eslint/no-await-in-loop -- unwinding is ordered
    for (const disposer of this.disposers.toReversed()) await disposer();
    this.disposers.length = 0;
  }

  /** The same object, typed as the harness context. */
  asContext(): Context {
    return this as unknown as Context;
  }
}

/** An HTTP carrier that collects routes and can serve them for real. */
export class FakeCarrier {
  readonly routes = new Map<string, WebRoute>();
  readonly indexTaps: ((html: string) => string)[] = [];

  tapIndex(transform: (html: string) => string): () => void {
    this.indexTaps.push(transform);
    return () => {
      this.indexTaps.length = 0;
    };
  }

  /** Apply every tap, as the frontend owner does on each index render. */
  renderIndex(html: string): string {
    return this.indexTaps.reduce(
      (current, transform) => transform(current),
      html,
    );
  }

  register(route: WebRoute): () => void {
    const key = `${route.kind} ${route.path}`;
    if (this.routes.has(key)) throw new Error(`duplicate route ${key}`);
    this.routes.set(key, route);
    return () => {
      this.routes.delete(key);
    };
  }

  /**
   * Serve the collected exact routes from a real loopback server.
   * @returns the base URL and a closer.
   */
  async listen(): Promise<
    { url: string; close: () => Promise<void>; server: Server }
  > {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const route = this.routes.get(`exact ${path}`);
      if (route === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      void route.handler(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null
      ? address.port
      : 0;
    return {
      url: `http://127.0.0.1:${String(port)}`,
      server,
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      },
    };
  }
}

/** A fully wired operations object over in-memory ports. */
export function buildOperations(options: {
  /** Raw config, validated and defaulted through the plugin's own schema. */
  config?: Record<string, unknown>;
  script?: (argv: readonly string[]) => ProcessScript;
  secrets?: Record<string, string>;
  onPath?: readonly string[];
  /** The model seam; omit to compose an operations object with no advisor. */
  llm?: LlmPort;
  /** The user-questions seam; omit to compose one that cannot reach a human. */
  questions?: UserQuestionsPort;
  /**
   * The composition's default model route.
   *
   * Omit to compose a deployment that names no default — the state a session
   * without an explicit model is in, where autonomy has no route to run on.
   */
  defaultRoute?: { provider?: string; model?: string };
  /** The file store; pass one shared across builds to simulate a reload. */
  files?: MemoryFiles;
} = {}) {
  const config: ResolvedConfig = new Config(options.config ?? {});
  const files = options.files ?? new MemoryFiles();
  const clock = fakeClock();
  const process = new FakeProcessPort((spec) =>
    options.script?.(spec.argv) ?? { stdout: ['1.0.0'] }
  );
  for (const command of options.onPath ?? ['claude', 'codex']) {
    process.resolvable.add(command);
  }
  const ports: RuntimePorts = {
    process,
    files,
    now: clock.now,
    platform: 'linux',
    nodePath: '/usr/bin/node',
    credentials: { resolve: async (ref) => options.secrets?.[ref] },
    ...options.llm === undefined ? {} : { llm: options.llm },
    ...options.questions === undefined ? {} : { questions: options.questions },
    ...options.defaultRoute === undefined
      ? {}
      : { defaultRoute: () => options.defaultRoute },
  };
  const operations = new BridgeOperations(config, ports);
  return { operations, config, files, clock, process };
}

/** Read a Server-Sent Events body until a predicate is satisfied. */
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  isDone: (frames: unknown[]) => boolean,
  limit = 200,
): Promise<unknown[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: unknown[] = [];
  let buffered = '';
  try {
    for (let index = 0; index < limit; index += 1) {
      if (isDone(frames)) return frames;
      // oxlint-disable-next-line eslint/no-await-in-loop
      const { value, done } = await reader.read();
      if (done) return frames;
      buffered += decoder.decode(value, { stream: true });
      const blocks = buffered.split('\n\n');
      buffered = blocks.pop() ?? '';
      for (const block of blocks) {
        const line = block.split('\n').find((part) =>
          part.startsWith('data: ')
        );
        if (line !== undefined) frames.push(JSON.parse(line.slice(6)));
      }
    }
    return frames;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
