import { DailyBucket, ModelAgg, UsageEvent } from "./models";
import { dayKeyFromTs } from "./trendData";

export const MAX_EVENTS_PER_ACCOUNT = 500;
export const MAX_DAILY_BUCKETS = 90;

/** Normalize API/stored timestamps to milliseconds. */
export function eventMs(ts: number): number {
  return ts > 0 && ts < 1e12 ? ts * 1000 : ts;
}

/** Local calendar day for an event timestamp (seconds or ms). */
export function localDay(ts: number): string {
  return dayKeyFromTs(ts);
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

/** Build one sealed day bucket from events (caller must not pass already-bucketed days). */
export function buildBucketFromEvents(day: string, events: UsageEvent[]): DailyBucket {
  const bucket = emptyBucket(day);
  for (const e of events) addEventToBucket(bucket, e);
  return bucket;
}

/** Group events by local day key. */
export function groupEventsByDay(events: UsageEvent[]): Map<string, UsageEvent[]> {
  const map = new Map<string, UsageEvent[]>();
  for (const e of events) {
    const day = localDay(e.timestamp);
    const list = map.get(day);
    if (list) list.push(e);
    else map.set(day, [e]);
  }
  return map;
}

/**
 * Compact historical events into daily buckets; keep today's raw events.
 * Sealed days (already in existingBuckets) are NEVER re-added — residual events for those days are dropped.
 * Only days without a bucket are built once from events.
 */
export function compactEvents(
  events: UsageEvent[],
  existingBuckets: DailyBucket[] = [],
  today = todayLocal(),
): { events: UsageEvent[]; dailyBuckets: DailyBucket[] } {
  const bucketMap = new Map<string, DailyBucket>();
  for (const b of existingBuckets) {
    if (!b.day || b.day < "2020-01-01") continue; // drop pre-epoch garbage from seconds/ms bugs
    bucketMap.set(b.day, { ...b, byModel: b.byModel.map((m) => ({ ...m })) });
  }

  const todayEvents: UsageEvent[] = [];
  const pending = new Map<string, UsageEvent[]>();

  for (const e of events) {
    const day = localDay(e.timestamp);
    if (day === today) {
      todayEvents.push(e);
      continue;
    }
    if (bucketMap.has(day)) continue; // already sealed
    const list = pending.get(day);
    if (list) list.push(e);
    else pending.set(day, [e]);
  }

  for (const [day, dayEvents] of pending) {
    bucketMap.set(day, buildBucketFromEvents(day, dayEvents));
  }

  const dailyBuckets = [...bucketMap.values()]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, MAX_DAILY_BUCKETS);

  return {
    events: todayEvents.slice(0, MAX_EVENTS_PER_ACCOUNT),
    dailyBuckets,
  };
}

/**
 * Replace sealed buckets for days in [from, to] (exclusive of today) from fetched events.
 * Empty fetch for a day removes that day's bucket (clears corruption).
 * Today stays in the events array.
 */
export function applyFetchedRange(
  prevEvents: UsageEvent[],
  prevBuckets: DailyBucket[],
  fetched: UsageEvent[],
  from: string,
  to: string,
  today = todayLocal(),
): { events: UsageEvent[]; dailyBuckets: DailyBucket[] } {
  const byDay = groupEventsByDay(fetched);
  const bucketMap = new Map<string, DailyBucket>();
  for (const b of prevBuckets) {
    if (!b.day || b.day < "2020-01-01") continue;
    bucketMap.set(b.day, { ...b, byModel: b.byModel.map((m) => ({ ...m })) });
  }

  for (let day = from; day <= to; day = nextDay(day)) {
    if (day === today) continue;
    const dayEvents = byDay.get(day) ?? [];
    if (dayEvents.length === 0) {
      bucketMap.delete(day);
    } else {
      bucketMap.set(day, buildBucketFromEvents(day, dayEvents));
    }
  }

  const fetchedToday = byDay.get(today) ?? [];
  const prevToday = prevEvents.filter((e) => localDay(e.timestamp) === today);
  const seen = new Set(prevToday.map(eventKey));
  const mergedToday = [...prevToday];
  for (const e of fetchedToday) {
    const k = eventKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    mergedToday.push(e);
  }

  const dailyBuckets = [...bucketMap.values()]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, MAX_DAILY_BUCKETS);

  return {
    events: mergedToday.slice(0, MAX_EVENTS_PER_ACCOUNT),
    dailyBuckets,
  };
}

function eventKey(e: UsageEvent): string {
  return `${e.timestamp}|${e.model}|${e.kind}`;
}

function nextDay(iso: string): string {
  const parts = iso.split("-").map(Number);
  const dt = new Date(parts[0], parts[1] - 1, parts[2] + 1);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function shouldCompact(events: UsageEvent[], buckets: DailyBucket[], today = todayLocal()): boolean {
  if (events.length > MAX_EVENTS_PER_ACCOUNT) return true;
  if (buckets.length > MAX_DAILY_BUCKETS) return true;
  if (buckets.some((b) => b.day < "2020-01-01")) return true;
  return events.some((e) => localDay(e.timestamp) !== today);
}

/** Normalize event timestamps to ms (idempotent). */
export function normalizeEventTimestamps(events: UsageEvent[]): UsageEvent[] {
  return events.map((e) => {
    const ms = eventMs(e.timestamp);
    return ms === e.timestamp ? e : { ...e, timestamp: ms };
  });
}
