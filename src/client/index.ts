/**
 * `dsh-cli-bridge` — the browser half.
 *
 * Three registrations and one connection:
 *
 * - a keyed tool view for each delegation tool, so a delegated run streams
 *   inside the turn that started it;
 * - one frame-wide overlay entry for the accounts, the toolchain, and the
 *   interactive sign-ins that have no tool call to live in;
 * - one event-stream subscription shared by all of them.
 *
 * Nothing here talks to a model, and nothing here is durable: this half exists
 * so a human can watch what the delegate is doing, precisely so the transcript
 * never has to enter a DeepSeek request to be seen.
 *
 * @module dsh-cli-bridge/client
 */
import { DEFAULT_BASE_PATH } from '../shared/protocol.ts';
import { createBridgePanel } from './BridgePanel.tsx';
import { createRunCard } from './RunCard.tsx';
import type { ClientHost } from './host.ts';
import { createStore } from './store.ts';
import { injectStyles } from './styles.ts';

/** Stable cordis plugin name in the browser registry. */
export const name = 'cli-bridge';

/** The client services this half needs. */
export const inject = ['slots'];

/** Tool names whose calls this plugin renders itself. */
const TOOL_VIEWS = ['cli_delegate', 'cli_delegate_all', 'cli_reply'] as const;

/** The frame-wide overlay seat: additive, so this entry sits beside the shipped ones. */
const OVERLAY_SLOT = 'shell.overlay';

/** The keyed tool-view seat, owned by the harness's tool UI. */
const TOOLVIEW_SLOT = 'tool.call.toolview';

/**
 * Mount the browser half.
 *
 * The channel's base path is a HOST configuration field, and the browser has no
 * way to read the host's config, so the two agree through the protocol's default
 * and a global the page may override — the same way the harness passes its own
 * boot manifest to the shell.
 * @param ctx - the client context.
 */
export function apply(ctx: ClientHost): void {
  const store = createStore({ basePath: basePath() });
  ctx.effect(() => {
    const removeStyles = injectStyles();
    return () => {
      removeStyles();
      store.dispose();
    };
  }, 'cli-bridge: channel and styles');

  const card = createRunCard(store);
  ctx.slots.inject(TOOLVIEW_SLOT, function* () {
    for (const toolName of TOOL_VIEWS) {
      yield ctx.slots.register({ name: TOOLVIEW_SLOT, key: toolName }, card);
    }
  });

  const panel = createBridgePanel(store);
  ctx.slots.inject(
    OVERLAY_SLOT,
    () =>
      ctx.slots.register(
        { name: OVERLAY_SLOT, id: 'cli-bridge', order: 50 },
        panel,
      ),
  );
}

/**
 * Name of the global a deployment sets to match a non-default `channel.basePath`.
 *
 * The dunder spelling is the harness's own convention for a value the page hands
 * the shell (`window.__DSH_BOOT__`), so this follows it.
 */
const BASE_PATH_GLOBAL = '__DSH_CLI_BRIDGE_BASE__';

/** The channel's base path for this page. */
function basePath(): string {
  const configured = (globalThis as Record<string, unknown>)[BASE_PATH_GLOBAL];
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : DEFAULT_BASE_PATH;
}
