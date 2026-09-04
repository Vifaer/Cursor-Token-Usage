import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyStatsRange,
  buildCombinedViewForRange,
  resolveStatsRange,
  snapshotRangeSlice,
} from "../dayStats";
import { dayKeyFromTs } from "../trendData";
import { DailyBucket, UsageEvent, UsageSnapshot } from "../models";

function ev(partial: Partial<UsageEvent> & { timestamp: number }): UsageEvent {
  return {
    model: "m",
    kind: "USAGE",
    totalTokens: 10,
    inputTokens: 5,
    outputTokens: 5,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalCents: 0,
    ...partial,
  };
}

function snap(partial: Partial<UsageSnapshot> & { userId: string }): UsageSnapshot {
  return {
    timestamp: new Date(),
    membershipType: "pro",
    billingCycleStart: "",
    billingCycleEnd: "",
    isUnlimited: false,
    displayMode: "overall",
    cursorModelsPercent: 50,
    otherModelsPercent: null,
    totalPercent: null,
    overallUsedCents: 100,
    overallLimitCents: 1000,
    onDemandEnabled: false,
    onDemandUsedCents: null,
    onDemandLimitCents: null,
    aggregations: [{ model: "m", inputTokens: 1000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 1000 }],
    events: [],
    eventsComplete: true,
    totalTokens: 1000,
    dailyBuckets: [],
    ...partial,
  };
}

describe("resolveStatsRange", () => {
  const now = Date.parse("2026-08-31T12:00:00");
  it("cycle returns empty from/to", () => {
    const r = resolveStatsRange({ mode: "cycle" }, now);
    assert.equal(r.from, "");
    assert.equal(r.to, "");
  });
  it("today/yesterday/7d", () => {
    assert.equal(resolveStatsRange({ mode: "today" }, now).from, "2026-08-31");
    assert.equal(resolveStatsRange({ mode: "yesterday" }, now).from, "2026-08-30");
    assert.equal(resolveStatsRange({ mode: "7d" }, now).from, "2026-08-25");
    assert.equal(resolveStatsRange({ mode: "7d" }, now).to, "2026-08-31");
  });
  it("custom swaps from > to", () => {
    const r = resolveStatsRange({ mode: "custom", from: "2026-08-31", to: "2026-08-25" }, now);
    assert.equal(r.from, "2026-08-25");
    assert.equal(r.to, "2026-08-31");
  });
});

describe("snapshotRangeSlice", () => {
  const now = Date.parse("2026-08-31T12:00:00");
  const today = dayKeyFromTs(now);

  it("does not double-count today bucket + events", () => {
    const bucket: DailyBucket = {
      day: today,
      totalTokens: 999,
      inputTokens: 999,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalCents: 0,
      requestCount: 1,
      byModel: [{ model: "m", inputTokens: 999, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 999 }],
    };
    const s = snap({
      userId: "u1",
      events: [ev({ timestamp: now, totalTokens: 7, inputTokens: 7 })],
      dailyBuckets: [bucket],
    });
    const slice = snapshotRangeSlice(s, today, today, today);
    assert.equal(slice.totalTokens, 7);
  });

  it("uses bucket only for historical days", () => {
    const y = dayKeyFromTs(now - 36 * 60 * 60 * 1000);
    const bucket: DailyBucket = {
      day: y,
      totalTokens: 50,
      inputTokens: 50,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalCents: 0,
      requestCount: 1,
      byModel: [{ model: "m", inputTokens: 50, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 50 }],
    };
    const s = snap({ userId: "u1", dailyBuckets: [bucket] });
    const slice = snapshotRangeSlice(s, y, y, today);
    assert.equal(slice.totalTokens, 50);
  });

  it("does not double-count historical day when both bucket and events exist", () => {
    const yMs = now - 36 * 60 * 60 * 1000;
    const y = dayKeyFromTs(yMs);
    const bucket: DailyBucket = {
      day: y,
      totalTokens: 50,
      inputTokens: 50,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalCents: 0,
      requestCount: 1,
      byModel: [{ model: "m", inputTokens: 50, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 50 }],
    };
    const s = snap({
      userId: "u1",
      dailyBuckets: [bucket],
      events: [ev({ timestamp: yMs, totalTokens: 99, inputTokens: 99 })],
    });
    const slice = snapshotRangeSlice(s, y, y, today);
    assert.equal(slice.totalTokens, 50);
    assert.equal(slice.events.length, 0);
  });

  it("ignores cycle aggregations when slicing", () => {
    const s = snap({
      userId: "u1",
      aggregations: [{ model: "m", inputTokens: 1000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 1000 }],
      events: [ev({ timestamp: now, totalTokens: 10, inputTokens: 10 })],
      totalTokens: 1000,
    });
    const slice = snapshotRangeSlice(s, today, today, today);
    assert.equal(slice.totalTokens, 10);
  });
});

describe("buildCombinedViewForRange", () => {
  const now = Date.parse("2026-08-31T12:00:00");
  const today = dayKeyFromTs(now);

  it("sums sliced totals across accounts", () => {
    const a1 = snap({ userId: "a1", events: [ev({ timestamp: now, totalTokens: 10, inputTokens: 10 })] });
    const a2 = snap({ userId: "a2", events: [ev({ timestamp: now, totalTokens: 20, inputTokens: 20 })] });
    const view = buildCombinedViewForRange([a1, a2], today, today);
    assert.ok(view);
    assert.equal(view!.totalTokens, 30);
  });
});

describe("applyStatsRange", () => {
  const now = Date.parse("2026-08-31T12:00:00");
  const today = dayKeyFromTs(now);

  it("cycle returns same reference", () => {
    const a1 = snap({ userId: "a1" });
    const combined = buildCombinedViewForRange([a1], "2026-08-31", "2026-08-31");
    assert.ok(combined);
    const out = applyStatsRange(combined, [a1], { mode: "cycle" });
    assert.equal(out, combined);
  });

  it("single account slice", () => {
    const a1 = snap({
      userId: "a1",
      totalTokens: 1000,
      events: [ev({ timestamp: now, totalTokens: 5, inputTokens: 5 })],
    });
    const out = applyStatsRange(a1, [a1], { mode: "custom", from: today, to: today }, "a1") as UsageSnapshot;
    assert.equal(out.totalTokens, 5);
    assert.equal(out.events.length, 1);
  });
});
