/**
 * The overlay panel: delegates, accounts, delegations, and every live run.
 *
 * It exists for the things a tool card cannot do. An INSTALL has no tool call to
 * attach to; an interactive SIGN-IN needs somewhere to type — the CLIs' login
 * flows draw a prompt and wait for a code, and this is the surface that carries
 * those keystrokes to the terminal the host allocated; and a delegation started
 * in an earlier turn is still steerable from here after its card has scrolled
 * away.
 *
 * @module dsh-cli-bridge/client/BridgePanel
 */
import { useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type {
  AccountAuth,
  AccountSnapshot,
  AutonomySwitches,
  CliId,
  ControlRequest,
  ToolchainStatus,
} from '../shared/protocol.ts';
import { CLI_IDS } from '../shared/protocol.ts';
import { DelegationView } from './DelegationView.tsx';
import { RunStream } from './RunStream.tsx';
import { describeAccount, pillLabel } from './format.ts';
import { looseRuns, roundsOf } from './store.ts';
import type { BridgeStore, RunView } from './store.ts';
import { cls } from './styles.ts';

/**
 * Build the overlay entry over one store.
 * @param store - the page's channel store.
 * @returns the component registered into the frame-wide overlay.
 */
export function createBridgePanel(store: BridgeStore): () => ReactNode {
  return function BridgePanel(): ReactNode {
    const state = useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    );
    const [open, setOpen] = useState(false);
    const live = state.runs.filter((view) => isLive(view));
    const asking = state.delegations.filter((delegation) =>
      delegation.question !== undefined
    );
    // Installs and sign-ins only: a delegation's own rounds are rendered inside it.
    const loose = looseRuns(state);

    if (!open) {
      return (
        <button
          type='button'
          className={cls('pill')}
          data-asking={asking.length > 0}
          onClick={() => setOpen(true)}
        >
          {pillLabel({ waiting: asking.length, running: live.length })}
        </button>
      );
    }

    return (
      <div className={cls('panel')}>
        <div className={cls('line')}>
          <strong>Delegate CLIs</strong>
          <button
            type='button'
            className={cls('button')}
            onClick={() => setOpen(false)}
          >
            close
          </button>
        </div>

        {state.error !== undefined && (
          <div className={cls('error')}>{state.error}</div>
        )}

        <section className={cls('section')}>
          <h4>Toolchain</h4>
          {state.toolchain.map((entry) => (
            <ToolchainLine key={entry.cli} entry={entry} store={store} />
          ))}
        </section>

        <section className={cls('section')}>
          <h4>Accounts</h4>
          {state.accounts.map((account) => (
            <AccountLine
              key={`${account.cli}/${account.id}`}
              account={account}
              store={store}
            />
          ))}
          <NewAccount store={store} />
        </section>

        <section className={cls('section')}>
          <h4>Autonomy</h4>
          <span className={cls('meta')}>
            What DeepSeek may decide by itself between rounds. Off means you
            answer.
          </span>
          {AUTONOMY_SWITCHES.map((name) => (
            <AutonomyLine
              key={name}
              name={name}
              on={state.autonomy[name]}
              store={store}
            />
          ))}
        </section>

        <section className={cls('section')}>
          <h4>Delegations</h4>
          {state.delegations.length === 0 && (
            <span className={cls('meta')}>nothing yet</span>
          )}
          {state.delegations.toReversed().map((delegation) => (
            <DelegationView
              key={delegation.id}
              delegation={delegation}
              rounds={roundsOf(state, delegation.rounds)}
              store={store}
              visibleActivities={12}
            />
          ))}
        </section>

        <section className={cls('section')}>
          <h4>Other runs</h4>
          {loose.length === 0 && (
            <span className={cls('meta')}>nothing yet</span>
          )}
          {loose.toReversed().map((view) => (
            <RunEntry key={view.id} view={view} store={store} />
          ))}
        </section>
      </div>
    );
  };
}

/** The automatic decisions the panel can switch, with what each one means. */
const AUTONOMY_SWITCHES: readonly (keyof AutonomySwitches)[] = [
  'decide',
  'continue',
  'review',
];

/** What each switch does, in the user's terms. */
const AUTONOMY_LABELS: Readonly<Record<keyof AutonomySwitches, string>> = {
  decide: 'answer the delegate’s questions',
  continue: 'tell it to carry on with declared next steps',
  review: 'review the finished work against the task',
};

/** One automatic decision, and the switch that grants it. */
function AutonomyLine({
  name,
  on,
  store,
}: {
  readonly name: keyof AutonomySwitches;
  readonly on: boolean;
  readonly store: BridgeStore;
}): ReactNode {
  return (
    <label className={cls('line')}>
      <span className={cls('label')}>
        {name} <span className={cls('meta')}>{AUTONOMY_LABELS[name]}</span>
      </span>
      <input
        type='checkbox'
        checked={on}
        onChange={(event) => {
          void store.send({
            op: 'autonomy.set',
            switch: name,
            on: event.target.checked,
          });
        }}
      />
    </label>
  );
}

/** One delegate CLI and its install action. */
function ToolchainLine(
  { entry, store }: {
    readonly entry: ToolchainStatus;
    readonly store: BridgeStore;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const run = async (): Promise<void> => {
    setBusy(true);
    await store.send({ op: 'toolchain.install', cli: entry.cli });
    setBusy(false);
  };
  return (
    <div className={cls('line')}>
      <span className={cls('label')}>
        {entry.cli}{' '}
        <span className={cls('meta')}>
          {entry.source}
          {entry.version === undefined ? '' : ` ${entry.version}`}
        </span>
      </span>
      <button
        type='button'
        className={cls('button')}
        disabled={busy}
        onClick={() => {
          void run();
        }}
      >
        {entry.source === 'missing' ? 'install' : 'update'}
      </button>
    </div>
  );
}

/** One account, with its default and sign-in actions. */
function AccountLine({
  account,
  store,
}: {
  readonly account: AccountSnapshot;
  readonly store: BridgeStore;
}): ReactNode {
  const ambient = account.home.length === 0;
  return (
    <div className={cls('line')}>
      <span className={cls('label')}>
        {account.isDefault ? '★ ' : ''}
        {account.cli}
        /
        {account.id}{' '}
        <span className={cls('meta')}>
          {ambient ? 'machine default' : describeAccount(account)}
        </span>
      </span>
      <span className={cls('actions')}>
        {!account.isDefault && (
          <button
            type='button'
            className={cls('button')}
            onClick={() => {
              void store.send({
                op: 'account.default',
                cli: account.cli,
                id: account.id,
              });
            }}
          >
            default
          </button>
        )}
        {!ambient && (
          <button
            type='button'
            className={cls('button')}
            onClick={() => {
              void store.send({
                op: 'account.login',
                cli: account.cli,
                id: account.id,
              });
            }}
          >
            sign in
          </button>
        )}
        {!ambient && (
          <button
            type='button'
            className={cls('button')}
            onClick={() => {
              void store.send({
                op: 'account.remove',
                cli: account.cli,
                id: account.id,
              });
            }}
          >
            remove
          </button>
        )}
      </span>
    </div>
  );
}

/** The three ways a new account can authenticate. */
const AUTH_CHOICES: readonly { value: AccountAuth; label: string }[] = [
  { value: 'session', label: 'login' },
  { value: 'api-key', label: 'api key' },
  { value: 'endpoint', label: 'endpoint' },
];

/** The add-an-account form. */
function NewAccount({ store }: { readonly store: BridgeStore }): ReactNode {
  const [cli, setCli] = useState<CliId>(CLI_IDS[0] ?? 'claude');
  const [id, setId] = useState('');
  const [auth, setAuth] = useState<AccountAuth>('session');
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  const [model, setModel] = useState('');

  const add = async (): Promise<void> => {
    const trimmed = id.trim();
    if (trimmed.length === 0) return;
    const request: ControlRequest = auth === 'endpoint'
      ? {
        op: 'account.add',
        cli,
        id: trimmed,
        auth,
        baseUrl: endpoint.trim(),
        credentialRef: token.trim(),
        ...model.trim().length === 0 ? {} : { model: model.trim() },
      }
      : { op: 'account.add', cli, id: trimmed, auth };
    const response = await store.send(request);
    if (response.ok) {
      setId('');
      setEndpoint('');
      setToken('');
      setModel('');
    }
  };

  return (
    <div className={cls('form')}>
      <div className={cls('line')}>
        <select
          value={cli}
          onChange={(event) => setCli(event.target.value as CliId)}
          className={cls('input')}
        >
          {CLI_IDS.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
        <input
          className={cls('input')}
          value={id}
          placeholder='new account id'
          onChange={(event) => setId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add();
          }}
        />
        <select
          value={auth}
          onChange={(event) => setAuth(event.target.value as AccountAuth)}
          className={cls('input')}
        >
          {AUTH_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        <button
          type='button'
          className={cls('button')}
          onClick={() => {
            void add();
          }}
        >
          add
        </button>
      </div>
      {auth === 'endpoint' && (
        <div className={cls('line')}>
          <input
            className={cls('input')}
            value={endpoint}
            placeholder='https://api.deepseek.com/anthropic'
            onChange={(event) => setEndpoint(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void add();
            }}
          />
          <input
            className={cls('input')}
            value={token}
            placeholder='DEEPSEEK_API_KEY'
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void add();
            }}
          />
          <input
            className={cls('input')}
            value={model}
            placeholder='deepseek-chat'
            onChange={(event) => setModel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void add();
            }}
          />
        </div>
      )}
    </div>
  );
}

/** One run in the panel, with the input line an interactive run needs. */
function RunEntry(
  { view, store }: { readonly view: RunView; readonly store: BridgeStore },
): ReactNode {
  const [input, setInput] = useState('');
  const interactive = view.snapshot?.interactive === true && isLive(view);

  const send = async (): Promise<void> => {
    // The terminal expects a line: the newline is what submits it.
    await store.send({ op: 'run.input', run: view.id, data: `${input}\r` });
    setInput('');
  };

  return (
    <div className={cls('section')}>
      <RunStream
        view={view}
        visibleActivities={12}
        actions={isLive(view) && (
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
      {interactive && (
        <div className={cls('line')}>
          <input
            className={cls('input')}
            value={input}
            placeholder='type here, then press Enter'
            onChange={(event) => setInput(event.target.value)}
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
            send
          </button>
        </div>
      )}
    </div>
  );
}

/** Whether a run is still going. */
function isLive(view: RunView): boolean {
  const status = view.end?.status ?? view.snapshot?.status;
  return status === 'running' || status === 'starting';
}
