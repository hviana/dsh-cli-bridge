/**
 * A delegation wired over the fake ports, for driving the round loop.
 */
import { Config } from '../../src/config.ts';
import type {
  AutonomyConfig,
  Config as ResolvedConfig,
} from '../../src/config.ts';
import type { AdviceRequest } from '../../src/domain/advice.ts';
import { AccountStore } from '../../src/runtime/accounts.ts';
import type {
  AdviceReply,
  AdviceTarget,
  AdvisorPort,
} from '../../src/runtime/advisor.ts';
import { StreamHub } from '../../src/runtime/channel.ts';
import {
  Delegation,
  type DelegationRequest,
} from '../../src/runtime/delegation.ts';
import { DirectionLedger } from '../../src/runtime/directions.ts';
import type { Inquiry, InquiryPort } from '../../src/runtime/inquiry.ts';
import { BridgePaths } from '../../src/runtime/paths.ts';
import { RunRegistry } from '../../src/runtime/registry.ts';
import { Toolchain } from '../../src/runtime/toolchain.ts';
import type { StreamFrame } from '../../src/shared/protocol.ts';
import {
  fakeClock,
  FakeProcessPort,
  MemoryFiles,
  type ProcessScript,
} from './fakes.ts';

/** A Claude Code transcript that finishes with the given final message. */
export function transcript(result: string, session = 's1'): string[] {
  return [
    `{"type":"result","is_error":false,"result":${
      JSON.stringify(result)
    },"session_id":"${session}"}\n`,
  ];
}

/** A Codex transcript that finishes with the given final message. */
export function codexTranscript(result: string, thread = 'th1'): string[] {
  return [
    `{"type":"thread.started","thread_id":"${thread}"}\n`,
    `{"type":"item.completed","item":{"type":"agent_message","text":${
      JSON.stringify(result)
    }}}\n`,
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}\n',
  ];
}

/**
 * The transcript the delegate in this argv would actually produce.
 *
 * Each CLI is decoded by its own adapter, so a fixture that hands Codex a
 * Claude transcript makes it look like a delegate that reported nothing.
 */
export function transcriptFor(
  argv: readonly string[],
  result: string,
): string[] {
  return argv.includes('exec') ? codexTranscript(result) : transcript(result);
}

/** An advisor that answers each consultation from a scripted queue. */
export class ScriptedAdvisor implements AdvisorPort {
  readonly asked: AdviceRequest[] = [];
  readonly targets: AdviceTarget[] = [];

  /**
   * @param replies - one reply per consultation, in order.
   * @param finish - how the model stopped, which matters for an empty reply.
   */
  constructor(
    private readonly replies: string[],
    private readonly finish?: string,
  ) {}

  async consult(
    request: AdviceRequest,
    target: AdviceTarget,
    signal?: AbortSignal,
  ): Promise<AdviceReply> {
    this.asked.push(request);
    this.targets.push(target);
    if (signal?.aborted === true) return { text: '' };
    return {
      text: this.replies.shift() ?? '',
      ...this.finish === undefined ? {} : { finish: this.finish },
    };
  }
}

/** A human who answers from a queue, or never answers at all. */
export class ScriptedHuman implements InquiryPort {
  readonly asked: Inquiry[] = [];

  constructor(
    private readonly answers: (string | undefined)[],
    private readonly hold = false,
  ) {}

  async ask(inquiry: Inquiry): Promise<string | undefined> {
    this.asked.push(inquiry);
    if (this.hold) {
      await new Promise<void>((resolve) => {
        if (inquiry.signal?.aborted === true) resolve();
        else {inquiry.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });}
      });
      return undefined;
    }
    return this.answers.shift();
  }
}

/** Build one delegation over fake processes, with whichever deciders the test wants. */
export function buildDelegation(options: {
  config?: Record<string, unknown>;
  script?: (argv: readonly string[], round: number) => ProcessScript;
  advisor?: AdvisorPort;
  inquiry?: InquiryPort;
  request?: Partial<DelegationRequest>;
  agentRoute?: { provider?: string; model?: string };
  /** The composition's live default route; absent in the standard fixture. */
  defaultRoute?: () => { provider?: string; model?: string } | undefined;
  /** The live autonomy reader; absent falls back to the configured settings. */
  autonomy?: () => AutonomyConfig;
} = {}) {
  const config: ResolvedConfig = new Config(options.config ?? {});
  const paths = new BridgePaths('/state');
  const files = new MemoryFiles();
  const clock = fakeClock();
  let round = 0;
  const process = new FakeProcessPort((spec) => {
    if (spec.argv.includes('--print') || spec.argv.includes('exec')) round += 1;
    return options.script?.(spec.argv, round) ??
      { stdout: transcript('Done.') };
  });
  process.resolvable.add('claude');
  process.resolvable.add('codex');

  const hub = new StreamHub(65_536, clock.now);
  const directions = new DirectionLedger(clock.now);
  const accounts = new AccountStore(paths, files, clock.now);
  const toolchain = new Toolchain(
    paths,
    files,
    process,
    clock.now,
    'linux',
    '/usr/bin/node',
    config.toolchain,
    config.delegates,
  );
  const runs = new RunRegistry({
    hub,
    accounts,
    toolchain,
    process,
    config,
    now: clock.now,
  });
  const frames: StreamFrame[] = [];
  hub.subscribe((frame) => frames.push(frame));

  const agent = options.agentRoute === undefined ? undefined : {
    id: 'session-a',
    options: options.agentRoute,
  } as DelegationRequest['agent'];

  const delegation = new Delegation({
    id: 'd1',
    batch: 'b1',
    cli: 'claude',
    task: 'Port the parser.',
    permission: 'workspace-write',
    workspace: { mode: 'inline', path: '/repo', merge: 'not-required' },
    ...agent === undefined ? {} : { agent },
    ...options.request,
  }, {
    runs,
    hub,
    directions,
    config,
    now: clock.now,
    ...options.advisor === undefined ? {} : { advisor: options.advisor },
    ...options.inquiry === undefined ? {} : { inquiry: options.inquiry },
    ...options.defaultRoute === undefined
      ? {}
      : { defaultRoute: options.defaultRoute },
    ...options.autonomy === undefined ? {} : { autonomy: options.autonomy },
  });

  return { delegation, directions, runs, hub, frames, process, config, clock };
}
