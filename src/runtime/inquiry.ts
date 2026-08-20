/**
 * Asking the human.
 *
 * This is the DEFAULT path, not the fallback: with autonomy off, a delegate's
 * question goes to the person who delegated the work. It rides the harness's own
 * user-questions seam, so the question appears in the interface the user already
 * answers questions in, and the answer resumes the delegate.
 *
 * Waiting costs nothing. The tool call is open, the delegate is paused, and the
 * caller's model is idle — which is exactly the state a question should hold
 * everything in.
 *
 * @module dsh-cli-bridge/runtime/inquiry
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { InquiryConfig } from '../config.ts';

/** One question put to the human. */
export interface Inquiry {
  /** The delegation asking, for the question's stable id. */
  readonly delegation: string;
  /** The question, exactly as the delegate asked it. */
  readonly question: string;
  /** What the delegate reported before asking, for the human to judge by. */
  readonly context: string;
  /** The live calling agent; the seam admits a question only from a runtime root. */
  readonly agent?: Agent;
  /** Cancellation, including a user direction arriving instead. */
  readonly signal?: AbortSignal;
}

/** Puts a delegate's question to the human. */
export interface InquiryPort {
  /**
   * Ask, and wait.
   * @param inquiry - the question and its context.
   * @returns the answer, or `undefined` when nobody answered.
   */
  ask(inquiry: Inquiry): Promise<string | undefined>;
}

/** The slice of `ctx.userQuestions` this uses. */
export interface UserQuestionsPort {
  ask(request: {
    questions: {
      id: string;
      question: string;
      detail?: string;
      header?: string;
    }[];
    agent?: Agent;
    signal?: AbortSignal;
  }): Promise<
    { answers: { id: string; selected: string[]; custom?: string }[] }
  >;
}

/**
 * Build the inquiry port over the harness's user-questions seam.
 * @param questions - the harness seam.
 * @param config - whether to ask at all, and how long to wait.
 * @returns the port the delegation loop asks through.
 */
export function userQuestionsInquiry(
  questions: UserQuestionsPort,
  config: InquiryConfig,
): InquiryPort {
  return {
    async ask(inquiry: Inquiry): Promise<string | undefined> {
      const control = new AbortController();
      const abort = (): void => {
        control.abort();
      };
      if (inquiry.signal?.aborted === true) abort();
      else inquiry.signal?.addEventListener('abort', abort, { once: true });
      // A zero timeout waits indefinitely on purpose: the delegate is paused and
      // nothing is being billed, so there is no reason to give up on the human.
      const deadline = config.timeoutMs > 0
        ? setTimeout(abort, config.timeoutMs)
        : undefined;
      deadline?.unref?.();

      try {
        const answer = await questions.ask({
          questions: [{
            id: inquiry.delegation,
            question: inquiry.question,
            header: 'Delegate needs a decision',
            ...inquiry.context.length === 0 ? {} : { detail: inquiry.context },
          }],
          ...inquiry.agent === undefined ? {} : { agent: inquiry.agent },
          signal: control.signal,
        });
        return readAnswer(answer, inquiry.delegation);
      } catch {
        // A cancelled ask, an absent provider, a UI that closed: all mean the
        // same thing to the loop — no answer — and none of them is a run failure.
        return undefined;
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
        inquiry.signal?.removeEventListener('abort', abort);
      }
    },
  };
}

/**
 * Read the human's answer for one question.
 *
 * Free text arrives as `custom`; a UI that offered options answers with labels.
 * Either is a usable instruction for the delegate.
 * @param answer - the seam's reply.
 * @param id - the question id to match.
 * @returns the answer text, or `undefined` when it was empty.
 */
function readAnswer(
  answer: { answers: { id: string; selected: string[]; custom?: string }[] },
  id: string,
): string | undefined {
  const item = answer.answers.find((entry) => entry.id === id) ??
    answer.answers[0];
  const text = (item?.custom ?? '').trim().length > 0
    ? (item?.custom ?? '')
    : (item?.selected ?? []).join(', ');
  return text.trim().length === 0 ? undefined : text.trim();
}
