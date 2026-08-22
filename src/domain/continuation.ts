/**
 * What happens between two rounds of one delegation.
 *
 * This is the whole autonomy design as one pure function. It performs no I/O and
 * consults nobody: it says WHO should be consulted and why, the loop above it
 * does the consulting, and the answer comes back through {@link applyAdvice} or
 * {@link applyAnswer}. That split is what makes the policy — the part that is
 * easy to get subtly wrong — a table-driven unit test.
 *
 * The precedence is fixed and total:
 *
 * 1. a pending USER direction, always, whatever else is true;
 * 2. the round budget;
 * 3. a failure or a cancellation;
 * 4. a question — the human's by default, the model's under `autonomy.decide`;
 * 5. declared remaining work, under `autonomy.continue`;
 * 6. a review of the finished work, under `autonomy.review`.
 *
 * @module dsh-cli-bridge/domain/continuation
 */
import type {
  DecisionSource,
  DirectionRecord,
  RunEnd,
} from '../shared/protocol.ts';
import type { AutonomyConfig } from '../config.ts';

/** What the loop should do next. */
export type Continuation =
  /** Send the delegate this message and run another round. */
  | {
    readonly kind: 'resume';
    readonly message: string;
    readonly source: DecisionSource;
    readonly reason: string;
  }
  /** Put this question to the human and wait for the answer. */
  | { readonly kind: 'ask'; readonly question: string; readonly reason: string }
  /** Consult the session's model on this topic. */
  | {
    readonly kind: 'consult';
    readonly topic: AdviceTopic;
    readonly reason: string;
  }
  /** Stop, and report to the caller. */
  | { readonly kind: 'finish'; readonly reason: string };

/** What the session's model is being asked to judge. */
export type AdviceTopic =
  /** Answer the delegate's question. */
  | 'decide'
  /** Say whether the work is really finished, and what to do next if not. */
  | 'continue'
  /** Judge the finished work against the task and the directions. */
  | 'review';

/** Everything the policy needs to know about a delegation after one round. */
export interface RoundFacts {
  /** Round just finished, 1-based. */
  readonly round: number;
  /** The classified outcome of that round. */
  readonly end: RunEnd;
  /** A user direction that has not been given to the delegate yet. */
  readonly pendingDirection?: DirectionRecord;
  /** Reviews already performed for this delegation. */
  readonly reviews: number;
  /** Whether the model has already judged this exact round's remaining work. */
  readonly continueJudged: boolean;
  readonly autonomy: AutonomyConfig;
  /** Whether a human can be reached at all. */
  readonly canAskHuman: boolean;
  /** Whether the session's model can be consulted at all. */
  readonly canAdvise: boolean;
}

/**
 * Decide what follows one round.
 * @param facts - everything known about the delegation at that point.
 * @returns the next step, for the loop to carry out.
 */
export function nextStep(facts: RoundFacts): Continuation {
  // 1. A user direction outranks every automatic decision, including a question
  //    the delegate just asked: the human has already said what they want.
  if (facts.pendingDirection !== undefined) {
    return {
      kind: 'resume',
      message: facts.pendingDirection.text,
      source: 'direction',
      reason: 'a user direction was waiting',
    };
  }

  // 2. The budget is a hard stop, so no policy below can loop forever.
  if (facts.round >= facts.autonomy.maxRounds) {
    return {
      kind: 'finish',
      reason: `round budget of ${String(facts.autonomy.maxRounds)} spent`,
    };
  }

  // 3. A run that failed or was cancelled is reported as it is. Answering a
  //    question a dead run asked would waste the answer.
  if (facts.end.status === 'failed' || facts.end.status === 'cancelled') {
    return { kind: 'finish', reason: `the round ${facts.end.status}` };
  }

  // A timeout settles the delegation so control returns to the caller, but the
  // delegate's session is intact and resumable — so the caller continues with
  // `cli_reply`, never by delegating afresh. It is deliberately not run
  // through `onCompletion`: a timed-out round is not "finished work" to
  // review or push on automatically.
  if (facts.end.status === 'timed_out') {
    return {
      kind: 'finish',
      reason: 'the round timed out; its session is preserved and resumable',
    };
  }

  if (facts.end.status === 'needs_direction') return onQuestion(facts);
  return onCompletion(facts);
}

/** The delegate asked for a decision. */
function onQuestion(facts: RoundFacts): Continuation {
  const question = facts.end.question ?? '';
  if (facts.autonomy.decide && facts.canAdvise) {
    return {
      kind: 'consult',
      topic: 'decide',
      reason: 'autonomy.decide answers the delegate',
    };
  }
  if (facts.canAskHuman) {
    return {
      kind: 'ask',
      question,
      // Name the ACTUAL cause. One fixed string for both read as "the setting is
      // off" even when it was on and unusable — which is exactly the state a
      // person needs told, because they turned it on and are still being asked.
      reason: facts.autonomy.decide
        ? 'autonomy.decide is on but there is no model route to consult'
        : 'the delegate needs a decision and autonomy.decide is off',
    };
  }
  // Nobody can be reached: the caller sees the question and decides for itself.
  return {
    kind: 'finish',
    reason: 'the delegate needs a decision and nobody here can give one',
  };
}

/** The delegate finished a round without asking anything. */
function onCompletion(facts: RoundFacts): Continuation {
  if (facts.autonomy.continue) {
    // The marker is free and exact, so it is consulted before the model is.
    if (facts.end.nextSteps !== undefined) {
      return {
        kind: 'resume',
        message: continueMessage(facts.end.nextSteps),
        source: 'policy',
        reason: 'the delegate declared remaining work',
      };
    }
    if (facts.canAdvise && !facts.continueJudged) {
      return {
        kind: 'consult',
        topic: 'continue',
        reason: 'autonomy.continue checks whether the work is finished',
      };
    }
  }

  if (
    facts.autonomy.review && facts.canAdvise &&
    facts.reviews < facts.autonomy.maxReviews
  ) {
    return {
      kind: 'consult',
      topic: 'review',
      reason: 'autonomy.review checks the work against the task',
    };
  }

  // Stopping here, nothing above acted. Say which cause it was, so the record
  // can tell them apart: a review owed but unrunnable, a finish the session
  // model confirmed, or a finish accepted on the delegate's word alone.
  if (
    facts.autonomy.review && facts.reviews < facts.autonomy.maxReviews &&
    !facts.canAdvise
  ) {
    return {
      kind: 'finish',
      reason: 'autonomy.review is on but there is no model route to consult',
    };
  }
  return {
    kind: 'finish',
    reason: facts.continueJudged
      ? 'the session model judged the work finished'
      : 'the delegate reported the work finished',
  };
}

/** The instruction that carries declared remaining work back to the delegate. */
export function continueMessage(nextSteps: string): string {
  return [
    'Continue with the work you said remained:',
    '',
    nextSteps,
    '',
    'Finish it the same way, and report again when it is done.',
  ].join('\n');
}

/**
 * One answer from the session's model, already parsed.
 *
 * `malformed` records that the reply was NOT the JSON the consultation asked
 * for, and that the value beside it is therefore this module's conservative
 * reading rather than something the arbiter actually said. The reading is still
 * the right one — an unintelligible answer must never leave a delegation looping
 * — but the caller has to be able to tell the two apart, because "the reviewer
 * approved it" and "the reviewer replied with prose and was read as approval"
 * look identical in the outcome and mean completely different things.
 */
export type Advice =
  | {
    readonly topic: 'decide';
    readonly answer: string;
    readonly malformed?: boolean;
  }
  | {
    readonly topic: 'continue';
    readonly finished: boolean;
    readonly instruction?: string;
    readonly malformed?: boolean;
  }
  | {
    readonly topic: 'review';
    readonly accepted: boolean;
    readonly fixes?: string;
    readonly malformed?: boolean;
  };

/**
 * Fold the model's answer back into a next step.
 *
 * Every unusable answer resolves toward STOPPING rather than looping: an
 * advisor that says nothing intelligible must not be able to spend the whole
 * round budget.
 * @param advice - the parsed answer.
 * @param facts - the same facts the consultation was raised from.
 * @returns the next step.
 */
export function applyAdvice(advice: Advice, facts: RoundFacts): Continuation {
  switch (advice.topic) {
    case 'decide':
      return advice.answer.trim().length === 0
        ? {
          kind: 'finish',
          reason: 'the session model had no answer to the delegate’s question',
        }
        : {
          kind: 'resume',
          message: advice.answer,
          source: 'advisor',
          reason: 'the session model answered',
        };
    case 'continue':
      return advice.finished || advice.instruction === undefined ||
          advice.instruction.trim().length === 0
        // Not finished but nothing to say is treated as finished, then the
        // review stage — if enabled — gets its own look at the same round.
        ? nextStep({ ...facts, continueJudged: true })
        : {
          kind: 'resume',
          message: continueMessage(advice.instruction),
          source: 'advisor',
          reason: 'the session model found declared work remaining',
        };
    case 'review':
      return advice.accepted || advice.fixes === undefined ||
          advice.fixes.trim().length === 0
        ? { kind: 'finish', reason: 'the session model accepted the work' }
        : {
          kind: 'resume',
          message: fixMessage(advice.fixes),
          source: 'advisor',
          reason: 'the session model asked for fixes',
        };
  }
}

/** The instruction that carries a review's findings back to the delegate. */
export function fixMessage(fixes: string): string {
  return [
    'A review of your work against the original request found this:',
    '',
    fixes,
    '',
    'Address it and report again.',
  ].join('\n');
}

/**
 * Fold the human's answer back into a next step.
 * @param answer - what the human typed or chose.
 * @returns the next step.
 */
export function applyAnswer(answer: string): Continuation {
  return answer.trim().length === 0
    ? { kind: 'finish', reason: 'the human declined to answer' }
    : {
      kind: 'resume',
      message: answer,
      source: 'human',
      reason: 'the human answered',
    };
}
