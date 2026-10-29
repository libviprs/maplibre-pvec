import type { PriorityClass } from "./scheduler";

/**
 * Range coalescing with a latency guard. Every number below is PROVISIONAL: it is a starting
 * value, not a measurement. The thresholds are tuned by #43-era benchmarks (M8.2 measures the
 * network behaviour, M8.6 tunes the values); nothing here is frozen before those land.
 */

/** PROVISIONAL (M8.6): cold-start round trip, used until real samples arrive. */
export const COLD_RTT_MS = 100;
/** PROVISIONAL (M8.6): cold-start bandwidth, 10 Mbit/s in bytes per millisecond. */
export const COLD_BANDWIDTH_BYTES_PER_MS = 1250;
/** PROVISIONAL (M8.6): EWMA weight of a new sample. */
const EWMA_ALPHA = 0.25;
/** PROVISIONAL (M8.6): a merged request never spans more than this (matches the reference reader). */
export const MAX_MERGED_BYTES = 16 * 1024 * 1024;

/**
 * Merge two ranges separated by `gapBytes` when the round trip saved is worth more than the time
 * spent downloading bytes nobody asked for. A visible Tier 0 range (class 1) also pays the
 * head-of-line delay the filler imposes on it, so the overfetch cost counts twice for it.
 */
export function shouldMerge(gapBytes: number, rttMs: number, bandwidthBytesPerMs: number, priorityClass: PriorityClass): boolean {
  if (gapBytes <= 0) return true;
  if (bandwidthBytesPerMs <= 0) return false;
  const overfetchMs = gapBytes / bandwidthBytesPerMs;
  const headOfLineMs = priorityClass === 1 ? overfetchMs : 0;
  return rttMs > overfetchMs + headOfLineMs;
}

export class RttBandwidthEstimator {
  rttMs = COLD_RTT_MS;
  bandwidthBytesPerMs = COLD_BANDWIDTH_BYTES_PER_MS;

  record(s: { ttfbMs: number; bodyMs: number; bytes: number }): void {
    this.rttMs += EWMA_ALPHA * (s.ttfbMs - this.rttMs);
    // Tiny or instant bodies say nothing about bandwidth.
    if (s.bodyMs >= 1 && s.bytes >= 1024) {
      this.bandwidthBytesPerMs += EWMA_ALPHA * (s.bytes / s.bodyMs - this.bandwidthBytesPerMs);
    }
  }
}

export interface OverfetchEntry {
  requestedBytes: number;
  usedBytes: number;
}

export class OverfetchLedger {
  requests = 0;
  requestedBytes = 0;
  usedBytes = 0;
  readonly perRequest: OverfetchEntry[] = [];

  add(e: OverfetchEntry): void {
    this.requests++;
    this.requestedBytes += e.requestedBytes;
    this.usedBytes += e.usedBytes;
    this.perRequest.push(e);
  }
  /** Fetched bytes over used bytes; 1 means nothing was wasted. */
  get ratio(): number {
    return this.usedBytes === 0 ? 1 : this.requestedBytes / this.usedBytes;
  }
}

export interface PlanInput {
  id: number;
  offset: number;
  length: number;
  priority: PriorityClass;
}
export interface MergedRange<T extends PlanInput> {
  offset: number;
  length: number;
  /** Bytes of the union of the members, so overlap is not counted twice. */
  usedBytes: number;
  members: T[];
}

/** Pure planner: group offset-sorted ranges whenever the guard says a merge pays. */
export function planMerges<T extends PlanInput>(
  requests: readonly T[],
  net: { rttMs: number; bandwidthBytesPerMs: number },
): MergedRange<T>[] {
  const sorted = [...requests].sort((a, b) => a.offset - b.offset || a.id - b.id);
  const out: MergedRange<T>[] = [];
  let cur: MergedRange<T> | undefined;
  let best: PriorityClass = 5;
  for (const r of sorted) {
    if (cur) {
      const end = cur.offset + cur.length;
      const gap = Math.max(0, r.offset - end);
      // The most urgent member bears the delay, so it decides.
      const cls = Math.min(best, r.priority) as PriorityClass;
      const newEnd = Math.max(end, r.offset + r.length);
      if (newEnd - cur.offset <= MAX_MERGED_BYTES && shouldMerge(gap, net.rttMs, net.bandwidthBytesPerMs, cls)) {
        cur.usedBytes += Math.max(0, r.offset + r.length - Math.max(end, r.offset));
        cur.length = newEnd - cur.offset;
        cur.members.push(r);
        best = cls;
        continue;
      }
    }
    cur = { offset: r.offset, length: r.length, usedBytes: r.length, members: [r] };
    best = r.priority;
    out.push(cur);
  }
  return out;
}
