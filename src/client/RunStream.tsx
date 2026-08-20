/**
 * The live view of one run — shared by the tool card and the panel.
 *
 * It renders the DECODED activities as the primary surface and keeps the raw
 * transcript one click away. That order matters: the activity list is the same
 * normalized vocabulary for both delegates, while the raw log is the escape
 * hatch for when something goes wrong inside one of them.
 *
 * @module dsh-cli-bridge/client/RunStream
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  activityKindLabel,
  activityTone,
  describeActivity,
  formatBytes,
  formatUsage,
  runElapsed,
} from './format.ts';
import { cls } from './styles.ts';
import type { RunView } from './store.ts';

/** What {@link RunStream} needs. */
export interface RunStreamProps {
  readonly view: RunView;
  /** Activities shown before the list scrolls; the rest stay in the log. */
  readonly visibleActivities?: number;
  /** Extra controls rendered in the header, such as a cancel button. */
  readonly actions?: ReactNode;
}

/** One run's header, activity list, question, and raw log. */
export function RunStream(
  { view, visibleActivities = 40, actions }: RunStreamProps,
): ReactNode {
  const [showLog, setShowLog] = useState(false);
  const status = view.end?.status ?? view.snapshot?.status ?? 'starting';
  const activities = view.activities.slice(
    Math.max(0, view.activities.length - visibleActivities),
  );

  return (
    <div className={cls('row')}>
      <div className={cls('head')}>
        <span className={cls('title')}>{view.snapshot?.label ?? view.id}</span>
        <span className={cls('badge')} data-status={status}>
          {status.replace('_', ' ')}
        </span>
        <span className={cls('meta')}>{describeRun(view)}</span>
        {actions}
      </div>

      {activities.length > 0 && (
        <ul className={cls('activities')}>
          {activities.map((activity, position) => (
            <li
              // Activities are append-only, so the index is a stable identity.
              key={`${String(position)}-${activity.type}`}
              className={cls('activity')}
              data-tone={activityTone(activity)}
            >
              <span className={cls('activity-kind')}>
                {activityKindLabel(activity.type)}
              </span>
              <span className={cls('activity-text')}>
                {describeActivity(activity)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {view.end?.question !== undefined && (
        <div className={cls('question')}>{view.end.question}</div>
      )}
      {view.end?.error !== undefined && (
        <div className={cls('error')}>{view.end.error}</div>
      )}

      {view.output.length > 0 && (
        <>
          <button
            type='button'
            className={cls('toggle')}
            onClick={() => setShowLog(!showLog)}
          >
            {showLog
              ? 'hide raw output'
              : `show raw output (${
                formatBytes(view.snapshot?.bytes ?? view.output.length)
              })`}
          </button>
          {showLog && <Log text={view.output} />}
        </>
      )}
    </div>
  );
}

/** The raw transcript, pinned to its newest line while it grows. */
function Log({ text }: { readonly text: string }): ReactNode {
  const element = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const node = element.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [text]);
  return <pre className={cls('log')} ref={element}>{text}</pre>;
}

/** The header's metadata line. */
function describeRun(view: RunView): string {
  const snapshot = view.snapshot;
  if (snapshot === undefined) return '';
  const usage = formatUsage(view.end?.usage ?? snapshot.usage);
  return [
    `${snapshot.cli}/${snapshot.account}`,
    snapshot.model,
    snapshot.effort,
    runElapsed(snapshot, Date.now()),
    usage.length === 0 ? undefined : usage,
  ].filter((part): part is string => part !== undefined && part.length > 0)
    .join(' · ');
}
