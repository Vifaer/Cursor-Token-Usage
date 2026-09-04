import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeCacheStats,
  computeCacheStatsFromAggs,
  computeCacheStatsFromEvents,
  formatHitRate,
  mergeCacheStats,
} from "../cacheStats";
import { ModelAgg, UsageEvent } from "../models";

describe("computeCacheStatsFromAggs", () => {
  it("returns null hitRate when no input or cache read", () => {
    const stats = computeCacheStatsFromAggs([
      { model: "m", inputTokens: 0, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 100 },
    ]);
    assert.equal(stats.hitRate, null);
    assert.equal(stats.outputTokens, 100);
  });

  it("computes hitRate as cacheRead / (input + cacheRead + cacheWrite)", () => {
    const stats = computeCacheStatsFromAggs([
      { model: "m", inputTokens: 100, outputTokens: 50, cacheWriteTokens: 20, cacheReadTokens: 300, totalTokens: 470 },
    ]);
    assert.equal(stats.hitRate, 300 / 420);
    assert.equal(formatHitRate(stats.hitRate), "71%");
    assert.equal(stats.cacheShare, (300 + 20) / 470);
  });

  it("aggregates multiple models", () => {
    const aggs: ModelAgg[] = [
      { model: "a", inputTokens: 50, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 50, totalTokens: 110 },
      { model: "b", inputTokens: 50, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 60 },
    ];
    const stats = computeCacheStatsFromAggs(aggs);
    assert.equal(stats.hitRate, 50 / 150);
  });
});

describe("computeCacheStatsFromEvents", () => {
  it("fallback from events when aggs empty", () => {
    const events: UsageEvent[] = [
      {
        timestamp: 1,
        model: "m",
        kind: "USAGE",
        inputTokens: 10,
        outputTokens: 5,
        cacheWriteTokens: 0,
        cacheReadTokens: 90,
        totalTokens: 105,
        totalCents: 0,
      },
    ];
    const stats = computeCacheStatsFromEvents(events);
    assert.equal(stats.hitRate, 90 / 100);
  });
});

describe("formatHitRate", () => {
  it("shows dash for null", () => {
    assert.equal(formatHitRate(null), "—");
  });
});

describe("mergeCacheStats / computeCacheStats", () => {
  it("patches write from events without lowering read from aggs", () => {
    const aggs: ModelAgg[] = [
      {
        model: "m",
        inputTokens: 1000,
        outputTokens: 500,
        cacheWriteTokens: 0,
        cacheReadTokens: 100_000_000,
        totalTokens: 100_001_500,
      },
    ];
    const events: UsageEvent[] = [
      {
        timestamp: 1,
        model: "m",
        kind: "USAGE",
        inputTokens: 10,
        outputTokens: 5,
        cacheWriteTokens: 50,
        cacheReadTokens: 100,
        totalTokens: 165,
        totalCents: 0,
      },
    ];
    const fromAggs = computeCacheStatsFromAggs(aggs);
    const fromEvents = computeCacheStatsFromEvents(events);
    const merged = mergeCacheStats(fromAggs, fromEvents);
    assert.equal(merged.cacheReadTokens, 100_000_000);
    assert.equal(merged.cacheWriteTokens, 50);
    assert.equal(computeCacheStats(aggs, events).cacheReadTokens, 100_000_000);
    assert.equal(computeCacheStats(aggs, events).cacheWriteTokens, 50);
  });

  it("falls back to events when aggs empty", () => {
    const events: UsageEvent[] = [
      {
        timestamp: 1,
        model: "m",
        kind: "USAGE",
        inputTokens: 10,
        outputTokens: 5,
        cacheWriteTokens: 0,
        cacheReadTokens: 90,
        totalTokens: 105,
        totalCents: 0,
      },
    ];
    const stats = computeCacheStats([], events);
    assert.equal(stats.hitRate, 90 / 100);
  });
});
