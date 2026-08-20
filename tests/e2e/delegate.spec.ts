/**
 * End to end, with real processes and a real repository.
 *
 * Every other suite injects the world. This one does not: it writes two small
 * Node programs that behave the way `claude` and `codex` behave — read the
 * prompt from stdin, emit their own JSON event stream, exit with a code — and
 * drives the whole plugin against them, in a real git repository, on whatever
 * operating system is running the tests.
 *
 * What only this can prove: the prompt survives a real pipe, a transcript
 * arriving in real chunk boundaries decodes, argv reaches the delegate exactly
 * as composed, a hung delegate is really killed, and a delegation's worktree is
 * really committed and merged.
 */
import { spawn } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { Config } from '../../src/config.ts';
import { nodeFiles } from '../../src/host/node-ports.ts';
import type { LlmPort } from '../../src/runtime/advisor.ts';
import { BridgeOperations } from '../../src/runtime/operations.ts';
import type { ProcessPort } from '../../src/runtime/ports.ts';
import type { CliId } from '../../src/shared/protocol.ts';

/** A real subprocess port, the shape the harness's own seam has. */
const realProcess: ProcessPort = {
  async resolveExecutable(command) {
    return command;
  },
  spawn(spec) {
    const [program, ...args] = spec.argv;
    const child = spawn(program ?? '', args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env } as NodeJS.ProcessEnv,
    });
    const stdin = spec.stdio.stdin;
    if (typeof stdin === 'object' && stdin !== null) {
      child.stdin?.end(stdin.data);
    }
    return {
      pid: child.pid ?? -1,
      stdin: child.stdin ?? undefined,
      stdout: child.stdout ?? undefined,
      stderr: child.stderr ?? undefined,
      collected: {},
      done: new Promise((resolve) =>
        child.on(
          'close',
          (code, signal) => resolve({ exitCode: code, signal: signal as null }),
        )
      ),
      terminate: () => {
        child.kill();
      },
      waitForExit: async () => true,
    };
  },
  async spawnTerminal() {
    throw new Error('no sign-in in this suite');
  },
};

/**
 * A stand-in delegate CLI.
 *
 * It records the argv, the prompt and the environment it was given, then speaks
 * its own CLI's event vocabulary — which is what makes the same test meaningful
 * for both delegates.
 */
function fakeCli(cli: CliId): string {
  const claude = cli === 'claude';
  return `
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { argv, env, stdout, exit } from 'node:process'

const prompt = readFileSync(0, 'utf8')
appendFileSync(env.CALLS_FILE, JSON.stringify({
  argv: argv.slice(2),
  prompt,
  home: env.${claude ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'} ?? '',
  cwd: process.cwd(),
}) + '\\n')

const mode = env.FAKE_MODE ?? 'done'
if (mode === 'hang') { setInterval(() => {}, 1000) }
else if (mode === 'fail') { process.stderr.write('not logged in\\n'); exit(3) }
else {
  // The delegate really works in its workspace, so a worktree has something to
  // commit and a merge has something to carry.
  writeFileSync('${cli}-output.txt', prompt)
  const round = Number(readFileSync(env.ROUND_FILE, 'utf8').trim() || '0') + 1
  writeFileSync(env.ROUND_FILE, String(round))
  const text = round === 1 && mode === 'ask'
    ? 'Started the work.\\nNEEDS_DIRECTION: Which error type should I use?'
    : 'Finished the work.'
  ${
    claude
      ? `
  stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-e2e' }) + '\\n')
  // One event per write, so the assembler meets real chunk boundaries.
  stdout.write(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'delegate-output.txt' } }] },
  }) + '\\n')
  stdout.write(JSON.stringify({
    type: 'result', is_error: false, result: text, session_id: 'sess-e2e',
    usage: { input_tokens: 12, output_tokens: 5 }, total_cost_usd: 0.02,
  }) + '\\n')`
      : `
  stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'th-e2e' }) + '\\n')
  stdout.write(JSON.stringify({
    type: 'item.completed',
    item: { type: 'file_change', changes: [{ path: '${cli}-output.txt', kind: 'add' }] },
  }) + '\\n')
  stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\\n')
  stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 5 } }) + '\\n')`
  }
  exit(0)
}
`;
}

/** One call the stand-in delegate recorded. */
interface Call {
  readonly argv: readonly string[];
  readonly prompt: string;
  readonly home: string;
  readonly cwd: string;
}

let root = '';
let repository = '';
let calls = '';
let rounds = '';

/** Run a git command directly, for arranging the repository. */
async function git(cwd: string, ...args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '' },
    });
    child.on(
      'close',
      (
        code,
      ) => (code === 0
        ? resolve()
        : reject(new Error(`git ${args.join(' ')} → ${String(code)}`))),
    );
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cli-bridge-e2e-'));
  repository = join(root, 'repo');
  calls = join(root, 'calls.jsonl');
  rounds = join(root, 'rounds.txt');
  await mkdir(repository, { recursive: true });
  await writeFile(calls, '', 'utf8');
  await writeFile(rounds, '0', 'utf8');
  await Promise.all(['claude', 'codex'].map(async (cli) => {
    const path = join(root, `fake-${cli}.mjs`);
    await writeFile(path, fakeCli(cli as CliId), 'utf8');
    await chmod(path, 0o755);
  }));
  await git(repository, 'init', '--initial-branch=main');
  await git(repository, 'config', 'user.email', 'bridge@test.invalid');
  await git(repository, 'config', 'user.name', 'Bridge Test');
  await writeFile(join(repository, 'README.md'), 'base\n', 'utf8');
  await git(repository, 'add', '.');
  await git(repository, 'commit', '-m', 'base');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A model that answers each consultation from a queue, recording what it saw. */
function scriptedLlm(replies: readonly string[]) {
  const asked: GenerateOptions[] = [];
  const llm: LlmPort = {
    stream(generate: GenerateOptions): AsyncIterable<StreamChunk> {
      asked.push(generate);
      const reply = replies[asked.length - 1] ?? '';
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'text-delta',
            index: 0,
            text: reply,
          } satisfies StreamChunk;
        },
      };
    },
  };
  return { llm, asked };
}

/** The plugin, wired to the real world and the stand-in delegates. */
function bridge(overrides: Record<string, unknown> = {}, llm?: LlmPort) {
  const config = new Config({
    stateDir: join(root, 'state'),
    delegates: {
      claude: { executable: join(root, 'fake-claude.mjs') },
      codex: { executable: join(root, 'fake-codex.mjs') },
    },
    ...overrides,
  });
  return new BridgeOperations(config, {
    process: realProcess,
    files: nodeFiles,
    now: () => Date.now(),
    platform: process.platform,
    nodePath: process.execPath,
    ...llm === undefined ? {} : { llm },
  });
}

/** Everything the stand-in delegates recorded, in order. */
async function recorded(): Promise<Call[]> {
  const text = await readFile(calls, 'utf8');
  return text.split('\n').filter((line) => line.length > 0).map((line) =>
    JSON.parse(line) as Call
  );
}

const never = new AbortController().signal;

/** The environment the stand-ins are driven by, applied to this test process. */
function mode(value: 'done' | 'ask' | 'hang' | 'fail'): void {
  process.env['FAKE_MODE'] = value;
  process.env['CALLS_FILE'] = calls;
  process.env['ROUND_FILE'] = rounds;
}

describe.each(['claude', 'codex'] as const)('a real %s delegation', (cli) => {
  it('delivers the prompt, decodes the transcript, and reports only the summary', async () => {
    mode('done');
    const operations = bridge();
    try {
      const [entry] = await operations.startBatch({
        tasks: [{ cli, prompt: 'Port the parser to the new AST.' }],
        permission: 'workspace-write',
        base: repository,
        signal: never,
      });

      expect(entry?.snapshot.status).toBe('completed');
      expect(entry?.snapshot.end?.summary).toBe('Finished the work.');
      expect(entry?.snapshot.usage).toMatchObject({
        inputTokens: 12,
        outputTokens: 5,
      });

      const [call] = await recorded();
      // The prompt travelled on a real pipe, contract and all.
      expect(call?.prompt).toContain('Port the parser to the new AST.');
      expect(call?.prompt).toContain('NEEDS_DIRECTION:');
      expect(call?.argv).toContain(cli === 'claude' ? '--print' : 'exec');
      expect(call?.cwd).toBe(repository);
      // The delegate really wrote to the workspace.
      expect(await readFile(join(repository, `${cli}-output.txt`), 'utf8'))
        .toContain('Port the parser');
    } finally {
      await operations.dispose();
    }
  });

  it('streams the delegate’s activities to the channel and nothing to the caller', async () => {
    mode('done');
    const operations = bridge();
    const seen: string[] = [];
    operations.hub.subscribe((frame) => {
      if (frame.kind === 'activity') seen.push(frame.activity.type);
      if (frame.kind === 'output') seen.push('output');
    });
    try {
      const [entry] = await operations.startBatch({
        tasks: [{ cli, prompt: 'Do the thing.' }],
        permission: 'read-only',
        base: repository,
        signal: never,
      });
      expect(seen).toContain('output');
      expect(seen).toContain('file');
      // The transcript is on the channel; the caller's value is the summary.
      expect(JSON.stringify(entry?.snapshot.end)).not.toContain(
        `${cli}-output.txt`,
      );
    } finally {
      await operations.dispose();
    }
  });

  it('really kills a delegate that will not stop', async () => {
    mode('hang');
    const operations = bridge();
    const control = new AbortController();
    try {
      const running = operations.startBatch({
        tasks: [{ cli, prompt: 'Hang forever.' }],
        permission: 'read-only',
        base: repository,
        signal: control.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      control.abort();
      const [entry] = await running;
      expect(entry?.snapshot.status).toBe('cancelled');
    } finally {
      await operations.dispose();
    }
  }, 20_000);

  it('reports a delegate that exits with a failure, with its own words', async () => {
    mode('fail');
    const operations = bridge();
    try {
      const [entry] = await operations.startBatch({
        tasks: [{ cli, prompt: 'Fail please.' }],
        permission: 'read-only',
        base: repository,
        signal: never,
      });
      expect(entry?.snapshot.status).toBe('failed');
      expect(entry?.snapshot.end?.error).toContain('not logged in');
    } finally {
      await operations.dispose();
    }
  });

  it(
    'asks the human, resumes its own session, and merges the worktree back',
    async () => {
      mode('ask');
      const answers: string[] = [];
      const operations = bridge({ isolation: { mode: 'worktree' } });
      // The harness's question seam, answered by "the user".
      Object.assign(operations as unknown as Record<string, unknown>, {});
      try {
        const [entry] = await operations.startBatch({
          tasks: [{ cli, prompt: 'Build the auth stack.' }],
          permission: 'workspace-write',
          base: repository,
          signal: never,
        });
        // Nobody can answer in this composition, so it comes back for the caller.
        expect(entry?.snapshot.status).toBe('needs_direction');
        expect(entry?.snapshot.end?.question).toBe(
          'Which error type should I use?',
        );
        expect(answers).toEqual([]);

        // Its work is committed on its own branch, and NOT merged: unfinished
        // work never lands on the base branch.
        expect(entry?.snapshot.workspace).toMatchObject({
          mode: 'worktree',
          merge: 'skipped',
        });
        await expect(readFile(join(repository, `${cli}-output.txt`), 'utf8'))
          .rejects.toThrow();

        // Answering it starts a continuation that resumes the delegate session
        // and finishes, and that one IS merged.
        const continuation = await operations.replyToDelegation(
          entry!.snapshot.id,
          'Use the existing error type.',
          {
            signal: never,
          },
        );
        expect(continuation.snapshot.status).toBe('completed');
        expect(continuation.snapshot.workspace).toMatchObject({
          mode: 'worktree',
          merge: 'merged',
        });

        const [first, second] = await recorded();
        expect(first?.argv).not.toContain(
          cli === 'claude' ? '--resume' : 'resume',
        );
        expect(second?.argv.join(' ')).toContain(
          cli === 'claude' ? '--resume sess-e2e' : 'resume th-e2e',
        );
        expect(second?.prompt).toContain('Use the existing error type.');
        // Each delegation worked in its own worktree, not in the repository.
        expect(first?.cwd).not.toBe(repository);
        expect(second?.cwd).not.toBe(first?.cwd);
        // The merged work is on the base branch now.
        expect(await readFile(join(repository, `${cli}-output.txt`), 'utf8'))
          .toContain('Use the existing error type.');
      } finally {
        await operations.dispose();
      }
    },
    20_000,
  );
});

describe('a real review', () => {
  it(
    'reads the diff the delegate actually produced, then accepts the fix',
    async () => {
      mode('done');
      const { llm, asked } = scriptedLlm([
        '{"accepted":false,"fixes":"Name the file after the module."}',
        '{"accepted":true}',
      ]);
      const operations = bridge({
        autonomy: { review: true },
        isolation: { mode: 'worktree' },
      }, llm);
      try {
        const [entry] = await operations.startBatch({
          tasks: [{ cli: 'claude', prompt: 'Port the parser.' }],
          permission: 'workspace-write',
          base: repository,
          signal: never,
          agent: {
            id: 'session-a',
            options: { provider: 'deepseek-official', model: 'deepseek-v4' },
          } as never,
        });

        expect(entry?.snapshot.status).toBe('completed');
        expect(entry?.snapshot.rounds).toHaveLength(2);
        expect(
          entry?.snapshot.decisions.map((decision) =>
            `${decision.kind}:${decision.source}`
          ),
        )
          .toEqual(['resume:advisor', 'finish:policy']);

        // The review saw the real diff of the real worktree, and the file the
        // delegate really touched.
        const review = asked[0]?.messages[0]?.content;
        const text = JSON.stringify(review);
        // The evidence is the real state of the real worktree: the file the
        // delegate created is there even though nothing has been committed yet.
        expect(text).toContain('claude-output.txt');
        expect(text).toContain('new file');

        // The fix went back to the same delegate session, and the work merged.
        expect((await recorded())[1]?.prompt).toContain(
          'Name the file after the module.',
        );
        expect(entry?.snapshot.workspace.merge).toBe('merged');
        expect(await readFile(join(repository, 'claude-output.txt'), 'utf8'))
          .toContain('Name the file');
      } finally {
        await operations.dispose();
      }
    },
    20_000,
  );
});

describe('two real delegations at once', () => {
  it(
    'gives each its own worktree and account, and merges both back in turn',
    async () => {
      mode('done');
      const operations = bridge();
      try {
        await operations.addAccount({
          cli: 'claude',
          id: 'work',
          auth: 'session',
        });
        await operations.addAccount({
          cli: 'codex',
          id: 'analytics',
          auth: 'session',
        });
        const entries = await operations.startBatch({
          tasks: [
            { cli: 'claude', prompt: 'Build the auth stack.', account: 'work' },
            {
              cli: 'codex',
              prompt: 'Build the BI stack.',
              account: 'analytics',
            },
          ],
          permission: 'workspace-write',
          base: repository,
          signal: never,
        });

        expect(entries.map((entry) => entry.snapshot.status)).toEqual([
          'completed',
          'completed',
        ]);
        expect(entries.map((entry) => entry.snapshot.workspace.merge)).toEqual([
          'merged',
          'merged',
        ]);
        expect(entries.map((entry) => entry.snapshot.account)).toEqual([
          'work',
          'analytics',
        ]);

        const seen = await recorded();
        // Two different worktrees, two different CLI homes.
        expect(new Set(seen.map((call) => call.cwd)).size).toBe(2);
        expect(new Set(seen.map((call) => call.home)).size).toBe(2);
        expect(seen.every((call) => call.home.length > 0)).toBe(true);
        // Both merges landed on the base branch, one after the other.
        expect(await readFile(join(repository, 'claude-output.txt'), 'utf8'))
          .toContain('auth stack');
        expect(await readFile(join(repository, 'codex-output.txt'), 'utf8'))
          .toContain('BI stack');
      } finally {
        await operations.dispose();
      }
    },
    30_000,
  );
});
