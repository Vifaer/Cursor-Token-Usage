import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compactEvents } from "../dailyBuckets";
import { accountLabelFor, identityToLabel, UsageEvent } from "../models";
import { mergeEvents } from "../mergeEvents";

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

describe("mergeEvents", () => {
  it("dedupes by timestamp|model|kind", () => {
    const a = [ev({ timestamp: 1, totalTokens: 1 })];
    const b = [ev({ timestamp: 1, totalTokens: 99 }), ev({ timestamp: 2, totalTokens: 2 })];
    const merged = mergeEvents(a, b);
    assert.equal(merged.length, 2);
    assert.equal(merged.find((e) => e.timestamp === 1)?.totalTokens, 1);
  });
});

describe("accountLabelFor", () => {
  it("prefers email/label over bare userId", () => {
    assert.equal(accountLabelFor("user_aaaaaaaaaaaaaaaaaaaa", "a@b.com"), "a@b.com");
    assert.ok(accountLabelFor("user_aaaaaaaaaaaaaaaaaaaa").endsWith("…"));
  });
  it("identityToLabel prefers email then displayName", () => {
    assert.equal(identityToLabel({ userId: "u", email: "x@y.com", displayName: "Bob" }, "u"), "x@y.com");
    assert.equal(identityToLabel({ userId: "u", displayName: "Bob" }, "u"), "Bob");
  });
});

describe("compactEvents", () => {
  it("moves yesterday events into dailyBuckets and keeps today", () => {
    const now = Date.now();
    const yesterday = now - 36 * 60 * 60 * 1000;
    const result = compactEvents(
      [ev({ timestamp: yesterday, totalTokens: 50 }), ev({ timestamp: now, totalTokens: 7 })],
      [],
    );
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].totalTokens, 7);
    assert.ok(result.dailyBuckets.length >= 1);
    assert.equal(result.dailyBuckets.reduce((s, b) => s + b.totalTokens, 0), 50);
  });
});

describe("hydrate ?? semantics", () => {
  it("0 is kept with nullish coalescing", () => {
    const fresh: number | undefined = 0;
    const missing: number | undefined = undefined;
    const stored = 999;
    assert.equal(fresh ?? stored, 0);
    assert.equal(missing ?? stored, 999);
  });
});
