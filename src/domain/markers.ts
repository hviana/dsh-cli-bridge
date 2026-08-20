/**
 * The operating contract, and the markers it is read back through.
 *
 * A delegate hands two things back out of band: a decision it cannot make, and
 * work it knows is still outstanding. Both are read DETERMINISTICALLY — the
 * plugin states a marker in the delegated prompt and parses that marker,
 * never the shape of English prose.
 *
 * Markers are TRAILING annotations, peeled off the end of the final message.
 * For each marker the LAST occurrence wins, so a delegate that quotes the
 * contract earlier in its message cannot fake one.
 *
 * @module dsh-cli-bridge/domain/markers
 */

/** Marker a delegate writes to hand a decision back to the caller. */
export const DEFAULT_DIRECTION_MARKER = 'NEEDS_DIRECTION:';

/** Marker a delegate writes to declare work it has not done yet. */
export const DEFAULT_NEXT_STEPS_MARKER = 'NEXT_STEPS:';

/** The markers one run's contract states, keyed by what they mean. */
export interface ContractMarkers {
  /** Hand a decision back. Always stated. */
  readonly direction: string;
  /**
   * Declare remaining work. Stated only when something will act on it, because
   * a marker nothing reads would silently cut text out of the summary.
   */
  readonly nextSteps?: string;
}

/** A final message with its trailing marker sections peeled off. */
export interface MarkerSplit {
  /** What is left once every marker section is removed — the report. */
  readonly body: string;
  /** The decision the delegate asked for. */
  readonly direction?: string;
  /** The work the delegate declared outstanding. */
  readonly nextSteps?: string;
}

/**
 * State the contract in the delegated prompt.
 * @param markers - the markers this run will be read back through.
 * @returns instruction text naming exactly the conventions that are parsed.
 */
export function operatingContract(markers: ContractMarkers): string {
  const lines = [
    'Operating contract for this run:',
    '- Finish the work you can finish without asking. Report the result in your final message.',
    '- If — and only if — you need a decision that is not yours to make, end your final message',
    `  with a line that starts with \`${markers.direction}\` followed by the single question you need answered.`,
  ];
  if (markers.nextSteps !== undefined) {
    lines.push(
      '- If you finished a step but real work remains, end your final message with a line that',
      `  starts with \`${markers.nextSteps}\` followed by what remains, so it can be continued.`,
    );
  }
  lines.push(
    '- Emit each of those lines at most once, as the last lines, and nowhere else in the run.',
  );
  return lines.join('\n');
}

/** One marker's identity while peeling. */
interface MarkerEntry {
  readonly key: 'direction' | 'nextSteps';
  readonly token: string;
}

/**
 * Peel the trailing marker sections off a final message.
 *
 * Sections are removed from the end inwards, so two markers in either order
 * both read correctly and neither swallows the other.
 * @param finalMessage - the delegate's final assistant message.
 * @param markers - the markers this run's contract stated.
 * @returns the report, plus whichever marker values were present.
 */
export function splitMarkers(
  finalMessage: string,
  markers: ContractMarkers,
): MarkerSplit {
  const entries: MarkerEntry[] = [
    { key: 'direction', token: markers.direction },
    ...markers.nextSteps === undefined
      ? []
      : [{ key: 'nextSteps' as const, token: markers.nextSteps }],
  ];
  const found = new Map<MarkerEntry['key'], string>();
  let body = finalMessage;

  // At most one section per marker, peeled from whichever sits latest.
  for (let pass = 0; pass < entries.length; pass += 1) {
    const candidates = entries
      .filter((entry) => !found.has(entry.key))
      .map((entry) => ({ entry, line: lastMarkerLine(body, entry.token) }))
      .filter((candidate): candidate is { entry: MarkerEntry; line: number } =>
        candidate.line >= 0
      );
    if (candidates.length === 0) break;
    const latest = candidates.reduce((
      best,
      candidate,
    ) => (candidate.line > best.line ? candidate : best));
    const lines = body.split('\n');
    const head = lines[latest.line] ?? '';
    const value = [
      head.trimStart().slice(latest.entry.token.length),
      ...lines.slice(latest.line + 1),
    ]
      .join('\n')
      .trim();
    if (value.length > 0) found.set(latest.entry.key, value);
    body = lines.slice(0, latest.line).join('\n');
  }

  const direction = found.get('direction');
  const nextSteps = found.get('nextSteps');
  return {
    body: body.trim(),
    ...direction === undefined ? {} : { direction },
    ...nextSteps === undefined ? {} : { nextSteps },
  };
}

/**
 * Index of the last line that starts with a marker.
 * @param text - the text to scan.
 * @param token - the marker token.
 * @returns the line index, or -1 when the marker is absent.
 */
function lastMarkerLine(text: string, token: string): number {
  return text.split('\n').findLastIndex((line) =>
    line.trimStart().startsWith(token)
  );
}
