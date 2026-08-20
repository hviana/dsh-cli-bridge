/**
 * One delegation, as the human watches it.
 *
 * A delegation is the unit the user actually cares about: a task, however many
 * rounds it took, whatever was decided between them, and what became of the
 * work. Its rounds are rendered by the same {@link RunStream} the panel uses, so
 * there is exactly one implementation of "a delegate, streaming".
 *
 * It is also the only surface where the human OVERRIDES the machine. The input
 * at the bottom writes a user direction, which the runtime consumes before any
 * automatic decision and which cancels one already in flight — so the same box
 * answers a question the delegate asked and steers a delegation that never
 * asked anything.
 *
 * @module dsh-cli-bridge/client/DelegationView
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { DelegationSnapshot } from '../shared/protocol.ts';
import { describeDelegation, describeMerge, directionCopy } from './format.ts';
import { RunStream } from './RunStream.tsx';
import type { BridgeStore, RunView } from './store.ts';
import { cls } from './styles.ts';

/** What {@link DelegationView} needs. */
export interface DelegationViewProps {
  readonly delegation: DelegationSnapshot;
  /** The delegation's rounds, oldest first; a round still unseen is simply absent. */
  readonly rounds: readonly RunView[];
  readonly store: BridgeStore;
  /** Activities shown per round before the list scrolls. */
  readonly visibleActivities?: number;
}

/** A delegation's header, rounds, directions, and the human's input. */
export function DelegationView(
  { delegation, rounds, store, visibleActivities }: DelegationViewProps,
): ReactNode {
  const live = delegation.finishedAt === undefined;
  const merge = describeMerge(delegation.workspace);
  const pending = delegation.directions.filter((direction) =>
    direction.consumedRound === undefined
  );

  return (
    <div className={cls('delegation')} data-status={delegation.status}>
      <div className={cls('head')}>
        <span className={cls('title')}>{delegation.label}</span>
        <span className={cls('badge')} data-status={delegation.status}>
          {delegation.status.replace(/[-_]/gu, ' ')}
        </span>
        <span className={cls('meta')}>
          {describeDelegation(delegation, Date.now())}
        </span>
        {live && (
          <button
            type='button'
            className={cls('button')}
            onClick={() => {
              void store.send({
                op: 'delegation.cancel',
                delegation: delegation.id,
              });
            }}
          >
            stop
          </button>
        )}
      </div>

      {merge !== undefined && (
        <div className={cls('merge')} data-merge={delegation.workspace.merge}>
          {merge}
        </div>
      )}

      {rounds.map((round, position) => (
        <RunStream
          key={round.id}
          view={round}
          {
            // Only the round in progress is worth a long activity list; the ones
            // already decided are context.
            ...visibleActivities === undefined || position < rounds.length - 1
              ? {}
              : { visibleActivities }
          }
        />
      ))}

      {delegation.decisions.length > 0 && (
        <ul className={cls('decisions')}>
          {delegation.decisions.map((decision) => (
            <li
              key={`${String(decision.round)}-${decision.kind}`}
              className={cls('decision')}
            >
              <span className={cls('activity-kind')}>
                {`round ${String(decision.round)}`}
              </span>
              <span className={cls('activity-text')}>
                {`${decision.kind} · ${decision.source} — ${decision.reason}`}
              </span>
            </li>
          ))}
        </ul>
      )}

      {delegation.question !== undefined && (
        <div className={cls('question')}>{delegation.question.question}</div>
      )}
      {pending.map((direction) => (
        <div key={direction.id} className={cls('direction')}>
          {direction.text}
        </div>
      ))}

      {live && <DirectionInput delegation={delegation} store={store} />}
    </div>
  );
}

/** The one box that both answers a delegate's question and steers a delegation. */
function DirectionInput({
  delegation,
  store,
}: {
  readonly delegation: DelegationSnapshot;
  readonly store: BridgeStore;
}): ReactNode {
  const [text, setText] = useState('');
  const copy = directionCopy(delegation.question !== undefined);

  const send = async (): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const response = await store.send({
      op: 'delegation.direct',
      delegation: delegation.id,
      text: trimmed,
    });
    if (response.ok) setText('');
  };

  return (
    <div className={cls('line')}>
      <input
        className={cls('input')}
        value={text}
        placeholder={copy.placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void send();
        }}
      />
      <button
        type='button'
        className={cls('button')}
        onClick={() => {
          void send();
        }}
      >
        {copy.action}
      </button>
    </div>
  );
}
