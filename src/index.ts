/**
 * `dsh-cli-bridge` — delegate a task to the Claude Code or Codex CLI from
 * DeepSeek Harness.
 *
 * The composition root, and the only file that knows about all three layers at
 * once:
 *
 * - `domain/` is pure: the delegate adapters, the marker protocol, the
 *   classification of a finished run, and the whole autonomy policy. No I/O, no
 *   clock, no harness.
 * - `runtime/` owns behaviour behind injected ports: accounts, the toolchain,
 *   the run registry, the delegation loop, the worktrees and their merge queue,
 *   and the stream hub.
 * - `host/` binds that to this harness: the model-facing tools, the `/cli`
 *   command, and the Host → Web channel.
 *
 * Three invariants hold the design together. A delegation holds its tool call
 * until it settles, so DeepSeek is never billed for thinking while a delegate is
 * already being billed for working. The delegate's output travels on the channel
 * to a browser, never into the session log — the model receives a bounded
 * summary and a byte count of what it was spared. And nothing decides on the
 * user's behalf until the user asks: autonomy is off by default, only a person
 * can switch it on, and a direction from a person outranks every automatic
 * decision.
 *
 * @module dsh-cli-bridge
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-tools';
import { Config } from './config.ts';
import { BridgeOperations } from './runtime/operations.ts';
import { registerChannelRoutes } from './host/channel-routes.ts';
import { registerCommand } from './host/command.ts';
import { nodePorts } from './host/node-ports.ts';
import { registerTools } from './host/tools.ts';

export { Config } from './config.ts';
export type { Config as BridgeConfig } from './config.ts';
export * from './shared/protocol.ts';

/** Stable cordis plugin name. */
export const name = 'cli-bridge';

/**
 * Services required before the bridge mounts.
 *
 * Only two are required: the tool registry it contributes to, and the
 * subprocess seam it runs delegates through. The credential store, the
 * permission policy, the command registry, the HTTP carrier, the model service
 * and the user-questions seam are all optional — each one adds a face, and a
 * composition without it simply has fewer. Without a model there is nothing to
 * make an autonomous decision with; without a way to reach the human there is
 * nobody to ask; and the delegation loop reads both absences as "stop and
 * report".
 */
export const inject = ['tools', 'subprocess'];

/**
 * Mount the bridge.
 * @param ctx - host plugin context.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const operations = new BridgeOperations(config, nodePorts(ctx));

  registerTools(ctx, operations);
  registerCommand(ctx, operations);
  registerChannelRoutes(ctx, operations, config.channel);
  scheduleUpdates(ctx, operations, config);

  // Unloading the plugin must not leave a delegate writing to the workspace.
  ctx.effect(() => async () => {
    await operations.dispose();
  }, 'cli-bridge: live runs');
}

/**
 * Keep the managed delegates current.
 *
 * The check runs once at boot and then on the configured interval. It is a
 * timestamp comparison against the installer's own record, so a delegate that
 * is fresh — or that this plugin never installed — costs nothing.
 * @param ctx - host plugin context.
 * @param operations - the shared implementation.
 * @param config - resolved plugin config.
 */
function scheduleUpdates(
  ctx: Context,
  operations: BridgeOperations,
  config: Config,
): void {
  const { updateIntervalMs, mode } = config.toolchain;
  if (mode !== 'managed' || updateIntervalMs <= 0) return;

  ctx.effect(() => {
    // Failures are reported on the channel by the operation itself; an update
    // that cannot run must never take the plugin down with it.
    const refresh = (): void => {
      void operations.refreshToolchain().catch(() => undefined);
    };
    const timer = setInterval(refresh, updateIntervalMs);
    // Neither the boot check nor the interval may hold the process alive.
    timer.unref?.();
    const boot = setTimeout(refresh, 0);
    boot.unref?.();
    return () => {
      clearInterval(timer);
      clearTimeout(boot);
    };
  }, 'cli-bridge: delegate updates');
}
