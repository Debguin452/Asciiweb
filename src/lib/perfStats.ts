// Temporary measurement instrumentation for Priority 3 item 17's audit (docs/priority3-pipeline-audit.md, finding #1:
// the receive-side double getImageData() readback in CallTab.tsx's paintCanvas). This module is deliberately NOT part
// of the shipped feature set — it's here to gather real on-device numbers (capture-readback vs receive-readback vs
// enhance() time, broken down by frame size) before deciding whether/how to remove the avoidable readback. Every call
// site that uses it is a single wrapped `record()` call around existing code, so it's trivial to strip back out once
// the measurement phase is done.
//
// Overhead is kept low on purpose: one `performance.now()` call either side of the measured work (already cheap, and
// the exact same pattern governor.ts's notePaint() uses) plus a write into a fixed-size ring buffer — no allocation,
// no sorting, on the hot path. Sorting/percentiles only happen when a summary is actually requested.

const CAPACITY = 600; // ~20s of samples at 30fps per bucket — bounded, never grows

interface Bucket { buf: Float32Array; idx: number; count: number }
const buckets = new Map<string, Bucket>();

/** Records one timing sample (in ms) into a named bucket. Cheap enough to call every frame. */
export function record(bucket: string, ms: number) {
  if (!(ms >= 0) || ms > 2000) return; // guard against clock weirdness, same spirit as governor.ts's noteWork/notePaint
  let b = buckets.get(bucket);
  if (!b) { b = { buf: new Float32Array(CAPACITY), idx: 0, count: 0 }; buckets.set(bucket, b); }
  b.buf[b.idx] = ms;
  b.idx = (b.idx + 1) % CAPACITY;
  b.count = Math.min(CAPACITY, b.count + 1);
}

/** Bucket key helper so readback/enhance timings are grouped by the frame size they ran at (quality tiers mean this
 *  stays a small, fixed set of keys over a call, not one key per frame). */
export function sizedBucket(name: string, w: number, h: number): string {
  return `${name}@${w}x${h}`;
}

interface Summary { count: number; mean: number; median: number; p95: number; max: number }

function summarize(b: Bucket): Summary {
  const n = b.count;
  const vals = Array.from(b.buf.subarray(0, n)); // valid samples are always buf[0..count) until the buffer first wraps
  vals.sort((a, c) => a - c);
  const mean = vals.reduce((s, v) => s + v, 0) / n;
  return {
    count: n,
    mean: +mean.toFixed(3),
    median: +vals[Math.floor(n * 0.5)].toFixed(3),
    p95: +vals[Math.min(n - 1, Math.floor(n * 0.95))].toFixed(3),
    max: +vals[n - 1].toFixed(3),
  };
}

/** All buckets' stats, for programmatic use (e.g. copying out of a devtools console). */
export function getSummary(): Record<string, Summary> {
  const out: Record<string, Summary> = {};
  for (const [name, b] of buckets) if (b.count > 0) out[name] = summarize(b);
  return out;
}

/** Prints a compact one-line summary to the console — call manually (e.g. `__perfStats.logSummary()` in devtools) or on
 *  the periodic timer CallTab sets up while a call is active. `context` is free-form info to print alongside (tile
 *  count, mode).
 *
 *  Deliberately NOT console.table(): over a remote-debugging connection every cell has to be serialized across the
 *  inspector protocol, and with enough buckets that observably blocked the main thread for 100+ ms right at the
 *  moment it fired (a `setInterval` "Violation" was traced directly to this call) — the measurement tool was adding
 *  more jank than the thing it measured. A single formatted string is orders of magnitude cheaper to log.
 */
export function logSummary(context?: string) {
  const s = getSummary();
  const keys = Object.keys(s);
  if (keys.length === 0) return;
  const line = keys
    .map((k) => {
      const b = s[k];
      return `${k}: n=${b.count} mean=${b.mean.toFixed(1)} p95=${b.p95.toFixed(1)} max=${b.max.toFixed(1)}`;
    })
    .join(" | ");
  console.log(`[perfStats]${context ? ` ${context}` : ""} ${line}`);
}

export function resetStats() {
  buckets.clear();
}

// Exposed for manual inspection from Chrome's remote-debugging console on a phone, where there's no other convenient
// way to pull these numbers out mid-call. Read-only — nothing here can be used to change app behavior.
if (typeof window !== "undefined") {
  (window as unknown as { __perfStats?: unknown }).__perfStats = { getSummary, logSummary, resetStats };
}
