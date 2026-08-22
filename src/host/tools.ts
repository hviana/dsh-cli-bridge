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
import type { Config } from '../config.ts';
import { adapterFor } from '../domain/adapters/index.ts';
import {
  modelChoices,
  resolveModel,
  unknownModelHint,
} from '../domain/models.ts';
import { oneLineLabel } from '../domain/text.ts';
import { bareAccountId, describeAuth } from '../runtime/accounts.ts';
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

/** One thing that shaped the delegation from outside the work itself. */
const DIAGNOSTIC = {
  type: 'object',
  properties: {
    level: { type: 'string', enum: ['info', 'warn', 'error'] },
    text: { type: 'string' },
  },
  additionalProperties: false,
} as const;

/** What the harness was allowed to decide on the user's behalf, and where. */
const AUTONOMY = {
  type: 'object',
  properties: {
    decide: {
      type: 'boolean',
      description: 'Whether a delegate question was answered without the user.',
    },
    continue: {
      type: 'boolean',
      description:
        'Whether declared remaining work was pushed on automatically.',
    },
    review: {
      type: 'boolean',
      description: 'Whether the finished work was reviewed automatically.',
    },
    advisor: {
      type: 'string',
      description:
        'The model route those decisions ran on. ABSENT means no route could be resolved, so every switch above was inert however it is set — the user has to turn it on with a usable route, and until then questions come to them.',
    },
  },
  additionalProperties: false,
} as const;

/** Canonical value every delegation tool returns, per delegation. */
const DELEGATION = {
  type: 'object',
  properties: {
    delegation: {
      type: 'string',
      description:
        'This task\'s id. Pass it as cli_reply(delegation: "<this>") to answer it or send follow-up work.',
    },
    cli: { type: 'string' },
    account: { type: 'string' },
    model: {
      type: 'string',
      description:
        'The model the delegate actually ran on, canonical. Absent when the delegate used its own default.',
    },
    effort: {
      type: 'string',
      enum: [...EFFORT_LEVELS],
      description:
        'The effort the delegate ran with. Absent when it used its own default.',
    },
    status: {
      type: 'string',
      enum: [
        'completed',
        'needs_direction',
        'failed',
        'timed_out',
        'cancelled',
      ],
      description:
        'completed — done. needs_direction — it asked a question, answer with cli_reply. failed — read "error". timed_out — the run hit its time budget but its session is preserved; continue it with cli_reply, never start over. cancelled — it was stopped.',
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
    diagnostics: {
      type: 'array',
      items: DIAGNOSTIC,
      description:
        'Anything that shaped this task from outside the work itself: an autonomy setting that could not act, an arbiter that answered nothing, a model name nobody recognized. Empty in the ordinary case; read it whenever the outcome is not what you expected, and repeat a warning to the user rather than guessing at the cause.',
    },
    autonomy: AUTONOMY,
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
 *
 * Only `prompt` is required, and each remaining description says what happens
 * when it is left out, because the cheapest correct call is the one that omits
 * everything it does not need. The model field goes further and NAMES the
 * accepted values: it is the one parameter whose valid values a caller cannot
 * derive from anything, and a caller that has to guess will guess `opus-5` when
 * the id is `claude-opus-5` — a wrong call that costs a whole delegate run to
 * discover. Listing them here means the first call is right.
 * @param config - the resolved plugin config, for defaults and the model lists.
 * @returns the parameter fields.
 */
function taskFields(config: Config) {
  const { defaultCli } = config;
  return {
    prompt: {
      type: 'string',
      required: true,
      description:
        'What to do, written for a capable engineer who cannot ask you anything back: the goal, where in the project it applies if you know, and what counts as done. Include the details you already have — file paths, error text, the command that fails. Long is fine; a one-line prompt gets a one-line guess.',
    },
    cli: {
      type: 'string',
      enum: [...CLI_IDS],
      description:
        `Which delegate does the work: "claude" for Claude Code, "codex" for Codex. Omit to use "${defaultCli}".`,
    },
    account: {
      type: 'string',
      description:
        'Which sign-in to run under, as an id from cli_accounts(op:"list") — both "personal" and "claude/personal" are accepted. Omit this unless the user asked for a particular account: the default account is used, and that is almost always what they want.',
    },
    model: {
      type: 'string',
      description: modelParameterDescription(config),
    },
    effort: {
      type: 'string',
      enum: [...EFFORT_LEVELS],
      description:
        'How hard the delegate thinks, lowest to highest: "low", "medium", "high", "xhigh", "max" — only these five, anything else is refused. Omit for the delegate\'s own default. Codex has no "max": there "max" runs as "xhigh". Raise it for design, debugging and anything underspecified; "low" suits mechanical edits.',
    },
    timeoutMs: {
      type: 'number',
      description:
        'Wall-clock budget in milliseconds for ONE delegate run (one phase). The delegate is told this budget and asked to finish a coherent phase within it, declaring remaining work with NEXT_STEPS when it cannot finish. On expiry the run is stopped but its session is preserved and resumable with cli_reply — never lost, never re-studied from zero. Omit to use the deployment default.',
    },
  } as const satisfies ParameterSchemaSpec;
}

/**
 * The model parameter's description, with every accepted name in it.
 *
 * Written as an instruction rather than a label, and stating the failure mode
 * explicitly, because "Model to use" is what produced the guessing this replaces.
 * @param config - the resolved config, for each delegate's extra model ids.
 * @returns the description.
 */
function modelParameterDescription(config: Config): string {
  const lists = CLI_IDS.map((cli) =>
    `For ${adapterFor(cli).displayName} (cli:"${cli}"): ${
      modelChoices(cli, config.delegates[cli].extraModels)
    }.`
  );
  return [
    'Which model the delegate runs on. OMIT IT unless the user named a model — the default is the right choice for ordinary work.',
    'When you do set it, copy one of these exactly; do not invent or abbreviate an id.',
    ...lists,
    'The short forms in parentheses are accepted too, as are the same names with different punctuation ("opus 5", "opus-5"). Anything else is handed to the CLI as written and will probably be rejected by it.',
  ].join(' ');
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
      'Give ONE coding task to Claude Code or Codex and wait here until it finishes. Use it for work you want carried out end to end — writing, fixing, refactoring, investigating in a repository. The user watches every command and file change live in the web interface; you receive only how it ended, so delegating costs you almost no context.',
      'Smallest correct call: cli_delegate(prompt: "<the task>"). Every other parameter is optional and defaults to something sensible — set one only when the user asked for it.',
      'Then read "status". It tells you your next move, and there is exactly one per status:',
      '- "completed": the work is done. Report "summary" to the user. If "nextSteps" is filled in, work remains — send it on with cli_reply.',
      '- "needs_direction": it stopped to ask the question in "question". Answer it with cli_reply(delegation: "<the delegation field>", message: "<your answer>"). Do NOT start a new task instead.',
      '- "failed": read "error", fix that cause, then call again. If "error" is a timeout or the delegate still reported a session, the session is preserved — continue it with cli_reply rather than re-paying the study.',
      '- "timed_out": the run hit its time budget, but its session (context + cached tokens) is preserved. Continue it with cli_reply(delegation: "<the delegation field>", message: "<what to do next>"). NEVER start a new task — that discards the study and pays for it twice.',
      '- "cancelled": it was stopped deliberately. Do not retry unless the user asks.',
      'Read "diagnostics" whenever the outcome is not what you expected — an autonomy setting that could not act, or a model name nobody recognized, is reported there and nowhere else.',
      "The delegate's commands, edits and reasoning are NOT in the result and cannot be fetched afterwards: they went to the user's screen. If you need more than the summary, ask the user.",
    ].join('\n'),
    parameters: taskFields(operations.config),
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
        taskOf(args, operations.config),
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
  return defineTool({
    name: 'cli_delegate_all',
    description: [
      'Give SEVERAL independent coding tasks to Claude Code or Codex at once — to both delegates and different accounts if you like — and wait for all of them. Each task gets its own git branch and worktree, so they cannot overwrite each other, and finished work is merged back one task at a time.',
      'Use it only when the tasks do not depend on each other and do not edit the same code. When one task needs the result of another, run them one after another with cli_delegate instead.',
      'Call it as cli_delegate_all(tasks: [{prompt: "..."}, {prompt: "..."}]). Each entry takes the same fields as cli_delegate and needs nothing but "prompt".',
      'The result has one entry per task, in the order you listed them. Read each entry exactly as you would read a cli_delegate result — the statuses and the next moves are identical, and each entry has its own delegation id for cli_reply.',
      'Work that could not be merged is not lost: it stays on its branch and the "workspace" field says so. Tell the user when that happens — resolving it is theirs to do.',
    ].join('\n'),
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        description:
          'One entry per task, each with a "prompt" and optionally "cli", "account", "model" and "effort" — no other keys. They run in parallel and the result keeps this order.',
        items: {
          type: 'object',
          properties: taskFields(operations.config),
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
        throw new BridgeError(
          'tasks is empty: pass one entry per task, as tasks: [{prompt: "..."}]. For a single task, cli_delegate is simpler.',
          'INVALID_REQUEST',
        );
      }
      return {
        delegations: await delegate(
          ctx,
          operations,
          args.tasks.map((task) => taskOf(task, operations.config)),
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
      'Continue a task that has already run: answer the question it stopped on, or send it more work. It resumes its own session with everything it already did still in context, under the same delegate, account, model and settings — so you never have to restate the task.',
      'Call it as cli_reply(delegation: "<id>", message: "<what to tell it>"). Both are required.',
      'Use it when a result came back with status "needs_direction" (answer the "question" field), when a result came back "completed" with "nextSteps" still filled in, when a result came back "timed_out" (the session is preserved — continue it), or when the user asks for a change to work that was just done.',
      'It can also resume a delegation whose session still exists even if the round "failed" for another reason — resuming the session is always cheaper than starting over, because the delegate re-reads its own context instead of re-studying the project.',
      'The result has the same shape as cli_delegate, including a delegation id of its own for the next reply. It can itself come back "needs_direction" — answer that one the same way.',
    ].join('\n'),
    parameters: {
      delegation: {
        type: 'string',
        required: true,
        description:
          'The "delegation" value from an earlier cli_delegate, cli_delegate_all or cli_reply result — copy it exactly, do not invent one. Each reply returns a new id; always use the newest.',
      },
      message: {
        type: 'string',
        required: true,
        description:
          'What to tell it: your answer to its question, or the next instruction. Be specific — this text is sent to the delegate verbatim.',
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
      if (args.message.trim().length === 0) {
        throw new BridgeError(
          'message is empty: say what to tell the delegate.',
          'INVALID_REQUEST',
        );
      }
      const session = exec.agent?.id;
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
      ).catch(async (error: unknown) => {
        // A wrong id is the one mistake a caller cannot correct from the
        // message alone, so the refusal names the ids that DO exist here —
        // including the resumable sessions a previous process persisted.
        if (!(error instanceof BridgeError) || error.code !== 'UNKNOWN_RUN') {
          throw error;
        }
        const hint = await knownDelegations(operations, session);
        throw new BridgeError(`${error.message}. ${hint}`, error.code);
      });
      return project(operations, entry.snapshot);
    },
  });
}

/** `cli_accounts` — inspect and manage the delegate accounts. */
function accountsTool(operations: BridgeOperations): ToolDefinition {
  return defineTool({
    name: 'cli_accounts',
    description: [
      'List and manage the sign-ins Claude Code and Codex run under. Each account is a separate private sign-in, so several subscriptions or API keys coexist on one machine. The built-in account "ambient" runs the CLI exactly as the user already configured it on this machine, and it is the default — so delegating works before any account exists here.',
      'One "op" per call, and each op needs exactly these parameters:',
      '- op:"list" — nothing else required. Add cli to list only that delegate. Do this first when you need an account id.',
      '- op:"add" — needs cli, and auth ("session" for a normal login, "api-key" for a stored key, "endpoint" for another provider). Omit id and one is minted for you. "api-key" takes credential_ref; "endpoint" needs base_url and credential_ref, and may take model.',
      '- op:"login" — needs cli and id. Opens a sign-in box in the web interface for the user to type their code into; it does not sign in by itself.',
      '- op:"set_default" — needs cli and id. Makes that account the one used when a task names none.',
      '- op:"remove" — needs cli and id. Deletes the account and its private home.',
      'Every call answers with the full account list, so you never need a second call to see the result. Tell the user they can do all of this themselves in the web interface — either path works.',
    ].join('\n'),
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: ['list', 'add', 'remove', 'set_default', 'login'],
        description:
          "Which operation to run. See the parameter each one needs in this tool's description.",
      },
      cli: {
        type: 'string',
        enum: [...CLI_IDS],
        description:
          'Which delegate the account belongs to: "claude" or "codex". Required for add, login, set_default and remove; optional for list, where it narrows the listing.',
      },
      id: {
        type: 'string',
        description:
          'The account id. Required for login, set_default and remove — copy it from op:"list" ("personal" and "claude/personal" are both accepted). Omit it for add and a fresh id is minted. Ids are lowercase letters, digits, dot, dash and underscore.',
      },
      label: {
        type: 'string',
        description:
          'A human-readable name for a new account, shown in listings. Optional; add only.',
      },
      auth: {
        type: 'string',
        enum: ['session', 'api-key', 'endpoint'],
        description:
          'How a new account signs in: "session" is the CLI\'s own login (the usual choice), "api-key" uses a key from the harness credential store, "endpoint" points the CLI at another compatible provider. Defaults to "session". add only.',
      },
      credential_ref: {
        type: 'string',
        description:
          'Name of the stored secret holding the key or token, as an environment-variable name (e.g. "ANTHROPIC_API_KEY"). Required for auth:"endpoint"; optional for auth:"api-key", where the delegate\'s usual variable is assumed. add only.',
      },
      base_url: {
        type: 'string',
        description:
          'The provider endpoint for auth:"endpoint", as an http(s) URL — e.g. "https://api.deepseek.com/anthropic". Required for that auth and ignored otherwise.',
      },
      model: {
        type: 'string',
        description:
          'Default model for an auth:"endpoint" account, named the way that provider names it — e.g. "deepseek-chat". Optional; add only.',
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
            ...id === undefined ? {} : { id },
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
      'Check which delegate CLIs are installed, or install and update them. A missing CLI is set up automatically the first time it is needed, so you rarely need this — reach for it to report versions, or when the user asks for the latest.',
      '- op:"status" — nothing else required; reports every delegate.',
      '- op:"install" or op:"update" — needs cli ("claude" or "codex"). Both fetch the latest; installing something already present is an update.',
    ].join('\n'),
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: ['status', 'install', 'update'],
        description:
          'Which operation to run. "status" reads, "install" and "update" both fetch the latest and require cli.',
      },
      cli: {
        type: 'string',
        enum: [...CLI_IDS],
        description:
          'Which delegate: "claude" or "codex". Required for install and update; omit for status, which covers both.',
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
            `cli_toolchain(op:"${args.op}") also needs cli. Call cli_toolchain(op:"${args.op}", cli:"${
              CLI_IDS.join('" | "')
            }"), or cli_toolchain(op:"status") to see both.`,
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
 *
 * The model name is canonicalized HERE, at the boundary, so everything
 * downstream — the delegation snapshot, the panel, the result, the CLI's own
 * `--model` flag — reads the same id no matter which spelling arrived. A name
 * the catalog does not know passes through unchanged; {@link modelWarning}
 * reports that beside the result rather than refusing the call, because a model
 * released after this plugin must still be usable.
 * @param args - what the model supplied.
 * @param config - the resolved config, for the default delegate and extra models.
 * @returns the task.
 */
function taskOf(args: TaskArgs, config: Config): BatchTask {
  const cli = (args.cli ?? config.defaultCli) as CliId;
  const model = resolveModel(
    cli,
    args.model,
    config.delegates[cli].extraModels,
  );
  return {
    cli,
    prompt: args.prompt,
    ...args.account === undefined ? {} : { account: args.account },
    ...model === undefined ? {} : { model: model.model },
    ...args.effort === undefined ? {} : { effort: args.effort as EffortLevel },
    ...args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs },
  };
}

/**
 * Refuse a task nothing could act on, before anything is started.
 *
 * Two checks, both about a value only the caller can fix, and both cheap: an
 * account that does not exist, and a prompt with nothing in it. Doing this here
 * rather than letting the batch discover it is the difference between one
 * corrected call and a delegation that cuts a worktree, spawns nothing, and
 * comes back failed — and it lets the refusal name the ids that DO exist, which
 * is what makes the second attempt right instead of another guess.
 * @param operations - the shared implementation, for the account listing.
 * @param tasks - the tasks about to be delegated.
 * @throws {BridgeError} `INVALID_REQUEST` naming the accepted values.
 */
async function checkTasks(
  operations: BridgeOperations,
  tasks: readonly BatchTask[],
): Promise<void> {
  for (const [index, task] of tasks.entries()) {
    const where = tasks.length === 1 ? '' : ` (task ${String(index + 1)})`;
    if (task.prompt.trim().length === 0) {
      throw new BridgeError(
        `prompt is empty${where}: say what the delegate should do.`,
        'INVALID_REQUEST',
      );
    }
    if (task.account === undefined) continue;
    // Sequential by necessity: each check reads the same registry, and the
    // first bad account is the one worth reporting.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const known = await operations.accounts.list(task.cli);
    if (
      !known.some((account) =>
        account.id === bareAccountId(task.cli, task.account ?? '')
      )
    ) {
      throw new BridgeError(
        `no ${task.cli} account named ${
          JSON.stringify(task.account)
        }${where}.` +
          ` Accounts for ${task.cli}: ${
            known.map((account) =>
              account.isDefault ? `${account.id} (default)` : account.id
            ).join(', ')
          }.` +
          ' Omit "account" to use the default, or list them with cli_accounts(op:"list").',
        'INVALID_REQUEST',
      );
    }
  }
}

/**
 * What to say about a model name the catalog did not recognize.
 * @param task - the task as it will run.
 * @param config - the resolved config, for the delegate's extra model ids.
 * @returns one diagnostic, or nothing when the name was recognized.
 */
function modelWarning(
  task: BatchTask,
  config: Config,
): DelegationResult['diagnostics'] {
  const resolved = resolveModel(
    task.cli,
    task.model,
    config.delegates[task.cli].extraModels,
  );
  return resolved === undefined || resolved.known ? [] : [{
    level: 'warn',
    text: unknownModelHint(
      task.cli,
      resolved.model,
      config.delegates[task.cli].extraModels,
    ),
  }];
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
  await checkTasks(operations, tasks);
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
  return entries.map((entry, index) => {
    const task = tasks[index];
    return project(
      operations,
      entry.snapshot,
      task === undefined ? [] : modelWarning(task, operations.config),
    );
  });
}

/**
 * Project a settled delegation onto the canonical value.
 *
 * This is the ONLY thing that crosses into DeepSeek's context: how it ended, who
 * decided what along the way, and what became of the work. Never the transcript.
 *
 * The diagnostics are part of that on purpose. A delegation whose autonomy could
 * not act, or whose arbiter answered nothing, ends in a state that looks exactly
 * like the ordinary one — so the facts that explain the difference travel with
 * the outcome rather than only reaching the browser, where the model deciding
 * what to do next cannot see them.
 * @param operations - the shared implementation, for the streamed byte count.
 * @param snapshot - the settled delegation.
 * @param extra - diagnostics known to the tool layer rather than the delegation.
 * @returns the canonical value.
 */
function project(
  operations: BridgeOperations,
  snapshot: DelegationSnapshot,
  extra: DelegationResult['diagnostics'] = [],
): DelegationResult {
  const end = snapshot.end;
  const { mode, path, branch, merge, detail } = snapshot.workspace;
  const autonomy = snapshot.autonomy;
  // The DELEGATION's own terminal status is the fact the caller acts on, not
  // the last round's. A stop can settle a delegation whose last round
  // completed — cancelled while the next decision was being made — and
  // reading the round's status then reported "completed" for a task the user
  // cancelled, which invites exactly the wrong move: reporting the work done
  // instead of stopping.
  const status = snapshot.status === 'running' ||
      snapshot.status === 'awaiting-human'
    ? end?.status ?? 'cancelled'
    : snapshot.status;
  return {
    delegation: snapshot.id,
    cli: snapshot.cli,
    account: snapshot.account,
    status,
    summary: end?.summary ?? '',
    rounds: snapshot.rounds.length,
    diagnostics: [
      ...extra ?? [],
      // oxlint-disable-next-line oxc/no-map-spread
      ...snapshot.notes.map((note) => ({ level: note.level, text: note.text })),
    ],
    ...snapshot.model === undefined ? {} : { model: snapshot.model },
    ...snapshot.effort === undefined ? {} : { effort: snapshot.effort },
    ...autonomy === undefined ? {} : {
      autonomy: {
        decide: autonomy.decide,
        continue: autonomy.continue,
        review: autonomy.review,
        ...autonomy.advisor === undefined ? {} : {
          advisor: `${autonomy.advisor.provider}/${autonomy.advisor.model}`,
        },
      },
    },
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
  const effort = value.effort === undefined ? '' : `, effort ${value.effort}`;
  const body: string[] = [
    `${cli} delegation ${delegation} (${account}) ${status} in ${
      (durationMs / 1000).toFixed(1)
    }s over ${spent}${effort}`,
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
        `Next: answer it with cli_reply(delegation: "${delegation}", message: "<your answer>"). Do not start a new task.`,
      );
      break;
    case 'failed':
      body.push(
        '',
        `Failed: ${value.error ?? 'unknown error'}`,
        '',
        'Next: fix that cause and delegate again. Nothing is waiting on you here.',
      );
      if (summary.length > 0) body.push('', summary);
      break;
    case 'timed_out':
      body.push(
        '',
        `Timed out: ${value.error ?? 'the run exceeded its time budget'}`,
        '',
        `Its session is preserved and resumable. Continue it with cli_reply(delegation: "${delegation}", message: "<what to do next>"). Do NOT start a new task — that discards the study and pays for it twice.`,
      );
      if (summary.length > 0) body.push('', summary);
      break;
    case 'cancelled':
      body.push(
        '',
        'It was cancelled, so the work is unfinished. Do not retry unless the user asks.',
      );
      if (summary.length > 0) body.push('', summary);
      break;
    default:
      if (summary.length > 0) body.push('', summary);
      break;
  }
  if (value.nextSteps !== undefined) {
    body.push(
      '',
      `It says this work still remains: ${value.nextSteps}`,
      `Next: send it on with cli_reply(delegation: "${delegation}", message: "<what to do next>"), or tell the user it is outstanding.`,
    );
  }
  const directions = value.directions ?? [];
  if (directions.length > 0) {
    body.push(
      '',
      'Standing directions it worked under:',
      ...directions.map((text) => `- ${text}`),
    );
  }
  // Every decision, including the deterministic ones. Filtering those out was
  // hiding the single most useful line in the whole result — "autonomy.decide is
  // on but there is no model route to consult" is recorded as a policy decision,
  // and dropping it left a person watching their own setting do nothing with no
  // way to find out why.
  const decisions = value.decisions ?? [];
  if (decisions.length > 0) {
    body.push(
      '',
      'Decisions between rounds:',
      ...decisions.map((decision) =>
        `- round ${String(decision.round ?? 0)}: ${
          decision.kind ?? 'finish'
        } by ${decision.source ?? 'policy'}` +
        ` — ${decision.reason ?? ''}`
      ),
    );
  }
  const autonomy = value.autonomy;
  if (autonomy !== undefined) {
    const on = (['decide', 'continue', 'review'] as const).filter((name) =>
      autonomy[name] === true
    );
    if (on.length > 0) {
      body.push(
        '',
        autonomy.advisor === undefined
          ? `Autonomy (${
            on.join(', ')
          }) is on but had no model route, so it could not act: questions went to the user and the work stopped when the delegate said it was done.`
          : `Autonomy: ${on.join(', ')}, decided by ${autonomy.advisor}.`,
      );
    }
  }
  const diagnostics = value.diagnostics ?? [];
  if (diagnostics.length > 0) {
    body.push(
      '',
      'Worth knowing:',
      ...diagnostics.map((entry) =>
        `- ${entry.level ?? 'info'}: ${entry.text ?? ''}`
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
  if (workspace === undefined) return undefined;
  if (workspace.mode !== 'worktree') {
    // An inline workspace normally has nothing to say — the work happened
    // where the caller lives. The one case worth a line is an inline fallback
    // with a reason: isolation was wanted, and not had.
    return workspace.detail === undefined
      ? undefined
      : `Its work happened in the session workspace — ${workspace.detail}.`;
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

/**
 * Require a delegate id for the operations that need one.
 *
 * The refusal states the corrected call rather than the missing field, because a
 * caller that omitted a parameter has just demonstrated it does not know which
 * ones this op takes.
 * @param op - the operation asked for.
 * @param cli - the delegate the caller named, if any.
 * @returns the delegate, or `undefined` where the op does not need one.
 * @throws {BridgeError} `INVALID_REQUEST` showing the call that would work.
 */
function requireCli(op: string, cli: CliId | undefined): CliId | undefined {
  if (op === 'list') return cli;
  if (cli === undefined) {
    throw new BridgeError(
      `cli_accounts(op:"${op}") also needs cli. Call cli_accounts(op:"${op}", cli:"${
        CLI_IDS.join('" | "')
      }", …).`,
      'INVALID_REQUEST',
    );
  }
  return cli;
}

/**
 * Require an account id for the operations that need one; `add` mints its own.
 * @param op - the operation asked for.
 * @param id - the account id the caller named, if any.
 * @returns the id, or `undefined` where the op does not need one.
 * @throws {BridgeError} `INVALID_REQUEST` showing where to find a valid id.
 */
function requireId(op: string, id: string | undefined): string | undefined {
  if (op === 'list' || op === 'add') return id;
  if (id === undefined) {
    throw new BridgeError(
      `cli_accounts(op:"${op}") also needs id — the account it applies to. Run cli_accounts(op:"list") to see the ids, then call cli_accounts(op:"${op}", cli:…, id:…).`,
      'INVALID_REQUEST',
    );
  }
  return id;
}

/**
 * The delegation ids a caller could have meant.
 *
 * Ids are issued per process and a caller can only carry one it was given, so a
 * wrong one is almost always a stale id or an invented one — and the list of
 * live delegations plus the resumable sessions a previous process persisted is
 * what distinguishes those two cases.
 * @param operations - the shared implementation.
 * @param sessionId - the asking session, which fences what it may see.
 * @returns one sentence naming what exists, or saying nothing does.
 */
async function knownDelegations(
  operations: BridgeOperations,
  sessionId?: string,
): Promise<string> {
  const [live, persisted] = await Promise.all([
    Promise.resolve(operations.listDelegations(sessionId)),
    operations.sessions.list(sessionId),
  ]);
  if (live.length === 0 && persisted.length === 0) {
    // Two causes share this state — the session never delegated anything, or
    // everything it delegated is gone — and "no task has been delegated yet"
    // told the latter caller something false about its own history. The remedy
    // is the same either way: start again.
    return 'No task is available to continue in this session right now — finished ones are forgotten once enough newer work has run. Start one with cli_delegate.';
  }
  const ids = [
    ...live.map((snapshot) => `${snapshot.id} (${snapshot.status})`),
    ...persisted.map((session) => `${session.delegation} (resumable)`),
  ];
  return `Tasks you can continue: ${ids.join(', ')}.`;
}
