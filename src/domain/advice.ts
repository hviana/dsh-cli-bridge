/**
 * What the session's model is asked, and how its answer is read.
 *
 * Three consultations, one shape: a short system prompt that says the model is
 * arbitrating somebody else's work, a user message carrying only the facts the
 * decision needs, and a strict parser for a tiny JSON answer.
 *
 * The prompts live here, beside the parsers, because a prompt and the shape it
 * asks for are one contract — and because keeping them pure makes both testable
 * without a model.
 *
 * @module dsh-cli-bridge/domain/advice
 */
import type { Advice, AdviceTopic } from './continuation.ts';
import { boundHead, boundTail } from './text.ts';

/** One prepared consultation. */
export interface AdviceRequest {
  readonly topic: AdviceTopic;
  /** System prompt: who the model is being asked to be. */
  readonly system: string;
  /** User message: the facts, and the answer shape. */
  readonly prompt: string;
}

/** What the delegate did, as evidence for a review. */
export interface Evidence {
  /** Files the delegate reported touching. */
  readonly files: readonly string[];
  /** `git diff --stat` against the delegation's base, when there is a worktree. */
  readonly diffstat?: string;
}

/** Everything a consultation may draw on. */
export interface AdviceContext {
  /** The task as the caller originally stated it. */
  readonly task: string;
  /** Standing instructions, oldest first. */
  readonly directions: readonly string[];
  /** The delegate's latest report. */
  readonly summary: string;
  /** The question the delegate asked, for a `decide`. */
  readonly question?: string;
  /** What the delegate produced, for a `review`. */
  readonly evidence?: Evidence;
  /**
   * Byte budget for each section of the prompt — ABSENT by default.
   *
   * The arbiter decides from what it is shown and nothing else: it cannot run a
   * command or open a file. Truncating what it is shown therefore does not make
   * the decision cheaper, it makes it WRONG — a review judging a clipped diff, or
   * a decision taken against half of the task it was delegated. So nothing is cut
   * unless a deployment asks for a ceiling.
   */
  readonly maxBytes?: number;
}

const SYSTEM = [
  'You are arbitrating the work of another coding agent on behalf of the engineer who delegated it.',
  'You cannot run commands or read files: decide from what you are shown.',
  'Answer with one JSON object and nothing else — no prose, no code fence.',
].join(' ');

/**
 * Ask the model to answer the delegate's question.
 * @param context - task, directions, the delegate's report, and its question.
 * @returns the prepared consultation.
 */
export function decideRequest(context: AdviceContext): AdviceRequest {
  return {
    topic: 'decide',
    system: SYSTEM,
    prompt: [
      section('The task as delegated', context.task, context.maxBytes),
      directionSection(context),
      section(
        'What the agent reports so far',
        context.summary,
        context.maxBytes,
      ),
      section(
        'The decision it is asking for',
        context.question ?? '',
        context.maxBytes,
      ),
      'Answer its question so it can continue. Be concrete and brief: your answer is sent to it verbatim.',
      'If the directions above already settle it, follow them exactly.',
      'Reply with {"answer": "..."}.',
    ].join('\n\n'),
  };
}

/**
 * Ask the model whether the work is really finished.
 * @param context - task, directions, and the delegate's report.
 * @returns the prepared consultation.
 */
export function continueRequest(context: AdviceContext): AdviceRequest {
  return {
    topic: 'continue',
    system: SYSTEM,
    prompt: [
      section('The task as delegated', context.task, context.maxBytes),
      directionSection(context),
      section('What the agent reports', context.summary, context.maxBytes),
      'Decide whether the delegated task is now COMPLETE, or whether the report itself names work that is' +
      ' still outstanding — a finished step with more to come, a deferred item, an explicit next step.',
      'Judge only what the report says; do not invent work nobody asked for.',
      'Reply with {"finished": true} or {"finished": false, "instruction": "what to do next"}.',
    ].join('\n\n'),
  };
}

/**
 * Ask the model to review the finished work.
 * @param context - task, directions, the report, and the evidence.
 * @returns the prepared consultation.
 */
export function reviewRequest(context: AdviceContext): AdviceRequest {
  return {
    topic: 'review',
    system: SYSTEM,
    prompt: [
      section('The task as delegated', context.task, context.maxBytes),
      directionSection(context),
      section('What the agent reports', context.summary, context.maxBytes),
      evidenceSection(context),
      'Review the work against the task and the directions above. Accept it unless something specific is' +
      ' wrong, missing, or contradicts a direction.',
      'Reply with {"accepted": true} or {"accepted": false, "fixes": "what to fix, specifically"}.',
    ].join('\n\n'),
  };
}

/**
 * Build the consultation for one topic.
 * @param topic - what to ask.
 * @param context - the facts available.
 * @returns the prepared consultation.
 */
export function adviceRequest(
  topic: AdviceTopic,
  context: AdviceContext,
): AdviceRequest {
  switch (topic) {
    case 'decide':
      return decideRequest(context);
    case 'continue':
      return continueRequest(context);
    case 'review':
      return reviewRequest(context);
  }
}

/**
 * Read the model's answer.
 *
 * Every failure mode resolves to the CONSERVATIVE answer — finished, accepted,
 * or the raw text as a decision — because an unparseable reply must never leave
 * a delegation looping or hanging. Models wrap JSON in prose and fences, so the
 * first balanced object in the text is taken rather than the whole reply.
 * @param topic - the topic that was asked.
 * @param text - the model's reply.
 * @returns the parsed advice.
 */
export function parseAdvice(topic: AdviceTopic, text: string): Advice {
  const object = firstJsonObject(text);
  switch (topic) {
    case 'decide': {
      const answer = readString(object, 'answer') ?? text.trim();
      return { topic, answer };
    }
    case 'continue': {
      const finished = readBoolean(object, 'finished');
      const instruction = readString(object, 'instruction');
      if (finished === false && instruction !== undefined) {
        return { topic, finished: false, instruction };
      }
      return { topic, finished: true };
    }
    case 'review': {
      const accepted = readBoolean(object, 'accepted');
      const fixes = readString(object, 'fixes');
      if (accepted === false && fixes !== undefined) {
        return { topic, accepted: false, fixes };
      }
      return { topic, accepted: true };
    }
  }
}

/** One titled section of a prompt, bounded only when a ceiling was configured. */
function section(title: string, body: string, maxBytes?: number): string {
  const text = body.trim();
  if (text.length === 0) return `## ${title}\n(none)`;
  return `## ${title}\n${
    maxBytes === undefined ? text : boundHead(text, maxBytes)
  }`;
}

/** The standing instructions, which outrank the model's own judgment. */
function directionSection(context: AdviceContext): string {
  const text = context.directions.map((direction) => `- ${direction}`).join(
    '\n',
  );
  return section(
    'Standing directions from the engineer (these outrank your own preference)',
    text,
    context.maxBytes,
  );
}

/** What the delegate actually produced. */
function evidenceSection(context: AdviceContext): string {
  const evidence = context.evidence;
  if (evidence === undefined) return section('Evidence', '', context.maxBytes);
  const files = evidence.files.length === 0
    ? ''
    : `Files touched:\n${evidence.files.map((file) => `- ${file}`).join('\n')}`;
  // The diffstat is the newest and most concrete evidence, so it keeps its tail
  // rather than its head when it has to be cut at all.
  const diffstat = evidence.diffstat === undefined
    ? ''
    : `Diff against the base:\n${
      context.maxBytes === undefined
        ? evidence.diffstat.trim()
        : boundTail(evidence.diffstat.trim(), context.maxBytes)
    }`;
  return section(
    'Evidence',
    [files, diffstat].filter((part) => part.length > 0).join('\n\n'),
    context.maxBytes === undefined ? undefined : context.maxBytes * 2,
  );
}

/**
 * Extract the first balanced JSON object from arbitrary text.
 * @param text - the model's reply.
 * @returns the parsed object, or `undefined` when there is none.
 */
function firstJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return parseObject(text.slice(start, index + 1));
    }
  }
  return undefined;
}

/** Parse one candidate object, tolerating anything that is not one. */
function parseObject(candidate: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(candidate);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/** Read a non-empty string field. */
function readString(
  object: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = object?.[key];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Read a boolean field. */
function readBoolean(
  object: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = object?.[key];
  return typeof value === 'boolean' ? value : undefined;
}
