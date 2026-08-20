/**
 * The model-facing surface.
 *
 * Five tools, and between them they hand DeepSeek exactly two kinds of value:
 * how a delegation ENDED, and the state of the accounts and CLIs it runs under.
 * No transcript, no tool log, no mirror — the whole stream goes to the browser
 * instead, and the byte count in each result says how much was kept out of the
 * context window.
 *
 * There is deliberately NO background mode. A delegation holds its tool call
 * until it settles, so DeepSeek issues no requests while another agent is
 * already being paid for. Overlapping the two is the duplicate consumption this
 * plugin exists to avoid.
 *
 * @module dsh-cli-bridge/host/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {
  InferArgs,
  InferValue,
  ParameterSchemaSpec,
  ToolDefinition,
} from '@deepseek-ai/dsh-tools';
import type {
  AccountAuth,
  CliId,
  DelegationId,
  DelegationSnapshot,
  EffortLevel,
  PermissionMode,
} from '../shared/protocol.ts';
import { CLI_IDS, EFFORT_LEVELS } from '../shared/protocol.ts';
import { adapterFor } from '../domain/adapters/index.ts';
import { oneLineLabel } from '../domain/text.ts';
import { describeAuth } from '../runtime/accounts.ts';
import type { BatchTask } from '../runtime/batch.ts';
import { BridgeError } from '../runtime/errors.ts';
import type { BridgeOperations } from '../runtime/operations.ts';

/** Characters of a prompt kept for a card title. */
const TITLE_CHARS = 60;

/** One automatic or human decision, as the model is told about it. */
const DECISION = {
  type: 'object',
  properties: {
    round: { type: 'number' },
    kind: { type: 'string', enum: ['resume', 'ask', 'consult', 'finish'] },
    source: {
      type: 'string',
      enum: ['direction', 'human', 'advisor', 'policy'],
      description:
        'Who decided: a standing user direction, the user, you, or the fixed policy.',
    },
    reason: { type: 'string' },
  },
  additionalProperties: false,
} as const;

/** Canonical value every delegation tool returns, per delegation. */
const DELEGATION = {
  type: 'object',
  properties: {
    delegation: {
      type: 'string',
      description: 'Delegation id; pass it to cli_reply to continue this work.',
    },
    cli: { type: 'string' },
    account: { type: 'string' },
    status: {
      type: 'string',
      enum: ['completed', 'needs_direction', 'failed', 'cancelled'],
    },
    summary: {
      type: 'string',
      description: "The delegate's final report, bounded.",
    },
    question: {
      type: 'string',
      description: 'Present only when status is needs_direction.',
    },
    error: {
      type: 'string',
      description: 'Present only when status is failed.',
    },
    nextSteps: {
      type: 'string',
      description: 'Work the delegate declared still remaining.',
    },
    rounds: {
      type: 'number',
      description: 'How many delegate runs this delegation spent.',
    },
    decisions: { type: 'array', items: DECISION },
    directions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Standing instructions that applied to this delegation.',
    },
    workspace: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['inline', 'worktree'] },
        path: { type: 'string' },
        branch: { type: 'string' },
        merge: {
          type: 'string',
          enum: [
            'not-required',
            'pending',
            'merged',
            'conflict',
            'failed',
            'skipped',
          ],
        },
        detail: { type: 'string' },
      },
      additionalProperties: false,
    },
    durationMs: { type: 'number' },
    streamedBytes: {
      type: 'number',
      description:
        'Delegate output shown live in the UI and deliberately not included here.',
    },
    usage: {
      type: 'object',
      properties: {
        inputTokens: { type: 'number' },
        cachedInputTokens: { type: 'number' },
        outputTokens: { type: 'number' },
        costUsd: { type: 'number' },
      },
      additionalProperties: false,
      description:
        "The delegate's own token spend, summed over every round. Not yours.",
    },
  },
  additionalProperties: false,
} as const;

/** Canonical value of a batch: one entry per task, in the order asked for. */
const BATCH = {
  type: 'object',
  properties: { delegations: { type: 'array', items: DELEGATION } },
  additionalProperties: false,
} as const;

/** The canonical values, derived from the schemas so the two cannot drift. */
type DelegationResult = InferValue<typeof DELEGATION>;
type BatchResult = InferValue<typeof BATCH>;

/**
 * Register every model-facing tool.
 * @param ctx - the host plugin context.
 * @param operations - the shared implementation.
 * @returns nothing; registration is an effect of the calling fiber.
 */
export function registerTools(
  ctx: Context,
  operations: BridgeOperations,
): void {
  const register = (tool: ToolDefinition): void => {
    ctx.effect(() => ctx.tools.register(tool), `cli-bridge: ${tool.name}`);
  };

  register(delegateTool(ctx, operations));
  register(delegateAllTool(ctx, operations));
  register(replyTool(operations));
  if (!operations.config.adminTools) return;
  register(accountsTool(operations));
  register(toolchainTool(operations));
}

/**
 * The fields one task is described by.
 *
 * Declared once and placed twice: flat, as `cli_delegate`'s own parameters, and
 * as the item shape of `cli_delegate_all`'s list. One task or ten, the model is
 * asked for exactly the same five things.
 * @param defaultCli - the delegate used when a task names none.
 * @returns the parameter fields.
 */
function taskFields(defaultCli: CliId) {
  return {
    prompt: {
      type: 'string',
      required: true,
      description:
        'The task, stated as you would state it to a capable engineer.',
    },
    cli: {
      type: 'string',
      enum: [...CLI_IDS],
      description:
        `Which agent to use (claude or codex). Defaults to ${defaultCli}.`,
    },
    account: {
      type: 'string',
      description: "Account to run as. Defaults to that agent's default.",
    },
    model: {
      type: 'string',
      description: "Model to use. Defaults to the agent's own.",
    },
    effort: {
      type: 'string',
      enum: [...EFFORT_LEVELS],
      description: 'How hard the agent should think.',
    },
  } as const satisfies ParameterSchemaSpec;
}

/** What the model supplied for one task. */
type TaskArgs = InferArgs<ReturnType<typeof taskFields>>;

/** `cli_delegate` — hand one task to a delegate CLI and wait for its report. */
function delegateTool(
  ctx: Context,
  operations: BridgeOperations,
): ToolDefinition {
  const { defaultCli } = operations.config;
  return defineTool({
    name: 'cli_delegate',
    description: [
      'Hand one coding task to Claude Code or Codex and wait for it to finish. The user watches the whole run',
      'live in the web interface, while you receive only how it ended — so handing off work costs you almost',
      'nothing. Use it for one self-contained task you want carried out end to end. If it comes back with',
      'status "needs_direction", answer the question with cli_reply.',
    ].join(' '),
    parameters: taskFields(defaultCli),
    output: {
      schema: DELEGATION,
      render: (_args, value) => [{ type: 'text', text: describe(value) }],
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'execute',
      title: `${adapterFor(args.cli ?? defaultCli).displayName}: ${
        oneLineLabel(args.prompt, TITLE_CHARS)
      }`,
      rawInput: args.prompt,
    }),
    async execute(args, exec) {
      const [result] = await delegate(ctx, operations, [
        taskOf(args, defaultCli),
      ], exec);
      /* v8 ignore next -- a one-task batch always yields one entry. */
      if (result === undefined) {
        throw new BridgeError(
          'the delegation produced no result',
          'INVALID_REQUEST',
        );
      }
      return result;
    },
  });
}

/** `cli_delegate_all` — hand out several tasks at once, each isolated. */
function delegateAllTool(
  ctx: Context,
  operations: BridgeOperations,
): ToolDefinition {
  const { defaultCli } = operations.config;
  return defineTool({
    name: 'cli_delegate_all',
    description: [
      'Hand several independent tasks to Claude Code or Codex at once — optionally different agents and',
      'accounts — and wait for all of them. Each task runs in its own isolated branch so they cannot overwrite',
      'each other, and finished work is merged back automatically, one at a time. Use this when the tasks are',
      'genuinely independent; use cli_delegate when one task depends on another. Anything that could not be',
      'merged is kept on its branch and reported, so nothing is lost.',
    ].join(' '),
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        description:
          'The tasks, run in parallel. Order is preserved in the result.',
        items: {
          type: 'object',
          properties: taskFields(defaultCli),
          additionalProperties: false,
        },
      },
    },
    output: {
      schema: BATCH,
      render: (_args, value) => [{ type: 'text', text: renderBatch(value) }],
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'execute',
      title: `${String(args.tasks.length)} tasks in parallel`,
      rawInput: args.tasks.map((task) => oneLineLabel(task.prompt, TITLE_CHARS))
        .join('\n'),
    }),
    async execute(args, exec) {
      if (args.tasks.length === 0) {
        throw new BridgeError('tasks is empty', 'INVALID_REQUEST');
      }
      return {
        delegations: await delegate(
          ctx,
          operations,
          args.tasks.map((task) => taskOf(task, defaultCli)),
          exec,
        ),
      };
    },
  });
}

/** `cli_reply` — answer a delegation that asked for direction, or send it more work. */
function replyTool(operations: BridgeOperations): ToolDefinition {
  return defineTool({
    name: 'cli_reply',
    description: [
      'Continue a task that stopped to ask a question: answer it, or send follow-up work. The agent picks up',
      'its own session with everything it already did still in context, under the same account, model and',
      'settings. Returns the same result as cli_delegate.',
    ].join(' '),
    parameters: {
      delegation: {
        type: 'string',
        required: true,
        description:
          'Delegation id from a previous cli_delegate, cli_delegate_all or cli_reply result.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'Your answer or your follow-up instruction.',
      },
    },
    output: {
      schema: DELEGATION,
      render: (_args, value) => [{ type: 'text', text: describe(value) }],
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'execute',
      title: `Continue ${args.delegation}: ${
        oneLineLabel(args.message, TITLE_CHARS)
      }`,
      rawInput: args.message,
    }),
    async execute(args, exec) {
      const entry = await operations.replyToDelegation(
        args.delegation as DelegationId,
        args.message,
        {
          signal: exec.signal,
          callId: exec.callId,
          ...exec.agent === undefined
            ? {}
            : { agent: exec.agent, sessionId: exec.agent.id },
        },
      );
      return project(operations, entry.snapshot);
    },
  });
}

/** `cli_accounts` — inspect and manage the delegate accounts. */
function accountsTool(operations: BridgeOperations): ToolDefinition {
  return defineTool({
    name: 'cli_accounts',
    description: [
      'List or manage the accounts Claude Code and Codex sign in with. Each account is a separate, private',
      'sign-in, so several subscriptions or API keys coexist on one machine. The built-in "ambient" account',
      'runs an agent exactly as the user already configured it. Signing in opens a sign-in box in the web',
      'interface, where the user types their code and presses Enter. Tell the user they can do all of this',
      'themselves in the panel too — either path works.',
    ].join(' '),
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: ['list', 'add', 'remove', 'set_default', 'login'],
        description: 'What to do.',
      },
      cli: {
        type: 'string',
        enum: [...CLI_IDS],
        description: 'Which agent (claude or codex). Required except for list.',
      },
      id: {
        type: 'string',
        description:
          'Account id: lowercase letters, digits, dot, dash, underscore.',
      },
      label: {
        type: 'string',
        description: 'Human-readable name for a new account.',
      },
      auth: {
        type: 'string',
        enum: ['session', 'api-key', 'endpoint'],
        description:
          "How it signs in: the agent's own login, an API key, or a custom endpoint.",
      },
      credential_ref: {
        type: 'string',
        description:
          'Name of the stored secret that holds the API key or token.',
      },
      base_url: {
        type: 'string',
        description:
          'HTTP(S) endpoint for an "endpoint" account, e.g. https://api.deepseek.com/anthropic.',
      },
      model: {
        type: 'string',
        description:
          'Default model for an "endpoint" account, e.g. deepseek-chat.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          run: { type: 'string' },
          accounts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                cli: { type: 'string' },
                label: { type: 'string' },
                auth: { type: 'string' },
                isDefault: { type: 'boolean' },
                credentialConfigured: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render: (
        _args,
        value,
      ) => [{ type: 'text', text: (value as { message: string }).message }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `cli accounts: ${args.op}`,
      rawInput: args.id,
    }),
    async execute(args, exec) {
      const cli = requireCli(args.op, args.cli as CliId | undefined);
      const id = requireId(args.op, args.id);
      let run: string | undefined;
      switch (args.op) {
        case 'add':
          await operations.addAccount({
            cli: cli!,
            id: id!,
            auth: (args.auth ?? 'session') as AccountAuth,
            ...args.label === undefined ? {} : { label: args.label },
            ...args.credential_ref === undefined
              ? {}
              : { credentialRef: args.credential_ref },
            ...args.base_url === undefined ? {} : { baseUrl: args.base_url },
            ...args.model === undefined ? {} : { model: args.model },
          });
          break;
        case 'remove':
          await operations.accounts.remove(cli!, id!);
          break;
        case 'set_default':
          await operations.accounts.setDefault(cli!, id!);
          break;
        case 'login':
          run = (await operations.runs.startLogin(cli!, id!, exec.agent?.id))
            .snapshot.id;
          break;
        default:
          break;
      }
      const accounts = await operations.accounts.list(cli);
      // The conditional key is the point: an absent credential must stay
      // absent rather than become an explicit `undefined` in the canonical value.
      // oxlint-disable-next-line oxc/no-map-spread
      const rows = accounts.map((account) => ({
        id: account.id,
        cli: account.cli,
        label: account.label,
        auth: describeAuth(account, adapterFor(account.cli)),
        isDefault: account.isDefault,
        ...account.credentialConfigured === undefined
          ? {}
          : { credentialConfigured: account.credentialConfigured },
      }));
      const heading = run === undefined
        ? `${accounts.length} account(s)`
        : `sign-in started; finish it in the sign-in box that opened in the web interface (type, then press Enter)`;
      return {
        message: [
          heading,
          ...rows.map((row) =>
            `- ${row.cli}/${row.id}${
              row.isDefault ? ' (default)' : ''
            } — ${row.label} — ${row.auth}`
          ),
        ].join('\n'),
        accounts: rows,
        ...run === undefined ? {} : { run },
      };
    },
  });
}

/** `cli_toolchain` — inspect, install, and update the delegate CLIs. */
function toolchainTool(operations: BridgeOperations): ToolDefinition {
  return defineTool({
    name: 'cli_toolchain',
    description: [
      'Inspect, install or update Claude Code and Codex themselves. A missing agent is normally installed on',
      'first use, so this is mainly for checking versions or forcing an update.',
    ].join(' '),
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: ['status', 'install', 'update'],
        description: 'What to do.',
      },
      cli: {
        type: 'string',
        enum: [...CLI_IDS],
        description: 'Which delegate. Required for install and update.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          toolchain: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                cli: { type: 'string' },
                source: { type: 'string' },
                version: { type: 'string' },
                path: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render: (
        _args,
        value,
      ) => [{ type: 'text', text: (value as { message: string }).message }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `cli toolchain: ${args.op}`,
      kind: 'execute',
    }),
    async execute(args) {
      if (args.op !== 'status') {
        if (args.cli === undefined) {
          throw new BridgeError(
            `cli is required for ${args.op}`,
            'INVALID_REQUEST',
          );
        }
        const response = await operations.control({
          op: 'toolchain.install',
          cli: args.cli as CliId,
        });
        if (!response.ok) {
          throw new BridgeError(response.error, 'INSTALL_FAILED');
        }
      }
      const toolchain = await operations.toolchain.statuses();
      return {
        message: toolchain.map((entry) =>
          `- ${entry.cli}: ${entry.source}${
            entry.version === undefined ? '' : ` ${entry.version}`
          }` +
          `${entry.path === undefined ? '' : ` (${entry.path})`}`
        ).join('\n'),
        // As above: an unknown version must be an absent key, not an explicit undefined.
        // oxlint-disable-next-line oxc/no-map-spread
        toolchain: toolchain.map((entry) => ({
          cli: entry.cli,
          source: entry.source,
          ...entry.version === undefined ? {} : { version: entry.version },
          ...entry.path === undefined ? {} : { path: entry.path },
        })),
      };
    },
  });
}

/** What one tool call knows about itself. */
interface Call {
  readonly agent?: Agent;
  readonly callId: string;
  readonly signal: AbortSignal;
}

/**
 * One task, as the runtime wants it.
 * @param args - what the model supplied.
 * @param defaultCli - the delegate to use when none was named.
 * @returns the task.
 */
function taskOf(args: TaskArgs, defaultCli: CliId): BatchTask {
  return {
    cli: args.cli ?? defaultCli,
    prompt: args.prompt,
    ...args.account === undefined ? {} : { account: args.account },
    ...args.model === undefined ? {} : { model: args.model },
    ...args.effort === undefined ? {} : { effort: args.effort as EffortLevel },
  };
}

/**
 * Run a batch under the harness's own permissions and project the outcome.
 *
 * The tool call's cancellation is handed straight to the batch: a call that
 * stops being awaited must not leave another agent writing to the workspace.
 * @param ctx - the host plugin context.
 * @param operations - the shared implementation.
 * @param tasks - what to delegate.
 * @param call - the tool call.
 * @returns one canonical value per task, in order.
 */
async function delegate(
  ctx: Context,
  operations: BridgeOperations,
  tasks: readonly BatchTask[],
  call: Call,
): Promise<DelegationResult[]> {
  const { mode, workspaceRoot } = resolvePermission(ctx, call.agent);
  const entries = await operations.startBatch({
    tasks,
    permission: mode,
    base: workspaceRoot,
    callId: call.callId,
    signal: call.signal,
    ...call.agent === undefined
      ? {}
      : { agent: call.agent, sessionId: call.agent.id },
  });
  return entries.map((entry) => project(operations, entry.snapshot));
}

/**
 * Project a settled delegation onto the canonical value.
 *
 * This is the ONLY thing that crosses into DeepSeek's context: how it ended, who
 * decided what along the way, and what became of the work. Never the transcript.
 * @param operations - the shared implementation, for the streamed byte count.
 * @param snapshot - the settled delegation.
 * @returns the canonical value.
 */
function project(
  operations: BridgeOperations,
  snapshot: DelegationSnapshot,
): DelegationResult {
  const end = snapshot.end;
  const { mode, path, branch, merge, detail } = snapshot.workspace;
  return {
    delegation: snapshot.id,
    cli: snapshot.cli,
    account: snapshot.account,
    status: end?.status ?? 'cancelled',
    summary: end?.summary ?? '',
    rounds: snapshot.rounds.length,
    durationMs: (snapshot.finishedAt ?? snapshot.startedAt) -
      snapshot.startedAt,
    streamedBytes: operations.runs.bytesOf(snapshot.rounds),
    // oxlint-disable-next-line oxc/no-map-spread
    decisions: snapshot.decisions.map((decision) => ({
      round: decision.round,
      kind: decision.kind,
      source: decision.source,
      reason: decision.reason,
    })),
    directions: snapshot.directions.map((direction) => direction.text),
    workspace: {
      mode,
      path,
      merge,
      ...branch === undefined ? {} : { branch },
      ...detail === undefined ? {} : { detail },
    },
    ...end?.question === undefined ? {} : { question: end.question },
    ...end?.error === undefined ? {} : { error: end.error },
    ...end?.nextSteps === undefined ? {} : { nextSteps: end.nextSteps },
    ...snapshot.usage === undefined ? {} : { usage: snapshot.usage },
  };
}

/**
 * Describe one delegation outcome to the model.
 *
 * Every description ends by saying where the output went, because the single
 * most likely wrong next move is asking for a transcript that deliberately does
 * not exist in this conversation.
 * @param value - the canonical value, possibly replayed from an older version.
 * @returns the model-facing text.
 */
function describe(value: DelegationResult): string {
  // Every field is optional in the canonical schema, and this renderer also runs
  // on REPLAY of a value logged by an older version of the plugin, so each one
  // is read with a default rather than asserted.
  const {
    delegation = 'unknown',
    cli = 'delegate',
    account = 'ambient',
    status = 'completed',
    summary = '',
    rounds = 1,
    durationMs = 0,
    streamedBytes = 0,
  } = value;
  const spent = rounds === 1 ? '1 round' : `${String(rounds)} rounds`;
  const body: string[] = [
    `${cli} delegation ${delegation} (${account}) ${status} in ${
      (durationMs / 1000).toFixed(1)
    }s over ${spent}`,
  ];
  switch (status) {
    case 'needs_direction':
      body.push(
        '',
        'It needs a decision before it can continue:',
        '',
        value.question ?? '',
      );
      if (summary.length > 0) body.push('', 'What it did so far:', summary);
      body.push(
        '',
        `Answer with cli_reply(delegation: "${delegation}", message: ...).`,
      );
      break;
    case 'failed':
      body.push('', `Failed: ${value.error ?? 'unknown error'}`);
      if (summary.length > 0) body.push('', summary);
      break;
    case 'cancelled':
      body.push('', 'The delegation was cancelled.');
      if (summary.length > 0) body.push('', summary);
      break;
    default:
      if (summary.length > 0) body.push('', summary);
      break;
  }
  if (value.nextSteps !== undefined) {
    body.push('', `It says the remaining work is: ${value.nextSteps}`);
  }
  const directions = value.directions ?? [];
  if (directions.length > 0) {
    body.push(
      '',
      'Standing directions it worked under:',
      ...directions.map((text) => `- ${text}`),
    );
  }
  const decided = (value.decisions ?? []).filter((decision) =>
    decision.source !== 'policy'
  );
  if (decided.length > 0) {
    body.push(
      '',
      'Decisions between rounds:',
      ...decided.map((decision) =>
        `- round ${String(decision.round ?? 0)}: ${
          decision.kind ?? 'finish'
        } by ${decision.source ?? 'policy'}` +
        ` — ${decision.reason ?? ''}`
      ),
    );
  }
  const workspace = describeWorkspace(value.workspace);
  if (workspace !== undefined) body.push('', workspace);
  if (value.usage !== undefined) {
    body.push('', `Delegate usage: ${describeUsage(value.usage)}`);
  }
  body.push(
    '',
    `${
      formatBytes(streamedBytes)
    } of delegate output streamed to the user interface and is not repeated here.`,
  );
  return body.join('\n');
}

/** Describe every delegation of a batch, in the order they were asked for. */
function renderBatch(value: BatchResult): string {
  const delegations = value.delegations ?? [];
  if (delegations.length === 0) return 'No delegations ran.';
  return delegations.map((entry) => describe(entry)).join('\n\n---\n\n');
}

/**
 * What became of an isolated delegation's work.
 *
 * Silent for the ordinary case — work done in the session's own workspace has
 * nothing to report — and explicit whenever a branch is still holding something.
 * @param workspace - the workspace state, absent in a replayed value.
 * @returns one line, or nothing.
 */
function describeWorkspace(
  workspace: DelegationResult['workspace'],
): string | undefined {
  if (workspace === undefined || workspace.mode !== 'worktree') {
    return undefined;
  }
  const branch = workspace.branch ?? 'its branch';
  const detail = workspace.detail === undefined ? '' : ` — ${workspace.detail}`;
  switch (workspace.merge) {
    case 'merged':
      return `Its work was committed on ${branch} and merged back.`;
    case 'conflict':
      return `Its work conflicts on merge and is still on ${branch}${detail}. Resolving it is the user's call.`;
    case 'failed':
      return `Its work could not be merged and is still on ${branch}${detail}.`;
    case 'skipped':
      return `Its work was not merged${detail}.`;
    default:
      return `Its work is on ${branch}${detail}.`;
  }
}

/** One-line usage summary. */
function describeUsage(usage: NonNullable<DelegationResult['usage']>): string {
  const parts = [
    usage.inputTokens === undefined
      ? undefined
      : `${String(usage.inputTokens)} in`,
    usage.cachedInputTokens === undefined
      ? undefined
      : `${String(usage.cachedInputTokens)} cached`,
    usage.outputTokens === undefined
      ? undefined
      : `${String(usage.outputTokens)} out`,
    usage.costUsd === undefined ? undefined : `$${usage.costUsd.toFixed(4)}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? 'not reported' : parts.join(', ');
}

/** Human-readable byte count. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Read the permission mode and workspace this run inherits.
 *
 * This plugin has no permission model of its own. The harness's mode — the
 * Read Only / Workspace Write / Full Access selector — is the whole policy, and
 * each adapter maps that one value onto its CLI's own coarse flags. A
 * composition without the sandbox-policy seam gets the same default that seam
 * ships with, which is the most restrictive one.
 * @param ctx - the host plugin context.
 * @param agent - the calling agent, when there is one.
 * @returns the inherited mode and workspace root.
 */
function resolvePermission(
  ctx: Context,
  agent?: Agent,
): { mode: PermissionMode; workspaceRoot: string } {
  const policy = ctx.get('sandboxPolicy');
  if (policy === undefined) {
    return { mode: 'read-only', workspaceRoot: process.cwd() };
  }
  const resolved = policy.resolve(
    agent === undefined ? {} : { session: agent.session },
  );
  return { mode: resolved.mode, workspaceRoot: resolved.workspaceRoot };
}

/** Require a delegate id for the operations that need one. */
function requireCli(op: string, cli: CliId | undefined): CliId | undefined {
  if (op === 'list') return cli;
  if (cli === undefined) {
    throw new BridgeError(`cli is required for ${op}`, 'INVALID_REQUEST');
  }
  return cli;
}

/** Require an account id for the operations that need one. */
function requireId(op: string, id: string | undefined): string | undefined {
  if (op === 'list') return id;
  if (id === undefined) {
    throw new BridgeError(`id is required for ${op}`, 'INVALID_REQUEST');
  }
  return id;
}
