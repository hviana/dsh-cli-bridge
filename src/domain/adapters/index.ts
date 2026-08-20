/**
 * The adapter registry.
 *
 * Adding a third delegate CLI is one module here and one entry in this table —
 * no surface above it (tools, commands, channel, views) learns a new name.
 *
 * @module dsh-cli-bridge/domain/adapters
 */
import type { CliId } from '../../shared/protocol.ts';
import { CLI_IDS } from '../../shared/protocol.ts';
import type { CliAdapter } from './contract.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';

export type {
  AccountBinding,
  CliAdapter,
  DecodedState,
  DelegateDecoder,
  LoginPlanRequest,
  SpawnPlan,
  TaskPlanRequest,
} from './contract.ts';
export { supportsEndpoint } from './contract.ts';

const ADAPTERS: Readonly<Record<CliId, CliAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

/**
 * Resolve the adapter for one delegate.
 * @param cli - the delegate id.
 * @returns its adapter.
 */
export function adapterFor(cli: CliId): CliAdapter {
  return ADAPTERS[cli];
}

/** Every adapter, in listing order. */
export const adapters: readonly CliAdapter[] = CLI_IDS.map(adapterFor);
