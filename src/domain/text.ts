/**
 * Bounded-text primitives.
 *
 * Every string this plugin hands to a model passes through here. The caps are
 * byte caps, not character caps, because the thing being protected is the
 * request payload, and a UTF-8 multi-byte tail must never be split mid-code-point.
 *
 * @module dsh-cli-bridge/domain/text
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

/** UTF-8 byte length of a string. */
export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Marker appended in place of the bytes a truncation dropped. */
export const TRUNCATION_NOTICE = '\n[…truncated]';

/**
 * Keep the HEAD of a string within a byte budget.
 *
 * The head is what a summary needs: a delegate states its conclusion first and
 * elaborates after. Truncation never splits a code point — the decoder is given
 * the sliced bytes with `stream: true` semantics disabled, so a partial
 * sequence at the boundary is dropped rather than replaced with U+FFFD.
 * @param text - the string to bound.
 * @param maxBytes - inclusive UTF-8 byte budget for the result, notice included.
 * @returns the original string, or its head plus {@link TRUNCATION_NOTICE}.
 */
export function boundHead(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  const budget = Math.max(0, maxBytes - byteLength(TRUNCATION_NOTICE));
  return `${
    decodeWholeCodePoints(bytes.subarray(0, budget))
  }${TRUNCATION_NOTICE}`;
}

/**
 * Keep the TAIL of a string within a byte budget — the shape a live log wants,
 * where the newest lines matter and the oldest are expendable.
 * @param text - the string to bound.
 * @param maxBytes - inclusive UTF-8 byte budget for the result.
 * @returns the original string, or its tail.
 */
export function boundTail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  return decodeWholeCodePoints(bytes.subarray(bytes.length - maxBytes), 'tail');
}

/**
 * Decode a byte slice, dropping an incomplete UTF-8 sequence at the cut edge.
 * @param bytes - the slice to decode.
 * @param edge - which end was cut and may therefore hold a partial sequence.
 * @returns the decoded text with no replacement characters from the cut.
 */
function decodeWholeCodePoints(
  bytes: Uint8Array,
  edge: 'head' | 'tail' = 'head',
): string {
  const text = decoder.decode(bytes);
  if (!text.includes('�')) return text;
  return edge === 'head' ? text.replace(/�+$/u, '') : text.replace(/^�+/u, '');
}

/**
 * Reduce a prompt to a one-line label for listings and cards.
 * @param text - arbitrary prompt text.
 * @param maxChars - character budget for the label.
 * @returns the first non-empty line, collapsed and ellipsized.
 */
export function oneLineLabel(text: string, maxChars: number): string {
  const line =
    text.split('\n').map((part) => part.trim()).find((part) =>
      part.length > 0
    ) ?? '';
  const collapsed = line.replace(/\s+/gu, ' ');
  return collapsed.length <= maxChars
    ? collapsed
    : `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`;
}
