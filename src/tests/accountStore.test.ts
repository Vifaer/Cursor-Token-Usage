import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPerAccountRow,
  lastActivityMs,
  mergeCombinedEvents,
  shouldRefreshSecondary,
  sortCombinedAccountRows,
  sumEventCostCents,
} from "../combinedView";
import { CombinedAccountRow, DailyBucket, UsageEvent, UsageSnapshot } from "../models";
import { dayEndMs } from "../trendData";

function row(partial: Partial<CombinedAccountRow> & { userId: string }): CombinedAccountRow {
  return {
    label: partial.userId,
    membershipType: "pro",
    totalTokens: 0,
    cursorModelsPercent: null,
    otherModelsPercent: null,
    overallUsedCents: null,
    overallLimitCents: null,
    requestUsed: null,
    requestMax: null,
    cacheHitRate: null,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    isStale: false,
    isCurrent: false,
    updatedAt: new Date().toISOString(),
    lastActivityAt: null,
    ...partial,
  };
}

function snapshot(userId: string, events: UsageEvent[], dailyBuckets?: DailyBucket[]): UsageSnapshot {
  return {
    timestamp: new Date(),
    userId,
    membershipType: "pro",
    billingCycleStart: "",
    billingCycleEnd: "",
    isUnlimited: false,
    displayMode: "overall",
    cursorModelsPercent: null,
    otherModelsPercent: null,
    totalPercent: null,
    overallUsedCents: null,
    overallLimitCents: null,
    onDemandEnabled: false,
    onDemandUsedCents: null,
    onDemandLimitCents: null,
    aggregations: [],
    events,
    eventsComplete: true,
    totalTokens: 0,
    dailyBuckets,
  };
}

function ev(ts: number, model = "m"): UsageEvent {
  return {
    model,
    kind: "USAGE",
    timestamp: ts,
    totalTokens: 10,
    inputTokens: 5,
    outputTokens: 5,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalCents: 0,
  };
}

describe("sortCombinedAccountRows", () => {
  it("pins current first then lastActivityAt desc", () => {
    const sorted = sortCombinedAccountRows(
      [
        row({ userId: "a", lastActivityAt: "2026-01-03T00:00:00.000Z" }),
        row({ userId: "b", lastActivityAt: "2026-01-01T00:00:00.000Z", isCurrent: true }),
        row({ userId: "c", lastActivityAt: "2026-01-02T00:00:00.000Z" }),
        row({ userId: "d", lastActivityAt: null }),
      ],
      { by: "activity" },
    );
    assert.deepEqual(
      sorted.map((r) => r.userId),
      ["b", "a", "c", "d"],
    );
  });

  it("token sort keeps current first then tokens", () => {
    const sorted = sortCombinedAccountRows(
      [
        row({ userId: "fresh0", totalTokens: 0, isCurrent: true }),
        row({ userId: "big", totalTokens: 9_000_000 }),
        row({ userId: "mid", totalTokens: 100 }),
      ],
      { by: "tokens" },
    );
    assert.deepEqual(
      sorted.map((r) => r.userId),
      ["fresh0", "big", "mid"],
    );
  });

  it("ties break by userId", () => {
    const sorted = sortCombinedAccountRows(
      [
        row({ userId: "z", lastActivityAt: "2026-01-01T00:00:00.000Z" }),
        row({ userId: "a", lastActivityAt: "2026-01-01T00:00:00.000Z" }),
      ],
      { by: "activity" },
    );
    assert.deepEqual(
      sorted.map((r) => r.userId),
      ["a", "z"],
    );
  });
});

describe("lastActivityMs", () => {
  it("returns null when empty", () => {
    assert.equal(lastActivityMs({ events: [] }), null);
  });

  it("uses max event timestamp", () => {
    assert.equal(lastActivityMs({ events: [ev(1_700_000_000_000), ev(1_700_000_005_000)] }), 1_700_000_005_000);
  });

  it("uses local day-end for buckets", () => {
    const end = dayEndMs("2026-01-15");
    const ms = lastActivityMs({
      events: [],
      dailyBuckets: [
        {
          day: "2026-01-15",
          totalTokens: 10,
          inputTokens: 10,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          totalCents: 0,
          requestCount: 1,
          byModel: [],
        },
      ],
    });
    assert.equal(ms, end);
  });

  it("prefers later of events vs bucket day-end", () => {
    const end = dayEndMs("2026-01-10");
    const laterEvent = end + 86_400_000;
    assert.equal(
      lastActivityMs({
        events: [ev(laterEvent)],
        dailyBuckets: [
          {
            day: "2026-01-10",
            totalTokens: 1,
            inputTokens: 1,
            outputTokens: 0,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            totalCents: 0,
            requestCount: 1,
            byModel: [],
          },
        ],
      }),
      laterEvent,
    );
  });
});

describe("buildPerAccountRow", () => {
  it("sets isCurrent and lastActivityAt from full account", () => {
    const account = snapshot("u1", [ev(1_700_000_000_000)]);
    const rowBuilt = buildPerAccountRow(
      account,
      { totalTokens: 99, cacheHitRate: 0.5, cacheReadTokens: 1, cacheWriteTokens: 0 },
      { currentUserId: "u1", staleMs: 90_000 },
    );
    assert.equal(rowBuilt.isCurrent, true);
    assert.equal(rowBuilt.totalTokens, 99);
    assert.ok(rowBuilt.lastActivityAt);
    assert.equal(Date.parse(rowBuilt.lastActivityAt!), 1_700_000_000_000);
  });

  it("lastActivity ignores metrics-only slice tokens", () => {
    const account = snapshot("u2", [ev(1_700_000_000_000)]);
    const rowBuilt = buildPerAccountRow(
      account,
      { totalTokens: 0, cacheHitRate: null, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { currentUserId: "other", staleMs: 90_000 },
    );
    assert.equal(rowBuilt.isCurrent, false);
    assert.equal(rowBuilt.totalTokens, 0);
    assert.ok(rowBuilt.lastActivityAt);
  });
});

describe("shouldRefreshSecondary", () => {
  const staleMs = 90_000;
  it("refreshes when no snapshot", () => {
    assert.equal(shouldRefreshSecondary(null, Date.now(), staleMs), true);
  });
  it("skips when fresh", () => {
    const now = Date.now();
    assert.equal(shouldRefreshSecondary(new Date(now - 1000).toISOString(), now, staleMs), false);
  });
  it("refreshes when at threshold", () => {
    const now = Date.now();
    assert.equal(shouldRefreshSecondary(new Date(now - staleMs).toISOString(), now, staleMs), true);
  });
});

describe("mergeCombinedEvents", () => {
  it("dedupes by userId|timestamp|model|kind", () => {
    const merged = mergeCombinedEvents([snapshot("u1", [ev(1)]), snapshot("u2", [ev(1)])]);
    assert.equal(merged.length, 2);
  });

  it("keeps same timestamp across different users", () => {
    const merged = mergeCombinedEvents([
      snapshot("u1", [ev(100, "gpt")]),
      snapshot("u2", [ev(100, "gpt")]),
    ]);
    assert.equal(merged.length, 2);
  });
});

describe("sumEventCostCents", () => {
  it("sums totalCents across all account events", () => {
    const cost = sumEventCostCents([
      snapshot("u1", [{ ...ev(1), totalCents: 100 }]),
      snapshot("u2", [{ ...ev(2), totalCents: 250 }]),
    ]);
    assert.equal(cost, 350);
  });
});
