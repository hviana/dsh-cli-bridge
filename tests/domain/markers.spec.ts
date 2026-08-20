import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DIRECTION_MARKER as ASK,
  DEFAULT_NEXT_STEPS_MARKER as NEXT,
  operatingContract,
  splitMarkers,
} from '../../src/domain/markers.ts';

const both = { direction: ASK, nextSteps: NEXT };
const askOnly = { direction: ASK };

describe('operatingContract', () => {
  it('states the marker it will be parsed for', () => {
    expect(operatingContract({ direction: 'ASK:' })).toContain('ASK:');
  });

  it('states the next-steps marker only when something will act on it', () => {
    expect(operatingContract(askOnly)).not.toContain(NEXT);
    expect(operatingContract(both)).toContain(NEXT);
  });

  it('asks for each marker at most once, at the end', () => {
    expect(operatingContract(both)).toContain(
      'at most once, as the last lines',
    );
  });
});

describe('splitMarkers', () => {
  it('reports a plain completion as body only', () => {
    expect(splitMarkers('Migrated 12 files.', both)).toEqual({
      body: 'Migrated 12 files.',
    });
  });

  it('peels a question', () => {
    expect(splitMarkers(`Renamed it.\n\n${ASK} Keep the alias?`, both)).toEqual(
      {
        body: 'Renamed it.',
        direction: 'Keep the alias?',
      },
    );
  });

  it('peels declared remaining work', () => {
    expect(splitMarkers(`Step one done.\n${NEXT} wire up the router`, both))
      .toEqual({
        body: 'Step one done.',
        nextSteps: 'wire up the router',
      });
  });

  it('peels both, in either order', () => {
    const questionLast = `Did it.\n${NEXT} write docs\n${ASK} which format?`;
    expect(splitMarkers(questionLast, both)).toEqual({
      body: 'Did it.',
      nextSteps: 'write docs',
      direction: 'which format?',
    });
    const stepsLast = `Did it.\n${ASK} which format?\n${NEXT} write docs`;
    expect(splitMarkers(stepsLast, both)).toEqual({
      body: 'Did it.',
      direction: 'which format?',
      nextSteps: 'write docs',
    });
  });

  it('ignores a marker the contract did not state', () => {
    expect(splitMarkers(`Did it.\n${NEXT} write docs`, askOnly)).toEqual({
      body: `Did it.\n${NEXT} write docs`,
    });
  });

  it('takes the LAST occurrence, so a quoted contract cannot fake one', () => {
    const message = [
      `The instructions said to end with ${ASK} when blocked.`,
      'I was not blocked, but one choice remains.',
      `${ASK} flag or unconditional?`,
    ].join('\n');
    expect(splitMarkers(message, both).direction).toBe(
      'flag or unconditional?',
    );
  });

  it('keeps a multi-line value whole', () => {
    expect(
      splitMarkers(`Done.\n${ASK} Which target?\n- a\n- b`, both).direction,
    ).toBe('Which target?\n- a\n- b');
  });

  it('treats an empty marker line as absent, and keeps it out of the body', () => {
    expect(splitMarkers(`All good.\n${ASK}   `, both)).toEqual({
      body: 'All good.',
    });
  });

  it('handles a message that is nothing but a marker', () => {
    expect(splitMarkers(`${ASK} Which database?`, both)).toEqual({
      body: '',
      direction: 'Which database?',
    });
  });

  it('accepts an indented marker but not an inline mention', () => {
    expect(splitMarkers(`Done.\n   ${ASK} Which one?`, both).direction).toBe(
      'Which one?',
    );
    expect(splitMarkers(`Done, see ${ASK} above.`, both).direction)
      .toBeUndefined();
  });

  it('returns an empty body for an empty message', () => {
    expect(splitMarkers('', both)).toEqual({ body: '' });
  });
});
