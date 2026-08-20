/**
 * The tool card: delegated work, live, inside the turn that started it.
 *
 * This is the whole point of the Host → Web channel. The model's copy of this
 * call is one bounded summary; the human's copy is everything the delegates
 * said, as they say it, in the card where the call appears.
 *
 * The card finds its work by CALL id — delegation and run ids are minted inside
 * `execute`, after the card has already rendered. One call may own SEVERAL
 * delegations, because one call may ask for several at once.
 *
 * @module dsh-cli-bridge/client/RunCard
 */
import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client';
import { DelegationView } from './DelegationView.tsx';
import { RunStream } from './RunStream.tsx';
import { roundsOf } from './store.ts';
import type { BridgeStore } from './store.ts';
import { cls } from './styles.ts';

/**
 * Build the keyed tool view over one store.
 * @param store - the page's channel store.
 * @returns the component registered for this plugin's tool names.
 */
export function createRunCard(
  store: BridgeStore,
): (props: ToolCallOwnerProps) => ReactNode {
  return function RunCard({ callId, toolName }: ToolCallOwnerProps): ReactNode {
    const state = useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    );
    const delegations = state.callDelegations.get(callId) ?? [];
    const view = state.byCall.get(callId);

    if (delegations.length > 0) {
      return (
        <>
          {delegations.map((delegation) => (
            <DelegationView
              key={delegation.id}
              delegation={delegation}
              rounds={roundsOf(state, delegation.rounds)}
              store={store}
            />
          ))}
        </>
      );
    }

    if (view === undefined) {
      // Before the run exists — or after retention dropped it — the card says
      // what it is rather than rendering an empty frame.
      return (
        <div className={cls('row')}>
          <div className={cls('head')}>
            <span className={cls('title')}>{toolName}</span>
            <span className={cls('badge')} data-status='starting'>
              {state.connected ? 'starting' : 'not streaming'}
            </span>
          </div>
        </div>
      );
    }

    const run = view.snapshot;
    const cancellable = run !== undefined &&
      (run.status === 'running' || run.status === 'starting');
    return (
      <RunStream
        view={view}
        actions={cancellable && (
          <button
            type='button'
            className={cls('button')}
            onClick={() => {
              void store.send({ op: 'run.cancel', run: view.id });
            }}
          >
            stop
          </button>
        )}
      />
    );
  };
}
