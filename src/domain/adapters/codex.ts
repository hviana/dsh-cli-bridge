/**
 * The Codex adapter.
 *
 * Headless shape: `codex exec --json`, prompt on stdin through the `-`
 * placeholder. Resuming keeps the same shape with the `resume <id>` verb.
 *
 * Accounts are isolated with `CODEX_HOME`, the directory the CLI keeps its
 * credentials and configuration in — one home per login is the whole of
 * multi-account Codex.
 *
 * @module dsh-cli-bridge/domain/adapters/codex
 */
import type {
  Activity,
  EffortLevel,
  PermissionMode,
  RunUsage,
} from '../../shared/protocol.ts';
import {
  parseJsonObject,
  readArray,
  readNumber,
  readObject,
  readString,
} from '../lines.ts';
import {
  accountEnv,
  type CliAdapter,
  type DecodedState,
  type DelegateDecoder,
  type LoginPlanRequest,
  type SpawnPlan,
  type TaskPlanRequest,
} from './contract.ts';

/**
 * The harness permission mode, in Codex's own vocabulary.
 *
 * Codex's sandbox levels line up one-to-one with the harness's three modes, so
 * the translation is a lookup rather than a policy of this plugin's own.
 */
const SANDBOX_ARGS: Readonly<Record<PermissionMode, readonly string[]>> = {
  'read-only': ['--sandbox', 'read-only'],
  'workspace-write': ['--sandbox', 'workspace-write'],
  // The bypass flag drops the sandbox AND the approval gate together; adding
  // `--sandbox` beside it would be contradictory rather than redundant.
  'danger-full-access': ['--dangerously-bypass-approvals-and-sandbox'],
};

/**
 * Codex reasoning-effort levels. It has no `max`, so the highest level the
 * plugin exposes clamps onto the highest level Codex accepts.
 */
const EFFORT: Readonly<Record<EffortLevel, string>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
};

/** Placeholder telling `codex exec` to read the prompt from stdin. */
const STDIN_PROMPT = '-';

/** Projection of `codex exec --json` onto the shared vocabulary. */
class CodexDecoder implements DelegateDecoder {
  private finalMessage: string | undefined;
  private threadId: string | undefined;
  private usage: RunUsage | undefined;
  private failure: string | undefined;

  push(line: string): readonly Activity[] {
    const event = parseJsonObject(line);
    if (event === undefined) return [];
    switch (readString(event, 'type')) {
      case 'thread.started':
        this.threadId = readString(event, 'thread_id') ?? this.threadId;
        return [];
      case 'turn.completed': {
        const usage = codexUsage(readObject(event, 'usage'));
        if (usage === undefined) return [];
        this.usage = usage;
        return [{ type: 'usage', usage }];
      }
      case 'turn.failed': {
        const message = readString(readObject(event, 'error'), 'message') ??
          'turn failed';
        this.failure = message;
        return [{ type: 'notice', level: 'error', text: message }];
      }
      case 'error': {
        const message = readString(event, 'message') ?? 'error';
        this.failure ??= message;
        return [{ type: 'notice', level: 'error', text: message }];
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return this.item(
          readObject(event, 'item'),
          readString(event, 'type') === 'item.completed',
        );
      default:
        return [];
    }
  }

  state(): DecodedState {
    return {
      ...this.finalMessage === undefined
        ? {}
        : { finalMessage: this.finalMessage },
      ...this.threadId === undefined
        ? {}
        : { delegateSessionId: this.threadId },
      ...this.usage === undefined ? {} : { usage: this.usage },
      ...this.failure === undefined ? {} : { failure: this.failure },
    };
  }

  private item(
    item: Record<string, unknown> | undefined,
    completed: boolean,
  ): readonly Activity[] {
    if (item === undefined) return [];
    switch (readString(item, 'type')) {
      case 'agent_message': {
        const text = readString(item, 'text')?.trim();
        if (text === undefined || text.length === 0 || !completed) return [];
        this.finalMessage = text;
        return [{ type: 'message', text }];
      }
      case 'reasoning': {
        const text = readString(item, 'text')?.trim();
        return text === undefined || text.length === 0 || !completed
          ? []
          : [{ type: 'reasoning', text }];
      }
      case 'command_execution': {
        const command = readString(item, 'command');
        const exitCode = readNumber(item, 'exit_code');
        return [{
          type: 'tool',
          name: 'command',
          status: itemStatus(item, completed),
          ...command === undefined ? {} : { detail: command },
          ...exitCode === undefined ? {} : { exitCode },
        }];
      }
      case 'file_change': {
        if (!completed) return [];
        return readArray(item, 'changes').flatMap(
          (raw): readonly Activity[] => {
            const change = raw as Record<string, unknown>;
            const path = readString(change, 'path');
            return path === undefined
              ? []
              : [{ type: 'file', path, change: fileChangeKind(change) }];
          },
        );
      }
      case 'mcp_tool_call': {
        const server = readString(item, 'server');
        const tool = readString(item, 'tool') ?? 'tool';
        return [{
          type: 'tool',
          name: server === undefined ? tool : `${server}.${tool}`,
          status: itemStatus(item, completed),
        }];
      }
      case 'web_search': {
        if (!completed) return [];
        const query = readString(item, 'query');
        return [{
          type: 'tool',
          name: 'web_search',
          status: 'completed',
          ...query === undefined ? {} : { detail: query },
        }];
      }
      case 'todo_list': {
        if (!completed) return [];
        const items = readArray(item, 'items');
        return [{
          type: 'notice',
          level: 'info',
          text: `plan updated (${String(items.length)} items)`,
        }];
      }
      case 'error': {
        const message = readString(item, 'message') ?? 'error';
        return [{ type: 'notice', level: 'error', text: message }];
      }
      default:
        return [];
    }
  }
}

/** Map an item's own status field onto the shared tool status. */
function itemStatus(
  item: Record<string, unknown>,
  completed: boolean,
): 'started' | 'completed' | 'failed' {
  const status = readString(item, 'status');
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'completed';
  return completed ? 'completed' : 'started';
}

/** Map a Codex file-change kind onto the shared vocabulary. */
function fileChangeKind(
  change: Record<string, unknown>,
): 'add' | 'update' | 'delete' {
  switch (readString(change, 'kind')) {
    case 'add':
      return 'add';
    case 'delete':
      return 'delete';
    default:
      return 'update';
  }
}

/** Project a `turn.completed` usage object. */
function codexUsage(
  raw: Record<string, unknown> | undefined,
): RunUsage | undefined {
  const input = readNumber(raw, 'input_tokens');
  const cached = readNumber(raw, 'cached_input_tokens');
  const output = readNumber(raw, 'output_tokens');
  if (input === undefined && cached === undefined && output === undefined) {
    return undefined;
  }
  return {
    ...input === undefined ? {} : { inputTokens: input },
    ...cached === undefined ? {} : { cachedInputTokens: cached },
    ...output === undefined ? {} : { outputTokens: output },
  };
}

/** The Codex delegate. */
export const codexAdapter: CliAdapter = {
  id: 'codex',
  displayName: 'Codex',
  command: 'codex',
  npmPackage: '@openai/codex',
  homeEnvVar: 'CODEX_HOME',
  apiKeyEnvVar: 'OPENAI_API_KEY',
  defaultCredentialRef: 'OPENAI_API_KEY',

  versionArgv: () => ['--version'],

  parseVersion: (output) => /(\d+\.\d+\.\d+[\w.-]*)/u.exec(output)?.[1],

  planTask(request: TaskPlanRequest): SpawnPlan {
    const sandbox = SANDBOX_ARGS[request.permission];
    return {
      argv: [
        'exec',
        ...request.resume === undefined ? [] : ['resume', request.resume],
        '--json',
        '--skip-git-repo-check',
        ...sandbox,
        // A headless run has nobody to answer an approval prompt; refusing is
        // the honest outcome, hanging is not. The bypass mode already implies
        // it, so stating it there would be contradictory noise.
        ...request.permission === 'danger-full-access'
          ? []
          : ['-c', 'approval_policy="never"'],
        ...request.model === undefined ? [] : ['--model', request.model],
        ...request.effort === undefined
          ? []
          : ['-c', `model_reasoning_effort="${EFFORT[request.effort]}"`],
        ...request.account.apiKey === undefined
          ? []
          : ['-c', 'preferred_auth_method="apikey"'],
        ...request.extraArgs ?? [],
        STDIN_PROMPT,
      ],
      env: accountEnv(codexAdapter, request.account),
      stdin: request.prompt,
    };
  },

  planLogin(request: LoginPlanRequest): SpawnPlan {
    return { argv: ['login'], env: accountEnv(codexAdapter, request.account) };
  },

  planAuthStatus(request: LoginPlanRequest): SpawnPlan {
    return {
      argv: ['login', 'status'],
      env: accountEnv(codexAdapter, request.account),
    };
  },

  decoder: () => new CodexDecoder(),
};
