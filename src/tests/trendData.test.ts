import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTrendPoints, computeTrendRange, dayEndMs, dayStartMs, sumUsageCostCents } from "../trendData";
import { DailyBucket, UsageEvent } from "../models";

function ev(dayMs: number, cents = 0): UsageEvent {
  return {
    timestamp: dayMs,
    model: "m",
    kind: "USAGE",
    inputTokens: 10,
    outputTokens: 5,
    cacheWriteTokens: 0,
    cacheReadTokens: 90,
    totalTokens: 105,
    totalCents: cents,
  };
}

describe("computeTrendRange", () => {
  it("ensures at least a 7-day window when cycle start is missing", () => {
    const now = Date.parse("2026-08-28T12:00:00");
    const { minDay, maxDay } = computeTrendRange({
      billingCycleStart: "",
      billingCycleEnd: "2026-09-24",
      dataDays: ["2026-08-28"],
      nowMs: now,
    });
    assert.equal(maxDay, "2026-08-28");
    assert.equal(minDay, "2026-08-22");
  });

  it("uses billing cycle start when earlier than week ago", () => {
    const now = Date.parse("2026-08-28T12:00:00");
    const { minDay, maxDay } = computeTrendRange({
      billingCycleStart: "2026-08-01",
      billingCycleEnd: "2026-09-01",
      dataDays: ["2026-08-28"],
      nowMs: now,
    });
    assert.equal(minDay, "2026-08-01");
    assert.equal(maxDay, "2026-08-28");
  });
});

describe("buildTrendPoints", () => {
  it("includes bucket history and today events without dropping history", () => {
    const buckets: DailyBucket[] = [
      {
        day: "2026-08-27",
        totalTokens: 100,
        inputTokens: 40,
        outputTokens: 10,
        cacheWriteTokens: 0,
        cacheReadTokens: 50,
        totalCents: 50,
        requestCount: 1,
        byModel: [
          {
            model: "auto",
            inputTokens: 40,
            outputTokens: 10,
            cacheWriteTokens: 0,
            cacheReadTokens: 50,
            totalTokens: 100,
          },
        ],
      },
    ];
    const events = [ev(Date.parse("2026-08-28T10:00:00"), 10)];
    const points = buildTrendPoints(events, buckets);
    const days = [...new Set(points.map((p) => p.day))].sort();
    assert.deepEqual(days, ["2026-08-27", "2026-08-28"]);
  });
});

describe("sumUsageCostCents", () => {
  it("sums events and dailyBuckets", () => {
    const buckets: DailyBucket[] = [
      {
        day: "2026-08-27",
        totalTokens: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalCents: 200,
        requestCount: 1,
        byModel: [],
      },
    ];
    assert.equal(sumUsageCostCents([ev(1, 95)], buckets), 295);
  });
});

describe("dayStartMs / dayEndMs", () => {
  it("covers a full local calendar day", () => {
    const start = dayStartMs("2026-08-31");
    const end = dayEndMs("2026-08-31");
    assert.equal(new Date(start).getHours(), 0);
    assert.equal(new Date(start).getMinutes(), 0);
    assert.ok(end > start);
    assert.equal(end - start, 24 * 60 * 60 * 1000 - 1);
  });
});
