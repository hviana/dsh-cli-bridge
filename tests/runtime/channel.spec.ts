import { describe, expect, it, vi } from 'vitest';
import { StreamHub } from '../../src/runtime/channel.ts';
import type { RunSnapshot, StreamFrame } from '../../src/shared/protocol.ts';
import { fakeClock } from '../support/fakes.ts';

const snapshot: RunSnapshot = {
  id: 'claude-1',
  cli: 'claude',
  kind: 'task',
  account: 'ambient',
  label: 'do the thing',
  permission: 'workspace-write',
  cwd: '/repo',
  status: 'running',
  startedAt: 0,
  bytes: 0,
  interactive: false,
};

describe('StreamHub', () => {
  it('stamps a per-run sequence and the publication time', () => {
    const clock = fakeClock(1000);
    const hub = new StreamHub(4096, clock.now);
    expect(
      hub.publish('claude-1', { kind: 'output', pipe: 'stdout', text: 'a' }),
    ).toMatchObject({ seq: 1, at: 1000 });
    clock.advance(5);
    expect(
      hub.publish('claude-1', { kind: 'output', pipe: 'stdout', text: 'b' }),
    ).toMatchObject({ seq: 2, at: 1005 });
    expect(
      hub.publish('codex-1', { kind: 'output', pipe: 'stdout', text: 'c' }),
    ).toMatchObject({ seq: 1 });
  });

  it('delivers only the subscribed run', () => {
    const hub = new StreamHub(4096, fakeClock().now);
    const mine: StreamFrame[] = [];
    hub.subscribe((frame) => mine.push(frame), { stream: 'claude-1' });
    hub.publish('claude-1', { kind: 'output', pipe: 'stdout', text: 'mine' });
    hub.publish('codex-9', { kind: 'output', pipe: 'stdout', text: 'theirs' });
    expect(mine).toHaveLength(1);
  });

  it('delivers every run to an unscoped subscriber', () => {
    const hub = new StreamHub(4096, fakeClock().now);
    const all: StreamFrame[] = [];
    hub.subscribe((frame) => all.push(frame));
    hub.publish('claude-1', { kind: 'output', pipe: 'stdout', text: 'a' });
    hub.publish('codex-9', { kind: 'output', pipe: 'stdout', text: 'b' });
    expect(all).toHaveLength(2);
  });

  it('hands a late subscriber the backlog and then the live frames', () => {
    const hub = new StreamHub(4096, fakeClock().now);
    hub.publish('claude-1', { kind: 'output', pipe: 'stdout', text: 'early' });
    const live: StreamFrame[] = [];
    const { backlog } = hub.subscribe((frame) => live.push(frame), {
      stream: 'claude-1',
    });
    hub.publish('claude-1', { kind: 'output', pipe: 'stdout', text: 'late' });
    expect(backlog).toHaveLength(1);
    expect(live).toHaveLength(1);
  });

  it('resumes after a known sequence number', () => {
    const hub = new StreamHub(4096, fakeClock().now);
    for (const text of ['a', 'b', 'c']) {
      hub.publish('claude-1', { kind: 'output', pipe: 'stdout', text });
    }
    const { backlog } = hub.subscribe(() => {}, {
      stream: 'claude-1',
      from: 2,
    });
    expect(backlog.map((frame) => frame.seq)).toEqual([3]);
  });

  it('orders a cross-run replay by time', () => {
    const clock = fakeClock(0);
    const hub = new StreamHub(4096, clock.now);
    hub.publish('claude-1', { kind: 'output', pipe: 'stdout', text: 'first' });
    clock.advance(10);
    hub.publish('codex-1', { kind: 'output', pipe: 'stdout', text: 'second' });
    clock.advance(10);
    hub.publish('claude-1', { kind: 'output', pipe: 'stdout', text: 'third' });
    expect(hub.history().map((frame) => frame.at)).toEqual([0, 10, 20]);
  });

  it('stops delivering after unsubscribe', () => {
    const hub = new StreamHub(4096, fakeClock().now);
    const seen: StreamFrame[] = [];
    const { dispose } = hub.subscribe((frame) => seen.push(frame));
    hub.publish('claude-1', { kind: 'output', pipe: 'stdout', text: 'a' });
    dispose();
    hub.publish('claude-1', { kind: 'output', pipe: 'stdout', text: 'b' });
    expect(seen).toHaveLength(1);
  });

  it('contains a throwing subscriber', () => {
    const hub = new StreamHub(4096, fakeClock().now);
    const survivor = vi.fn();
    hub.subscribe(() => {
      throw new Error('broken pipe');
    });
    hub.subscribe(survivor);
    expect(() =>
      hub.publish('claude-1', { kind: 'output', pipe: 'stdout', text: 'a' })
    ).not.toThrow();
    expect(survivor).toHaveBeenCalledOnce();
  });

  it('evicts the oldest frames past the byte budget', () => {
    const hub = new StreamHub(512, fakeClock().now);
    for (let index = 0; index < 20; index += 1) {
      hub.publish('claude-1', {
        kind: 'output',
        pipe: 'stdout',
        text: 'x'.repeat(100),
      });
    }
    const retained = hub.history({ stream: 'claude-1' });
    expect(retained.length).toBeLessThan(20);
    // The newest frame always survives, so a reconnect never shows a stale tail.
    expect(retained.at(-1)?.seq).toBe(20);
  });

  it('keeps at least the newest frame even when it alone exceeds the budget', () => {
    const hub = new StreamHub(64, fakeClock().now);
    hub.publish('claude-1', {
      kind: 'output',
      pipe: 'stdout',
      text: 'y'.repeat(4096),
    });
    expect(hub.history({ stream: 'claude-1' })).toHaveLength(1);
  });

  it('forgets a run', () => {
    const hub = new StreamHub(4096, fakeClock().now);
    hub.publish('claude-1', { kind: 'snapshot', snapshot });
    hub.forget('claude-1');
    expect(hub.history({ stream: 'claude-1' })).toEqual([]);
  });

  it('measures every frame kind', () => {
    const hub = new StreamHub(4096, fakeClock().now);
    hub.publish('claude-1', { kind: 'snapshot', snapshot });
    hub.publish('claude-1', {
      kind: 'activity',
      activity: { type: 'message', text: 'hi' },
    });
    hub.publish('claude-1', {
      kind: 'end',
      end: { status: 'completed', summary: 'done', durationMs: 1 },
    });
    expect(hub.history({ stream: 'claude-1' })).toHaveLength(3);
  });
});
