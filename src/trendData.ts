import { DailyBucket, UsageEvent } from "./models";

export interface TrendPoint {
  day: string;
  model: string;
  input: number;
  output: number;
  cache: number;
  tokens: number;
  cents: number;
}

function eventMs(ts: number): number {
  return ts > 0 && ts < 1e12 ? ts * 1000 : ts;
}

export function dayKeyFromTs(ts: number): string {
  const d = new Date(eventMs(ts));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isoDay(value: string): string {
  if (!value) return "";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  return dayKeyFromTs(ms);
}

export function addDaysIso(iso: string, n: number): string {
  const parts = iso.split("-").map(Number);
  const dt = new Date(parts[0], parts[1] - 1, parts[2] + n);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local midnight of YYYY-MM-DD. */
export function dayStartMs(iso: string): number {
  const parts = iso.split("-").map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
}

/** Last ms of local day YYYY-MM-DD. */
export function dayEndMs(iso: string): number {
  return dayStartMs(addDaysIso(iso, 1)) - 1;
}

/** Window for trend date inputs: at least last 7 days when cycle start missing. */
export function computeTrendRange(opts: {
  billingCycleStart: string;
  billingCycleEnd: string;
  dataDays: string[];
  nowMs?: number;
}): { minDay: string; maxDay: string } {
  const today = dayKeyFromTs(opts.nowMs ?? Date.now());
  const cycleStart = isoDay(opts.billingCycleStart);
  const cycleEnd = isoDay(opts.billingCycleEnd);
  const sorted = [...opts.dataDays].filter(Boolean).sort();
  const earliestData = sorted[0];
  const latestData = sorted[sorted.length - 1];
  const weekAgo = addDaysIso(today, -6);
  const maxDay = cycleEnd && cycleEnd < today ? cycleEnd : today;
  const floorA = cycleStart || weekAgo;
  const floorB = earliestData || weekAgo;
  let minDay = floorA <= floorB ? floorA : floorB;
  if (minDay > maxDay) {
    return { minDay: earliestData || weekAgo, maxDay: latestData || today };
  }
  return { minDay, maxDay };
}

/**
 * Build chart points from daily buckets (history) + raw events (typically today).
 * compactEvents keeps today only in events, so same-day double-count is avoided.
 */
export function buildTrendPoints(events: UsageEvent[], dailyBuckets: DailyBucket[] = []): TrendPoint[] {
  const points: TrendPoint[] = [];

  for (const b of dailyBuckets) {
    if (b.byModel.length > 0) {
      const tok = Math.max(1, b.totalTokens);
      for (const m of b.byModel) {
        const share = m.totalTokens / tok;
        points.push({
          day: b.day,
          model: m.model,
          input: m.inputTokens,
          output: m.outputTokens,
          cache: m.cacheWriteTokens + m.cacheReadTokens,
          tokens: m.totalTokens,
          cents: Math.round(b.totalCents * share),
        });
      }
    } else {
      points.push({
        day: b.day,
        model: "unknown",
        input: b.inputTokens,
        output: b.outputTokens,
        cache: b.cacheWriteTokens + b.cacheReadTokens,
        tokens: b.totalTokens,
        cents: b.totalCents,
      });
    }
  }

  for (const e of events) {
    if (!e.timestamp) continue;
    points.push({
      day: dayKeyFromTs(e.timestamp),
      model: e.model,
      input: e.inputTokens,
      output: e.outputTokens,
      cache: e.cacheWriteTokens + e.cacheReadTokens,
      tokens: e.totalTokens,
      cents: e.totalCents,
    });
  }

  return points;
}

/** Safe to add: compactEvents keeps today only in events, history only in buckets. */
export function sumUsageCostCents(events: UsageEvent[], dailyBuckets: DailyBucket[] = []): number {
  const fromEvents = events.reduce((s, e) => s + (e.totalCents || 0), 0);
  const fromBuckets = dailyBuckets.reduce((s, b) => s + (b.totalCents || 0), 0);
  return fromEvents + fromBuckets;
}
