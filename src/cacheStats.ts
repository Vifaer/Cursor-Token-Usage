import { ModelAgg, UsageEvent } from "./models";

export interface CacheStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** cacheRead / (cacheRead + input); null when denominator is 0 */
  hitRate: number | null;
  /** (cacheRead + cacheWrite) / totalTokens */
  cacheShare: number | null;
}

const EMPTY: CacheStats = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  hitRate: null,
  cacheShare: null,
};

function finalize(input: number, output: number, cacheRead: number, cacheWrite: number): CacheStats {
  const totalTokens = input + output + cacheRead + cacheWrite;
  const denom = cacheRead + input;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens,
    hitRate: denom > 0 ? cacheRead / denom : null,
    cacheShare: totalTokens > 0 ? (cacheRead + cacheWrite) / totalTokens : null,
  };
}

export function computeCacheStatsFromAggs(aggs: ModelAgg[]): CacheStats {
  if (aggs.length === 0) return { ...EMPTY };
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const a of aggs) {
    input += a.inputTokens;
    output += a.outputTokens;
    cacheRead += a.cacheReadTokens;
    cacheWrite += a.cacheWriteTokens;
  }
  return finalize(input, output, cacheRead, cacheWrite);
}

export function computeCacheStatsFromEvents(events: UsageEvent[]): CacheStats {
  if (events.length === 0) return { ...EMPTY };
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const e of events) {
    input += e.inputTokens;
    output += e.outputTokens;
    cacheRead += e.cacheReadTokens;
    cacheWrite += e.cacheWriteTokens;
  }
  return finalize(input, output, cacheRead, cacheWrite);
}

/** Patch only fields where agg=0 and events>0; never replace full-cycle read with event samples. */
export function mergeCacheStats(agg: CacheStats, evt: CacheStats): CacheStats {
  const input = agg.inputTokens;
  const output = agg.outputTokens;
  const cacheRead = agg.cacheReadTokens || evt.cacheReadTokens;
  const cacheWrite = agg.cacheWriteTokens || evt.cacheWriteTokens;
  return finalize(input, output, cacheRead, cacheWrite);
}

export function computeCacheStats(aggs: ModelAgg[], events: UsageEvent[]): CacheStats {
  const fromAggs = computeCacheStatsFromAggs(aggs);
  if (aggs.length === 0) return computeCacheStatsFromEvents(events);
  const fromEvents = computeCacheStatsFromEvents(events);
  return mergeCacheStats(fromAggs, fromEvents);
}

export function formatHitRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  return `${Math.round(rate * 100)}%`;
}
