import { describe, expect, it } from 'vitest';
import { SlotGate } from '../../src/runtime/slots.ts';
import { until } from '../support/fakes.ts';

describe('reserving a slot', () => {
  it('hands out exactly as many as the budget allows', () => {
    const gate = new SlotGate(() => 2);
    expect(gate.reserve()).toBeTypeOf('function');
    expect(gate.reserve()).toBeTypeOf('function');
    expect(gate.reserve()).toBeUndefined();
    expect(gate.inUse).toBe(2);
  });

  it('reads the budget on every reservation, so configuration is never captured', () => {
    let limit = 1;
    const gate = new SlotGate(() => limit);
    expect(gate.reserve()).toBeTypeOf('function');
    expect(gate.reserve()).toBeUndefined();
    limit = 2;
    expect(gate.reserve()).toBeTypeOf('function');
  });

  it('treats a budget of zero as one, because zero would stop everything', () => {
    const gate = new SlotGate(() => 0);
    expect(gate.reserve()).toBeTypeOf('function');
    expect(gate.reserve()).toBeUndefined();
  });

  it('takes a slot back exactly once, however often the release is called', () => {
    const gate = new SlotGate(() => 1);
    const slot = gate.reserve();
    slot?.();
    slot?.();
    expect(gate.inUse).toBe(0);
    expect(gate.reserve()).toBeTypeOf('function');
  });
});

describe('waiting for a slot', () => {
  it('resolves immediately while the budget has room', async () => {
    const gate = new SlotGate(() => 1);
    await expect(gate.acquire()).resolves.toBeTypeOf('function');
  });

  it('hands a released slot to the waiter that arrived first', async () => {
    const gate = new SlotGate(() => 1);
    const held = await gate.acquire();
    const order: string[] = [];
    const second = gate.acquire().then((slot) => {
      order.push('second');
      return slot;
    });
    const third = gate.acquire().then((slot) => {
      order.push('third');
      return slot;
    });
    await until(() => gate.queued === 2);

    held();
    const secondSlot = await second;
    // One slot, so only the waiter at the front may proceed.
    expect(order).toEqual(['second']);
    expect(gate.inUse).toBe(1);

    secondSlot();
    const thirdSlot = await third;
    expect(order).toEqual(['second', 'third']);
    thirdSlot();
    expect(gate.inUse).toBe(0);
    expect(gate.queued).toBe(0);
  });

  it('gives up when the caller does, and never holds a slot for them', async () => {
    const gate = new SlotGate(() => 1);
    const held = await gate.acquire();
    const abandon = new AbortController();
    const queued = gate.acquire(abandon.signal);
    await until(() => gate.queued === 1);

    abandon.abort();
    await expect(queued).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(gate.queued).toBe(0);
    held();
    expect(gate.inUse).toBe(0);
  });

  it('refuses a caller that had already given up', async () => {
    const gate = new SlotGate(() => 1);
    await expect(gate.acquire(AbortSignal.abort())).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(gate.inUse).toBe(0);
  });

  it('returns a slot handed over to a caller that gave up in the same moment', async () => {
    const gate = new SlotGate(() => 1);
    const held = await gate.acquire();
    const abandon = new AbortController();
    const queued = gate.acquire(abandon.signal);
    await until(() => gate.queued === 1);

    // The slot is handed over and the caller gives up before it is observed:
    // the slot has to go back rather than stay held by nobody.
    held();
    abandon.abort();
    await expect(queued).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(gate.inUse).toBe(0);
    expect(gate.reserve()).toBeTypeOf('function');
  });
});
