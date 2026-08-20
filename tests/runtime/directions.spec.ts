import { describe, expect, it } from 'vitest';
import { DirectionLedger } from '../../src/runtime/directions.ts';
import { fakeClock } from '../support/fakes.ts';

function build() {
  const clock = fakeClock();
  return { clock, ledger: new DirectionLedger(clock.now) };
}

describe('recording directions', () => {
  it('stamps and returns the record', () => {
    const { clock, ledger } = build();
    expect(ledger.add('d1', 'user', '  use postgres  ')).toEqual({
      id: 'dir-1',
      origin: 'user',
      text: 'use postgres',
      at: clock.now(),
    });
  });

  it('keeps them per delegation, oldest first', () => {
    const { ledger } = build();
    ledger.add('d1', 'user', 'first');
    ledger.add('d2', 'user', 'other');
    ledger.add('d1', 'user', 'second');
    expect(ledger.all('d1').map((record) => record.text)).toEqual([
      'first',
      'second',
    ]);
    expect(ledger.all('d2').map((record) => record.text)).toEqual(['other']);
  });

  it('hands out a copy, so a reader cannot mutate the ledger', () => {
    const { ledger } = build();
    ledger.add('d1', 'user', 'first');
    const read = ledger.all('d1');
    expect(read).not.toBe(ledger.all('d1'));
    expect(ledger.all('d1')).toHaveLength(1);
  });
});

describe('pending directions', () => {
  it('offers the oldest unconsumed user direction', () => {
    const { ledger } = build();
    ledger.add('d1', 'user', 'first');
    ledger.add('d1', 'user', 'second');
    expect(ledger.pending('d1')?.text).toBe('first');
  });

  it('skips a model direction, which had its turn through the tool call', () => {
    const { ledger } = build();
    ledger.add('d1', 'model', 'from the model');
    expect(ledger.pending('d1')).toBeUndefined();
  });

  it('offers nothing once consumed', () => {
    const { ledger } = build();
    const record = ledger.add('d1', 'user', 'first');
    ledger.consume('d1', record.id, 2);
    expect(ledger.pending('d1')).toBeUndefined();
    expect(ledger.all('d1')[0]?.consumedRound).toBe(2);
  });

  it('offers nothing for a delegation with none', () => {
    expect(build().ledger.pending('nobody')).toBeUndefined();
  });

  it('ignores consuming something that is not there', () => {
    const { ledger } = build();
    expect(() => ledger.consume('d1', 'dir-99', 1)).not.toThrow();
  });
});

describe('interrupting a decision', () => {
  it('aborts a waiter when a user direction arrives', () => {
    const { ledger } = build();
    const waiter = ledger.waiter('d1');
    expect(waiter.signal.aborted).toBe(false);
    ledger.add('d1', 'user', 'do it this way');
    expect(waiter.signal.aborted).toBe(true);
    expect(waiter.interrupted()).toBe(true);
  });

  it('does not abort for a model direction', () => {
    const { ledger } = build();
    const waiter = ledger.waiter('d1');
    ledger.add('d1', 'model', 'thinking out loud');
    expect(waiter.signal.aborted).toBe(false);
  });

  it('does not abort a waiter of another delegation', () => {
    const { ledger } = build();
    const waiter = ledger.waiter('d1');
    ledger.add('d2', 'user', 'elsewhere');
    expect(waiter.signal.aborted).toBe(false);
  });

  it('aborts every waiter of the delegation', () => {
    const { ledger } = build();
    const first = ledger.waiter('d1');
    const second = ledger.waiter('d1');
    ledger.add('d1', 'user', 'stop');
    expect([first.signal.aborted, second.signal.aborted]).toEqual([true, true]);
  });

  it('stops listening once disposed', () => {
    const { ledger } = build();
    const waiter = ledger.waiter('d1');
    waiter.dispose();
    ledger.add('d1', 'user', 'later');
    expect(waiter.signal.aborted).toBe(false);
  });
});

describe('inheriting', () => {
  it('carries a parent’s instructions onto its continuation, keeping the delivered ones delivered', () => {
    const ledger = new DirectionLedger(fakeClock().now);
    const delivered = ledger.add('d1', 'user', 'Keep the public API stable.');
    ledger.consume('d1', delivered.id, 1);
    ledger.add('d1', 'user', 'Prefer the smaller diff.');

    ledger.inherit('d1', 'd2');
    expect(ledger.all('d2').map((direction) => direction.text))
      .toEqual(['Keep the public API stable.', 'Prefer the smaller diff.']);
    // Only the one the delegate never received is still an override.
    expect(ledger.pending('d2')?.text).toBe('Prefer the smaller diff.');
  });

  it('has nothing to carry from a delegation nobody directed', () => {
    const ledger = new DirectionLedger(fakeClock().now);
    ledger.inherit('d1', 'd2');
    expect(ledger.all('d2')).toEqual([]);
  });
});

describe('forgetting', () => {
  it('drops the records and releases the waiters', () => {
    const { ledger } = build();
    ledger.add('d1', 'user', 'first');
    const waiter = ledger.waiter('d1');
    ledger.forget('d1');
    expect(ledger.all('d1')).toEqual([]);
    expect(waiter.signal.aborted).toBe(true);
  });
});
