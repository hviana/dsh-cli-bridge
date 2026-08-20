/**
 * Incremental line assembly.
 *
 * A delegate's JSON-lines stream arrives in arbitrary chunks: a single read may
 * carry half a line, or forty lines and a fragment. Both adapters decode whole
 * lines only, so the split lives here once.
 *
 * @module dsh-cli-bridge/domain/lines
 */

/** Stateful splitter turning stream chunks into complete lines. */
export class LineAssembler {
  private pending = '';

  /**
   * Consume one chunk.
   * @param chunk - the text read from the stream, possibly mid-line.
   * @returns every line completed by this chunk, without their terminators.
   */
  push(chunk: string): string[] {
    // A lone CR is a carriage return inside progress output, not a terminator;
    // only LF (with an optional preceding CR) ends a line.
    const combined = this.pending + chunk;
    const parts = combined.split('\n');
    this.pending = parts.pop() ?? '';
    return parts.map(
      (part) => (part.endsWith('\r') ? part.slice(0, -1) : part),
    );
  }

  /**
   * Release the unterminated remainder after the stream closed.
   * @returns the trailing partial line, or an empty array when there is none.
   */
  flush(): string[] {
    const rest = this.pending;
    this.pending = '';
    return rest.length > 0 ? [rest] : [];
  }
}

/**
 * Parse one line as JSON without throwing.
 * @param line - a complete line of delegate output.
 * @returns the parsed object, or `undefined` for blank, non-JSON, or non-object lines.
 */
export function parseJsonObject(
  line: string,
): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/** Read a string property, or `undefined` when absent or of another type. */
export function readString(
  source: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read a finite number property, or `undefined` when absent or of another type. */
export function readNumber(
  source: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/** Read a nested object property, or `undefined` when absent or of another type. */
export function readObject(
  source: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = source?.[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Read an array property, or an empty array when absent or of another type. */
export function readArray(
  source: Record<string, unknown> | undefined,
  key: string,
): readonly unknown[] {
  const value = source?.[key];
  return Array.isArray(value) ? value : [];
}
