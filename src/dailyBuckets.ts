import { DailyBucket, ModelAgg, UsageEvent } from "./models";

export const MAX_EVENTS_PER_ACCOUNT = 500;
export const MAX_DAILY_BUCKETS = 90;

export function localDay(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayLocal(): string {
  return localDay(Date.now());
}

function emptyBucket(day: string): DailyBucket {
  return {
    day,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalCents: 0,
    requestCount: 0,
    byModel: [],
  };
}

function addEventToBucket(bucket: DailyBucket, e: UsageEvent): void {
  bucket.totalTokens += e.totalTokens;
  bucket.inputTokens += e.inputTokens;
  bucket.outputTokens += e.outputTokens;
  bucket.cacheWriteTokens += e.cacheWriteTokens;
  bucket.cacheReadTokens += e.cacheReadTokens;
  bucket.totalCents += e.totalCents;
  bucket.requestCount += 1;
  const prev = bucket.byModel.find((m) => m.model === e.model);
  if (prev) {
    prev.inputTokens += e.inputTokens;
    prev.outputTokens += e.outputTokens;
    prev.cacheWriteTokens += e.cacheWriteTokens;
    prev.cacheReadTokens += e.cacheReadTokens;
    prev.totalTokens += e.totalTokens;
  } else {
    bucket.byModel.push({
      model: e.model,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheWriteTokens: e.cacheWriteTokens,
      cacheReadTokens: e.cacheReadTokens,
      totalTokens: e.totalTokens,
    } satisfies ModelAgg);
  }
}

/** Compact historical events into daily buckets; keep today's raw events. */
export function compactEvents(
  events: UsageEvent[],
  existingBuckets: DailyBucket[] = [],
  today = todayLocal(),
): { events: UsageEvent[]; dailyBuckets: DailyBucket[] } {
  const bucketMap = new Map<string, DailyBucket>();
  for (const b of existingBuckets) {
    bucketMap.set(b.day, { ...b, byModel: b.byModel.map((m) => ({ ...m })) });
  }

  const todayEvents: UsageEvent[] = [];
  for (const e of events) {
    const day = localDay(e.timestamp);
    if (day === today) {
      todayEvents.push(e);
      continue;
    }
    let bucket = bucketMap.get(day);
    if (!bucket) {
      bucket = emptyBucket(day);
      bucketMap.set(day, bucket);
    }
    addEventToBucket(bucket, e);
  }

  const dailyBuckets = [...bucketMap.values()]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, MAX_DAILY_BUCKETS);

  return {
    events: todayEvents.slice(0, MAX_EVENTS_PER_ACCOUNT),
    dailyBuckets,
  };
}

export function shouldCompact(events: UsageEvent[], buckets: DailyBucket[], today = todayLocal()): boolean {
  if (events.length > MAX_EVENTS_PER_ACCOUNT) return true;
  if (buckets.length > MAX_DAILY_BUCKETS) return true;
  return events.some((e) => localDay(e.timestamp) !== today);
}
