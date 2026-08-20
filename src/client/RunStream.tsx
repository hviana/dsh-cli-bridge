/**
 * The live view of one run — shared by the tool card and the panel.
 *
 * It reads as a TRANSCRIPT of what the delegate did: one row per call, showing
 * the command and what came back from it, the way the same work would read if
 * the harness had run it itself. The rows are folded (see `foldTranscript`), so
 * a call that reports itself twice is one row that fills in rather than two that
 * look like two calls, and the raw transcript stays one click away for when
 * something goes wrong inside a delegate.
 *
 * @module dsh-cli-bridge/client/RunStream
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Activity } from '../shared/protocol.ts';
import {
  activityKindLabel,
  activityTone,
  describeActivity,
  foldTranscript,
  formatBytes,
  formatUsage,
  runElapsed,
  statusLabel,
} from './format.ts';
import { cls } from './styles.ts';
import type { RunView } from './store.ts';

/** What {@link RunStream} needs. */
export interface RunStreamProps {
  readonly view: RunView;
  /** Rows shown before the list scrolls; the rest stay in the log. */
  readonly visibleActivities?: number;
  /** Workspace root, so file paths read relative to it. */
  readonly root?: string;
  /** Extra controls rendered in the header, such as a cancel button. */
  readonly actions?: ReactNode;
}

/** One run's header, transcript, question, and raw log. */
export function RunStream(
  { view, visibleActivities = 40, root, actions }: RunStreamProps,
): ReactNode {
  const [showLog, setShowLog] = useState(false);
  const status = view.end?.status ?? view.snapshot?.status ?? 'starting';
  // Folding comes FIRST: the cap is a number of rows a person reads, not a
  // number of events the delegate happened to emit for them.
  const rows = foldTranscript(view.activities);
  const visible = rows.slice(Math.max(0, rows.length - visibleActivities));

  return (
    <div className={cls('row')}>
      <div className={cls('head')}>
        <span className={cls('title')}>{view.snapshot?.label ?? view.id}</span>
        <span className={cls('badge')} data-status={status}>
          {statusLabel(status)}
        </span>
        <span className={cls('meta')}>{describeRun(view)}</span>
        {actions}
      </div>

      {visible.length > 0 && (
        <ul className={cls('activities')}>
          {visible.map((row) => (
            <li
              key={row.key}
              className={cls('activity')}
              data-tone={activityTone(row.activity)}
            >
              {row.activity.type === 'tool'
                ? <ToolRow activity={row.activity} />
                : (
                  <>
                    <span className={cls('activity-kind')}>
                      {activityKindLabel(row.activity.type)}
                    </span>
                    <span className={cls('activity-text')}>
                      {describeActivity(row.activity, root)}
                    </span>
                  </>
                )}
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
              ? 'hide full log'
              : `show full log (${
                formatBytes(view.snapshot?.bytes ?? view.output.length)
              })`}
          </button>
          {showLog && <Log text={view.output} />}
        </>
      )}
    </div>
  );
}

/**
 * One tool call: what was run, and what it returned.
 *
 * The NAME leads, because `Bash` or `Write` is what a person scans for — the
 * word "tool" was never the information. The outcome is stated only once it is
 * known, so a running call reads as running instead of claiming an exit code it
 * does not have yet.
 * @param props - the folded tool activity.
 * @returns the row's content.
 */
function ToolRow(
  { activity }: { readonly activity: Activity & { readonly type: 'tool' } },
): ReactNode {
  const outcome = activity.status === 'started'
    ? 'running'
    : activity.exitCode === undefined
    ? statusLabel(activity.status)
    : `exit ${String(activity.exitCode)}`;
  return (
    <>
      <span className={cls('activity-kind')}>{activity.name}</span>
      <div className={cls('activity-text', 'activity-body')}>
        <span className={cls('command-line')}>
          {activity.detail !== undefined && (
            <code className={cls('command')}>{activity.detail}</code>
          )}
          <span className={cls('outcome')} data-status={activity.status}>
            {outcome}
          </span>
        </span>
        {activity.output !== undefined && (
          <pre className={cls('output')}>{activity.output}</pre>
        )}
      </div>
    </>
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
