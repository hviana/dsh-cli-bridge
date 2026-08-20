/**
 * Pure display helpers for the browser half.
 *
 * They live apart from the views so they can be tested without a DOM — which is
 * most of what a stream view actually does wrong.
 *
 * @module dsh-cli-bridge/client/format
 */
import type {
  AccountSnapshot,
  Activity,
  DecisionRecord,
  DelegationSnapshot,
  RunSnapshot,
  RunUsage,
  ToolchainStatus,
  WorkspaceState,
} from '../shared/protocol.ts';

/** Keep the newest characters of a growing log. */
export function boundTailChars(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/** Render a byte count the way a human reads it. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Render an elapsed duration compactly. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.max(0, Math.round(ms)))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`;
}

/** How long a run has been going, or how long it took. */
export function runElapsed(snapshot: RunSnapshot, now: number): string {
  return formatDuration((snapshot.finishedAt ?? now) - snapshot.startedAt);
}

/** One line describing how an account authenticates, for the account listing. */
export function describeAccount(account: AccountSnapshot): string {
  switch (account.auth) {
    case 'endpoint': {
      const target = account.model === undefined
        ? account.baseUrl ?? 'custom endpoint'
        : `${account.model} @ ${account.baseUrl ?? 'custom endpoint'}`;
      return `endpoint · ${target}${
        account.credentialConfigured === false ? ' · not configured' : ''
      }`;
    }
    case 'api-key':
      return account.credentialConfigured === false
        ? 'api key · not configured'
        : 'api key';
    default:
      return 'login';
  }
}

/** What a toolchain entry's source means, in the user's words. */
export function toolchainSourceLabel(
  source: ToolchainStatus['source'],
): string {
  switch (source) {
    case 'missing':
      return 'not installed';
    case 'configured':
      return 'custom';
    default:
      return 'installed';
  }
}

/** One-line usage summary, or an empty string when the delegate reported none. */
export function formatUsage(usage: RunUsage | undefined): string {
  if (usage === undefined) return '';
  // Cost is the number a person reads; tokens are the detail behind it.
  if (usage.costUsd !== undefined) return `$${usage.costUsd.toFixed(4)}`;
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
  ].filter((part): part is string => part !== undefined);
  return parts.join(' · ');
}

/** The metadata line for one delegation: who ran it, for how long, at what cost. */
export function describeDelegation(
  delegation: DelegationSnapshot,
  now: number,
): string {
  const rounds = delegation.rounds.length;
  const usage = formatUsage(delegation.usage);
  return [
    `${delegation.cli}/${delegation.account}`,
    delegation.model,
    delegation.effort,
    rounds <= 1 ? undefined : `${String(rounds)} rounds`,
    formatDuration((delegation.finishedAt ?? now) - delegation.startedAt),
    usage.length === 0 ? undefined : usage,
  ].filter((part): part is string => part !== undefined && part.length > 0)
    .join(' · ');
}

/**
 * What became of an isolated delegation's work.
 *
 * Nothing to say for the ordinary case — work done in the session's own
 * workspace was never anywhere else — and explicit whenever a branch is still
 * holding something.
 * @param workspace - the delegation's workspace.
 * @returns one line, or `undefined` when there is nothing to report.
 */
export function describeMerge(workspace: WorkspaceState): string | undefined {
  if (workspace.mode !== 'worktree') return undefined;
  const branch = workspace.branch ?? 'its branch';
  const detail = workspace.detail === undefined ? '' : ` — ${workspace.detail}`;
  switch (workspace.merge) {
    case 'merged':
      return `merged ${branch}`;
    case 'pending':
      return `working on ${branch}`;
    case 'conflict':
      return `${branch} conflicts on merge${detail}`;
    case 'failed':
      return `${branch} could not be merged${detail}`;
    case 'skipped':
      return `${branch} was not merged${detail}`;
    default:
      return `${branch}${detail}`;
  }
}

/**
 * The overlay pill's label.
 *
 * A delegation waiting on the human outranks a count of busy ones: it is the
 * only state where nothing moves until somebody comes back.
 * @param counts - how many delegations are waiting, and how many runs are live.
 * @returns the label.
 */
export function pillLabel(
  counts: { readonly waiting: number; readonly running: number },
): string {
  if (counts.waiting > 0) {
    return `delegates · ${String(counts.waiting)} waiting on you`;
  }
  return counts.running > 0
    ? `delegates · ${String(counts.running)} running`
    : 'delegates';
}

/**
 * What the one input box says.
 *
 * The same box answers a delegate that asked something and steers one that did
 * not, because both are the same act: a user direction, which outranks every
 * automatic decision.
 * @param asked - whether a question is waiting.
 * @returns the placeholder and the button's verb.
 */
export function directionCopy(
  asked: boolean,
): { readonly placeholder: string; readonly action: string } {
  return asked
    ? { placeholder: 'your answer', action: 'answer' }
    : { placeholder: 'steer this task', action: 'steer' };
}

/** One line describing a decoded delegate action. */
export function describeActivity(activity: Activity): string {
  switch (activity.type) {
    case 'message':
      return activity.text;
    case 'reasoning':
      return activity.text;
    case 'tool': {
      const detail = activity.detail === undefined ? '' : ` ${activity.detail}`;
      const exit = activity.exitCode === undefined
        ? ''
        : ` (exit ${String(activity.exitCode)})`;
      return `${activity.name}${detail}${exit}`;
    }
    case 'file':
      return `${activity.change} ${activity.path}`;
    case 'usage':
      return formatUsage(activity.usage);
    case 'notice':
      return activity.text;
  }
}

/** Stable class suffix for an activity, so the stylesheet can theme each kind. */
export function activityTone(activity: Activity): string {
  if (activity.type === 'notice') return activity.level;
  if (activity.type === 'tool') return activity.status;
  return activity.type;
}

/** The activity kind's label, in the watcher's words rather than the enum's. */
const ACTIVITY_KIND_LABELS: Readonly<Record<Activity['type'], string>> = {
  message: 'message',
  reasoning: 'thinking',
  tool: 'tool',
  file: 'file',
  usage: 'usage',
  notice: 'notice',
};

/** A short, human label for one activity kind. */
export function activityKindLabel(type: Activity['type']): string {
  return ACTIVITY_KIND_LABELS[type];
}

/**
 * One recorded decision, in the watcher's words.
 *
 * The stored shape is the machine's (`resume`/`advisor`); what a person needs is
 * who decided and what happened next.
 */
export function describeDecision(decision: DecisionRecord): string {
  if (decision.kind === 'resume') {
    switch (decision.source) {
      case 'human':
        return 'you answered';
      case 'direction':
        return 'you steered it';
      case 'advisor':
        return 'DeepSeek continued it';
      default:
        return 'it carried on';
    }
  }
  if (decision.kind === 'ask') return 'it asked you a question';
  if (decision.kind === 'consult') return 'DeepSeek took a look';
  return 'it finished';
}
