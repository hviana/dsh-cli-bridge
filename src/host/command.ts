/**
 * The `/cli` human command.
 *
 * A third face on the same operations, for the person at the keyboard. The
 * PARSER is a pure function so the grammar is unit-tested without a harness,
 * and the handler is a thin dispatcher: every verb resolves to the same
 * {@link ControlRequest} the browser panel sends.
 *
 * @module dsh-cli-bridge/host/command
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CommandResult } from '@deepseek-ai/dsh-commands';
import type {
  AccountAuth,
  AutonomySwitches,
  BridgeState,
  CliId,
  ControlRequest,
  DelegationId,
} from '../shared/protocol.ts';
import { CLI_IDS } from '../shared/protocol.ts';
import { adapterFor } from '../domain/adapters/index.ts';
import { describeAuth } from '../runtime/accounts.ts';
import type { BridgeOperations } from '../runtime/operations.ts';

/** What one `/cli` line means. */
export type ParsedCliCommand =
  /** Show everything: delegates, accounts, runs. */
  | { readonly kind: 'status' }
  /** Run one control operation. */
  | { readonly kind: 'control'; readonly request: ControlRequest }
  /** The line did not parse; the text is shown to the user verbatim. */
  | { readonly kind: 'error'; readonly message: string };

/** The command's own help, shown for `/cli help` and for a line that does not parse. */
export const CLI_COMMAND_HELP = [
  '/cli                                  show delegates, accounts and recent runs',
  '/cli install <claude|codex>           install or update a delegate CLI',
  '/cli update <claude|codex>            same as install; refreshes to the latest',
  '/cli login <claude|codex> <account>   sign in interactively (watch it in the panel)',
  '/cli account add <cli> <id> [--api-key [REF]] [--endpoint <url> --token <REF> [--model <id>]] [--label <text>]',
  '/cli account remove <cli> <id>',
  '/cli account default <cli> <id>',
  '/cli cancel <run-id>                  stop a running delegate',
  '/cli direct <delegation-id> <text>    steer a live delegation; overrides any automatic decision',
  '/cli stop <delegation-id>             stop a delegation and every round it had left',
  '/cli auto <decide|continue|review> <on|off>   let DeepSeek decide, continue, or review by itself',
].join('\n');

/** The automatic decisions `/cli auto` can switch. */
const AUTONOMY_SWITCHES: readonly (keyof AutonomySwitches)[] = [
  'decide',
  'continue',
  'review',
];

/**
 * Parse one `/cli` line.
 * @param rawInput - the text following the command name.
 * @returns what to do, or why the line was refused.
 */
export function parseCliCommand(rawInput: string): ParsedCliCommand {
  const input = rawInput.trim();
  const [verb, ...rest] = input.split(/\s+/u).filter((part) => part.length > 0);
  if (verb === undefined || verb === 'status') return { kind: 'status' };

  switch (verb) {
    case 'help':
      return { kind: 'error', message: CLI_COMMAND_HELP };
    case 'install':
    case 'update': {
      const cli = readCli(rest[0]);
      return cli === undefined
        ? {
          kind: 'error',
          message: `usage: /cli ${verb} <${CLI_IDS.join('|')}>`,
        }
        : { kind: 'control', request: { op: 'toolchain.install', cli } };
    }
    case 'login': {
      const cli = readCli(rest[0]);
      const id = rest[1];
      return cli === undefined || id === undefined
        ? {
          kind: 'error',
          message: `usage: /cli login <${CLI_IDS.join('|')}> <account>`,
        }
        : { kind: 'control', request: { op: 'account.login', cli, id } };
    }
    case 'direct': {
      // Split off the id by hand: the instruction is prose, and tokenizing it
      // would quietly rewrite the user's own words.
      const match = /^direct\s+(?<delegation>\S+)\s+(?<text>[\s\S]+)$/u.exec(
        input,
      );
      const groups = match?.groups;
      return groups === undefined
        ? {
          kind: 'error',
          message: 'usage: /cli direct <delegation-id> <instruction>',
        }
        : {
          kind: 'control',
          request: {
            op: 'delegation.direct',
            delegation: groups.delegation as DelegationId,
            text: groups.text ?? '',
          },
        };
    }
    case 'auto': {
      const name = AUTONOMY_SWITCHES.find((candidate) => candidate === rest[0]);
      const on = rest[1] === 'on'
        ? true
        : rest[1] === 'off'
        ? false
        : undefined;
      return name === undefined || on === undefined
        ? {
          kind: 'error',
          message: `usage: /cli auto <${AUTONOMY_SWITCHES.join('|')}> <on|off>`,
        }
        : {
          kind: 'control',
          request: { op: 'autonomy.set', switch: name, on },
        };
    }
    case 'stop': {
      const delegation = rest[0];
      return delegation === undefined
        ? { kind: 'error', message: 'usage: /cli stop <delegation-id>' }
        : { kind: 'control', request: { op: 'delegation.cancel', delegation } };
    }
    case 'cancel': {
      const run = rest[0];
      return run === undefined
        ? { kind: 'error', message: 'usage: /cli cancel <run-id>' }
        : { kind: 'control', request: { op: 'run.cancel', run } };
    }
    case 'account':
      return parseAccount(rest);
    default:
      return {
        kind: 'error',
        message: `unknown subcommand ${
          JSON.stringify(verb)
        }\n\n${CLI_COMMAND_HELP}`,
      };
  }
}

/** Parse the `account` subcommands. */
function parseAccount(parts: readonly string[]): ParsedCliCommand {
  const [action, rawCli, id, ...flags] = parts;
  const cli = readCli(rawCli);
  if (action === undefined || cli === undefined || id === undefined) {
    return {
      kind: 'error',
      message: `usage: /cli account <add|remove|default> <${
        CLI_IDS.join('|')
      }> <id> …`,
    };
  }
  switch (action) {
    case 'remove':
      return { kind: 'control', request: { op: 'account.remove', cli, id } };
    case 'default':
      return { kind: 'control', request: { op: 'account.default', cli, id } };
    case 'add': {
      const options = readFlags(flags);
      const auth: AccountAuth = options.has('api-key')
        ? 'api-key'
        : options.has('endpoint')
        ? 'endpoint'
        : 'session';
      const credentialRef = options.get('api-key') ?? options.get('token');
      const label = options.get('label');
      const baseUrl = options.get('endpoint');
      const model = options.get('model');
      return {
        kind: 'control',
        request: {
          op: 'account.add',
          cli,
          id,
          auth,
          ...label === undefined ? {} : { label },
          ...credentialRef === undefined ? {} : { credentialRef },
          ...baseUrl === undefined ? {} : { baseUrl },
          ...model === undefined ? {} : { model },
        },
      };
    }
    default:
      return {
        kind: 'error',
        message: `unknown account action ${JSON.stringify(action)}`,
      };
  }
}

/**
 * Read `--flag` and `--flag value` pairs.
 * @param parts - the tail of the command line.
 * @returns each flag mapped to its value, or to `undefined` when it stands alone.
 */
function readFlags(parts: readonly string[]): Map<string, string | undefined> {
  const flags = new Map<string, string | undefined>();
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined || !part.startsWith('--')) continue;
    const next = parts[index + 1];
    const value = next !== undefined && !next.startsWith('--')
      ? next
      : undefined;
    flags.set(part.slice(2), value);
    if (value !== undefined) index += 1;
  }
  return flags;
}

/** Narrow a word to a delegate id. */
function readCli(value: string | undefined): CliId | undefined {
  return CLI_IDS.find((id) => id === value);
}

/**
 * Register the `/cli` command.
 * @param ctx - the host plugin context.
 * @param operations - the shared implementation.
 */
export function registerCommand(
  ctx: Context,
  operations: BridgeOperations,
): void {
  ctx.inject(['commands'], (scope: Context) => {
    scope.effect(() =>
      scope.commands.register({
        name: 'cli',
        description:
          'Manage the Claude Code and Codex delegates, their accounts, and their runs.',
        input: {
          hint:
            'status | install <cli> | login <cli> <account> | account … | direct <delegation> <text>',
        },
        async handler(invocation): Promise<CommandResult> {
          const parsed = parseCliCommand(invocation.rawInput);
          if (parsed.kind === 'error') {
            return { kind: 'error', text: parsed.message };
          }
          if (parsed.kind === 'status') {
            return {
              kind: 'success',
              text: renderState(await operations.state(invocation.agent.id)),
            };
          }
          const response = await operations.control(
            parsed.request,
            invocation.agent.id,
          );
          return response.ok
            ? { kind: 'success', text: renderState(response.state) }
            : { kind: 'error', text: response.error };
        },
      }), 'cli-bridge: /cli command');
  });
}

/**
 * Render the whole bridge state as one readable block.
 * @param state - runs, accounts and toolchain.
 * @returns the text a command surface prints.
 */
export function renderState(state: BridgeState): string {
  const lines: string[] = ['Delegates'];
  for (const entry of state.toolchain) {
    const version = entry.version === undefined ? '' : ` ${entry.version}`;
    lines.push(
      `  ${adapterFor(entry.cli).displayName}: ${entry.source}${version}`,
    );
  }

  lines.push('', 'Accounts');
  for (const account of state.accounts) {
    const marker = account.isDefault ? '*' : ' ';
    lines.push(
      `  ${marker} ${account.cli}/${account.id} — ${
        describeAuth(account, adapterFor(account.cli))
      }`,
    );
  }

  const on = AUTONOMY_SWITCHES.filter((name) => state.autonomy[name]);
  lines.push(
    '',
    `Autonomy: ${
      on.length === 0
        ? 'off — you answer, and a delegation ends when its delegate does'
        : on.join(', ')
    }`,
  );

  if (state.delegations.length > 0) {
    lines.push('', 'Delegations');
    for (const delegation of state.delegations) {
      lines.push(
        `  ${delegation.id} [${delegation.status}] ${delegation.account} — ${delegation.label}`,
      );
      const pending = delegation.directions.filter((direction) =>
        direction.consumedRound === undefined
      );
      for (const direction of pending) {
        lines.push(`      direction pending: ${direction.text}`);
      }
      if (delegation.question !== undefined) {
        lines.push(`      waiting on you: ${delegation.question.question}`);
      }
      if (delegation.workspace.mode === 'worktree') {
        const detail = delegation.workspace.detail === undefined
          ? ''
          : ` — ${delegation.workspace.detail}`;
        lines.push(
          `      ${
            delegation.workspace.branch ?? 'worktree'
          }: ${delegation.workspace.merge}${detail}`,
        );
      }
    }
  }

  lines.push('', state.runs.length === 0 ? 'No runs yet.' : 'Runs');
  for (const run of state.runs) {
    lines.push(`  ${run.id} [${run.status}] ${run.account} — ${run.label}`);
  }
  return lines.join('\n');
}
