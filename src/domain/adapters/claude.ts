/**
 * The Claude Code adapter.
 *
 * Headless shape: `claude -p --output-format stream-json --verbose`, prompt on
 * stdin. The prompt travels on stdin rather than in argv because a delegated
 * task is arbitrarily long and every operating system caps a command line —
 * Windows hardest.
 *
 * Accounts are isolated with `CLAUDE_CONFIG_DIR`, the CLI's own switch for
 * "keep this login, its history and its settings over here". Nothing about an
 * account is stored by this plugin except the directory it points at.
 *
 * Claude Code also speaks to any Anthropic-compatible endpoint, so an account
 * may instead be pointed elsewhere: `ANTHROPIC_BASE_URL` names the provider
 * (DeepSeek's `https://api.deepseek.com/anthropic`, say) and `ANTHROPIC_AUTH_TOKEN`
 * carries its token, while the model travels through the `--model` flag like any
 * other run's does.
 *
 * @module dsh-cli-bridge/domain/adapters/claude
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
  TOOL_OUTPUT_BYTES,
} from './contract.ts';
import { boundHead } from '../text.ts';

/**
 * The harness permission mode, in Claude Code's own vocabulary.
 *
 * Coarse on purpose: the harness offers three modes and this maps all three,
 * with no per-tool rules layered on top. `dontAsk` is Claude Code's locked-down
 * mode — everything outside its read-only command set is denied rather than
 * queued for a prompt that a headless run could never answer.
 */
const PERMISSION_MODE: Readonly<Record<PermissionMode, string>> = {
  'read-only': 'dontAsk',
  'workspace-write': 'acceptEdits',
  'danger-full-access': 'bypassPermissions',
};

/** Tool names whose input names a file the delegate is about to change. */
const FILE_TOOLS: Readonly<Record<string, 'add' | 'update'>> = {
  Write: 'add',
  Edit: 'update',
  MultiEdit: 'update',
  NotebookEdit: 'update',
};

/** Claude Code accepts every effort level the plugin exposes. */
function effortArgs(effort: EffortLevel | undefined): readonly string[] {
  return effort === undefined ? [] : ['--effort', effort];
}

/** Projection of `--output-format stream-json` onto the shared vocabulary. */
class ClaudeDecoder implements DelegateDecoder {
  /** Tool-call id → tool name, so a result line can name the tool it settles. */
  private readonly pendingTools = new Map<string, string>();
  private finalMessage: string | undefined;
  private sessionId: string | undefined;
  private usage: RunUsage | undefined;
  private failure: string | undefined;

  push(line: string): readonly Activity[] {
    const event = parseJsonObject(line);
    if (event === undefined) return [];
    switch (readString(event, 'type')) {
      case 'system':
        return this.system(event);
      case 'assistant':
        return this.assistant(event);
      case 'user':
        return this.user(event);
      case 'result':
        return this.result(event);
      case 'rate_limit_event':
        return rateLimitNotice(event);
      default:
        return [];
    }
  }

  state(): DecodedState {
    return {
      ...this.finalMessage === undefined
        ? {}
        : { finalMessage: this.finalMessage },
      ...this.sessionId === undefined
        ? {}
        : { delegateSessionId: this.sessionId },
      ...this.usage === undefined ? {} : { usage: this.usage },
      ...this.failure === undefined ? {} : { failure: this.failure },
    };
  }

  private system(event: Record<string, unknown>): readonly Activity[] {
    this.sessionId = readString(event, 'session_id') ?? this.sessionId;
    if (readString(event, 'subtype') !== 'api_retry') return [];
    const attempt = readNumber(event, 'attempt');
    const reason = readString(event, 'error') ?? 'unknown';
    return [{
      type: 'notice',
      level: 'warn',
      text: `API retry${
        attempt === undefined ? '' : ` ${String(attempt)}`
      }: ${reason}`,
    }];
  }

  private assistant(event: Record<string, unknown>): readonly Activity[] {
    // Sub-agent traffic carries the spawning tool call's id. It is already
    // represented by that tool's own activity, so only the main conversation
    // contributes prose.
    if (readString(event, 'parent_tool_use_id') !== undefined) return [];
    const activities: Activity[] = [];
    for (const raw of readArray(readObject(event, 'message'), 'content')) {
      const block = raw as Record<string, unknown>;
      switch (readString(block, 'type')) {
        case 'text': {
          const text = readString(block, 'text')?.trim();
          if (text !== undefined && text.length > 0) {
            activities.push({ type: 'message', text });
          }
          break;
        }
        case 'thinking': {
          const text = readString(block, 'thinking')?.trim();
          if (text !== undefined && text.length > 0) {
            activities.push({ type: 'reasoning', text });
          }
          break;
        }
        case 'tool_use': {
          activities.push(...this.toolUse(block));
          break;
        }
        default:
          break;
      }
    }
    return activities;
  }

  private toolUse(block: Record<string, unknown>): readonly Activity[] {
    const name = readString(block, 'name') ?? 'tool';
    const id = readString(block, 'id');
    if (id !== undefined) this.pendingTools.set(id, name);
    const input = readObject(block, 'input');
    const path = readString(input, 'file_path') ?? readString(input, 'path');
    const detail = readString(input, 'command') ??
      readString(input, 'pattern') ??
      readString(input, 'description') ??
      path;
    return [
      {
        type: 'tool',
        name,
        status: 'started',
        // The id is what pairs this row with the result that follows it, so a
        // watcher sees one call filling in rather than two unrelated lines.
        ...id === undefined ? {} : { id },
        ...detail === undefined ? {} : { detail },
      },
      ...FILE_TOOLS[name] !== undefined && path !== undefined
        ? [{ type: 'file', path, change: FILE_TOOLS[name] } as const]
        : [],
    ];
  }

  private user(event: Record<string, unknown>): readonly Activity[] {
    const activities: Activity[] = [];
    for (const raw of readArray(readObject(event, 'message'), 'content')) {
      const block = raw as Record<string, unknown>;
      if (readString(block, 'type') !== 'tool_result') continue;
      const id = readString(block, 'tool_use_id');
      const name = (id === undefined ? undefined : this.pendingTools.get(id)) ??
        'tool';
      if (id !== undefined) this.pendingTools.delete(id);
      const output = toolResultText(block['content']);
      activities.push({
        type: 'tool',
        name,
        status: block['is_error'] === true ? 'failed' : 'completed',
        ...id === undefined ? {} : { id },
        ...output === undefined
          ? {}
          : { output: boundHead(output, TOOL_OUTPUT_BYTES) },
      });
    }
    return activities;
  }

  private result(event: Record<string, unknown>): readonly Activity[] {
    this.sessionId = readString(event, 'session_id') ?? this.sessionId;
    const text = readString(event, 'result')?.trim();
    if (text !== undefined && text.length > 0) this.finalMessage = text;
    if (event['is_error'] === true) {
      this.failure = text !== undefined && text.length > 0
        ? text
        : (readString(event, 'subtype') ?? 'run failed');
    }
    const usage = claudeUsage(event);
    if (usage !== undefined) this.usage = usage;
    return usage === undefined ? [] : [{ type: 'usage', usage }];
  }
}

/**
 * Flatten what a `tool_result` block returned into readable text.
 *
 * Claude Code sends either a bare string or the same content-block array an
 * assistant message uses. Only text blocks carry something a transcript can
 * show; an image block is named rather than rendered, so a screenshot does not
 * read as an empty result.
 * @param content - the block's `content` field, in either shape.
 * @returns the text, or `undefined` when the result carried none.
 */
function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const text = content.trim();
    return text.length === 0 ? undefined : text;
  }
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw === 'string') {
      parts.push(raw);
      continue;
    }
    if (typeof raw !== 'object' || raw === null) continue;
    const block = raw as Record<string, unknown>;
    const type = readString(block, 'type');
    const text = readString(block, 'text');
    if (text !== undefined) parts.push(text);
    else if (type !== undefined && type !== 'text') parts.push(`[${type}]`);
  }
  const joined = parts.join('\n').trim();
  return joined.length === 0 ? undefined : joined;
}

/**
 * Report a rate-limit state the caller can act on.
 *
 * A delegate that is being throttled looks identical to a slow one from the
 * outside, so the state is surfaced rather than dropped. An `allowed` status is
 * the ordinary case and says nothing worth a line.
 * @param event - the `rate_limit_event` line.
 * @returns one notice, or none while the delegate is unthrottled.
 */
function rateLimitNotice(event: Record<string, unknown>): readonly Activity[] {
  const info = readObject(event, 'rate_limit_info');
  const status = readString(info, 'status');
  if (status === undefined || status === 'allowed') return [];
  const window = readString(info, 'rateLimitType');
  const resets = readNumber(info, 'resetsAt');
  const detail = [
    window === undefined ? undefined : `${window} window`,
    resets === undefined
      ? undefined
      : `resets at ${new Date(resets * 1000).toISOString()}`,
  ].filter((part): part is string => part !== undefined).join(', ');
  return [{
    type: 'notice',
    level: 'warn',
    text: `rate limit ${status}${detail.length === 0 ? '' : ` (${detail})`}`,
  }];
}

/** Project a `result` line's cost and token facts. */
function claudeUsage(event: Record<string, unknown>): RunUsage | undefined {
  const raw = readObject(event, 'usage');
  const input = readNumber(raw, 'input_tokens');
  const output = readNumber(raw, 'output_tokens');
  const cached = readNumber(raw, 'cache_read_input_tokens');
  const cost = readNumber(event, 'total_cost_usd');
  if (
    input === undefined && output === undefined && cached === undefined &&
    cost === undefined
  ) return undefined;
  return {
    ...input === undefined ? {} : { inputTokens: input },
    ...cached === undefined ? {} : { cachedInputTokens: cached },
    ...output === undefined ? {} : { outputTokens: output },
    ...cost === undefined ? {} : { costUsd: cost },
  };
}

/** The Claude Code delegate. */
export const claudeAdapter: CliAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  command: 'claude',
  npmPackage: '@anthropic-ai/claude-code',
  homeEnvVar: 'CLAUDE_CONFIG_DIR',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
  authTokenEnvVar: 'ANTHROPIC_AUTH_TOKEN',
  defaultCredentialRef: 'ANTHROPIC_API_KEY',

  versionArgv: () => ['--version'],

  parseVersion: (output) => /(\d+\.\d+\.\d+[\w.-]*)/u.exec(output)?.[1],

  planTask(request: TaskPlanRequest): SpawnPlan {
    return {
      argv: [
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        PERMISSION_MODE[request.permission],
        ...request.model === undefined ? [] : ['--model', request.model],
        ...effortArgs(request.effort),
        ...request.resume === undefined ? [] : ['--resume', request.resume],
        ...request.extraArgs ?? [],
      ],
      env: accountEnv(claudeAdapter, request.account),
      stdin: request.prompt,
    };
  },

  planLogin(request: LoginPlanRequest): SpawnPlan {
    return {
      argv: ['auth', 'login'],
      env: accountEnv(claudeAdapter, request.account),
    };
  },

  planAuthStatus(request: LoginPlanRequest): SpawnPlan {
    return {
      argv: ['auth', 'status', '--json'],
      env: accountEnv(claudeAdapter, request.account),
    };
  },

  decoder: () => new ClaudeDecoder(),
};
