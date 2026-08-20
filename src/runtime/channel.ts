/**
 * The Host → Web stream hub.
 *
 * Delegate output goes here and only here. It is never appended to the session
 * log, never injected into an agent, and never returned from a tool — which is
 * the whole reason a delegated run costs DeepSeek one request instead of one
 * per screenful of somebody else's output.
 *
 * The hub is transport-agnostic on purpose: the HTTP layer above it turns
 * frames into Server-Sent Events, and any other carrier could subscribe the
 * same way.
 *
 * @module dsh-cli-bridge/runtime/channel
 */
import type { StreamFrame, StreamKey } from '../shared/protocol.ts';
import { byteLength } from '../domain/text.ts';

/**
 * A frame as a publisher states it; the hub stamps identity and order.
 *
 * The omission distributes over the union — a plain `Omit` would collapse the
 * four frame kinds into their shared keys and silently accept a snapshot frame
 * with no snapshot.
 */
export type FrameBody = StreamFrame extends infer Frame
  ? Frame extends StreamFrame ? Omit<Frame, 'seq' | 'at' | 'stream'> : never
  : never;

/** Receives frames as they are published. */
export type FrameListener = (frame: StreamFrame) => void;

/** What a subscriber wants to see. */
export interface Subscription {
  /** Restrict to one stream; omit to follow every stream. */
  readonly stream?: StreamKey;
  /** Replay buffered frames after this sequence number before going live. */
  readonly from?: number;
}

/** Retained frames of one stream. */
interface StreamBuffer {
  seq: number;
  bytes: number;
  frames: StreamFrame[];
}

/**
 * Per-stream fan-out with a bounded replay buffer.
 *
 * The buffer exists so a browser that attaches to a run already in flight — or
 * reconnects after a dropped socket — sees recent context instead of a blank
 * pane. It is bounded in BYTES rather than frames because the thing being
 * protected is host memory, and one frame can be a megabyte of build log.
 */
export class StreamHub {
  private readonly buffers = new Map<StreamKey, StreamBuffer>();
  private readonly listeners = new Set<
    { subscription: Subscription; listener: FrameListener }
  >();

  constructor(
    private readonly bufferBytesPerStream: number,
    private readonly now: () => number,
  ) {}

  /**
   * Publish one frame: stamp it, retain it, fan it out.
   *
   * A throwing listener is contained — one broken browser connection must not
   * stop a run or starve the other subscribers.
   * @param run - the run the frame belongs to.
   * @param body - the frame without its identity fields.
   * @returns the stamped frame.
   */
  publish(stream: StreamKey, body: FrameBody): StreamFrame {
    const buffer = this.bufferOf(stream);
    buffer.seq += 1;
    const frame = {
      ...body,
      seq: buffer.seq,
      at: this.now(),
      stream,
    } as StreamFrame;
    this.retain(buffer, frame);
    for (const entry of this.listeners) {
      if (
        entry.subscription.stream !== undefined &&
        entry.subscription.stream !== stream
      ) continue;
      try {
        entry.listener(frame);
      } catch {
        // A subscriber's failure is its own; the run continues.
      }
    }
    return frame;
  }

  /**
   * Attach a listener and take the backlog it asked for in the same breath.
   *
   * Both happen in one synchronous step, so no frame can slip between the
   * replay and the live subscription.
   * @param listener - receives every matching frame from now on.
   * @param subscription - what to follow, and where to resume.
   * @returns the buffered frames to deliver first, and the unsubscriber.
   */
  subscribe(listener: FrameListener, subscription: Subscription = {}): {
    readonly backlog: readonly StreamFrame[];
    readonly dispose: () => void;
  } {
    const backlog = this.history(subscription);
    const entry = { subscription, listener };
    this.listeners.add(entry);
    return {
      backlog,
      dispose: () => {
        this.listeners.delete(entry);
      },
    };
  }

  /**
   * Read retained frames without subscribing.
   * @param subscription - what to read, and where to resume.
   * @returns matching frames in publication order.
   */
  history(subscription: Subscription = {}): StreamFrame[] {
    const from = subscription.from ?? 0;
    const buffers = subscription.stream === undefined
      ? [...this.buffers.values()]
      : [this.buffers.get(subscription.stream)].filter((
        buffer,
      ): buffer is StreamBuffer => buffer !== undefined);
    const frames = buffers.flatMap((buffer) =>
      buffer.frames.filter((frame) => frame.seq > from)
    );
    // Across streams, sequence numbers are per-stream, so replay order is by time.
    return subscription.stream === undefined
      ? frames.toSorted((left, right) => left.at - right.at)
      : frames;
  }

  /**
   * Drop a settled stream's retained frames.
   * @param stream - the stream to forget.
   */
  forget(stream: StreamKey): void {
    this.buffers.delete(stream);
  }

  /** Retained frames plus the running sequence for one stream. */
  private bufferOf(stream: StreamKey): StreamBuffer {
    const existing = this.buffers.get(stream);
    if (existing !== undefined) return existing;
    const created: StreamBuffer = { seq: 0, bytes: 0, frames: [] };
    this.buffers.set(stream, created);
    return created;
  }

  /** Append a frame and evict the oldest until the buffer fits its budget. */
  private retain(buffer: StreamBuffer, frame: StreamFrame): void {
    const size = frameBytes(frame);
    buffer.frames.push(frame);
    buffer.bytes += size;
    while (
      buffer.bytes > this.bufferBytesPerStream && buffer.frames.length > 1
    ) {
      const dropped = buffer.frames.shift();
      /* v8 ignore next -- the length guard above proves the shift yields a frame. */
      if (dropped === undefined) break;
      buffer.bytes -= frameBytes(dropped);
    }
  }
}

/** Approximate retained size of one frame: its payload text plus a fixed envelope. */
function frameBytes(frame: StreamFrame): number {
  const envelope = 64;
  switch (frame.kind) {
    case 'output':
      return envelope + byteLength(frame.text);
    case 'activity':
      return envelope + byteLength(JSON.stringify(frame.activity));
    case 'end':
      return envelope + byteLength(JSON.stringify(frame.end));
    case 'snapshot':
      return envelope + byteLength(JSON.stringify(frame.snapshot));
    case 'delegation':
      return envelope + byteLength(JSON.stringify(frame.delegation));
  }
}
