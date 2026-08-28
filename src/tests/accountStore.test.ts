import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeCombinedEvents, sortCombinedAccountRows, sumEventCostCents } from "../combinedView";
import { CombinedAccountRow, UsageEvent, UsageSnapshot } from "../models";

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
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

function snapshot(userId: string, events: UsageEvent[]): UsageSnapshot {
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
  it("sorts by updatedAt desc with stale rows last", () => {
    const sorted = sortCombinedAccountRows(
      [
        row({ userId: "a", updatedAt: "2026-01-01T00:00:00.000Z", isStale: true }),
        row({ userId: "b", updatedAt: "2026-01-03T00:00:00.000Z" }),
        row({ userId: "c", updatedAt: "2026-01-02T00:00:00.000Z" }),
      ],
      { by: "updated" },
    );
    assert.deepEqual(sorted.map((r) => r.userId), ["b", "c", "a"]);
  });
});

describe("mergeCombinedEvents", () => {
  it("dedupes by userId|timestamp|model|kind", () => {
    const merged = mergeCombinedEvents([
      snapshot("u1", [ev(1)]),
      snapshot("u2", [ev(1)]),
    ]);
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
