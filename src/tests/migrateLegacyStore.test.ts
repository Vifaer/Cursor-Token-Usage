import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergePersistedSnapshots, parseLegacyAccounts } from "../migrateLegacyPure";

describe("parseLegacyAccounts", () => {
  it("reads akitogo-shaped blob", () => {
    const raw = JSON.stringify({
      "cursorTokenUsage.accounts.v1": {
        user_01AAAAAAAAAAAAAAAAAAAAAA: {
          userId: "user_01AAAAAAAAAAAAAAAAAAAAAA",
          accountLabel: "a@x.com",
          membershipType: "free",
          billingCycleStart: "",
          billingCycleEnd: "",
          isUnlimited: false,
          displayMode: "pools",
          cursorModelsPercent: 10,
          otherModelsPercent: 0,
          totalPercent: 5,
          overallUsedCents: null,
          overallLimitCents: null,
          onDemandEnabled: false,
          onDemandUsedCents: null,
          onDemandLimitCents: null,
          requestUsed: null,
          requestMax: null,
          planName: "",
          aggregations: [],
          events: [{ timestamp: 1, model: "m", kind: "USAGE", totalTokens: 9, inputTokens: 4, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0, totalCents: 0 }],
          eventsComplete: true,
          totalTokens: 9,
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      },
    });
    const parsed = parseLegacyAccounts(raw);
    assert.equal(Object.keys(parsed).length, 1);
    assert.equal(parsed.user_01AAAAAAAAAAAAAAAAAAAAAA.accountLabel, "a@x.com");
    assert.equal(parsed.user_01AAAAAAAAAAAAAAAAAAAAAA.events.length, 1);
  });
});

describe("mergePersistedSnapshots", () => {
  it("keeps newer summary and unions events", () => {
    const older = {
      userId: "user_01AAAAAAAAAAAAAAAAAAAAAA",
      membershipType: "free",
      billingCycleStart: "",
      billingCycleEnd: "",
      isUnlimited: false,
      displayMode: "pools" as const,
      cursorModelsPercent: 1,
      otherModelsPercent: 0,
      totalPercent: 1,
      overallUsedCents: null,
      overallLimitCents: null,
      onDemandEnabled: false,
      onDemandUsedCents: null,
      onDemandLimitCents: null,
      requestUsed: null,
      requestMax: null,
      planName: "",
      aggregations: [],
      events: [
        { timestamp: 1, model: "m", kind: "USAGE", totalTokens: 1, inputTokens: 1, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalCents: 0 },
      ],
      eventsComplete: true,
      totalTokens: 100,
      accountLabel: "old@x.com",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const newer = {
      ...older,
      accountLabel: "new@x.com",
      totalTokens: 50,
      events: [
        { timestamp: 2, model: "m", kind: "USAGE", totalTokens: 2, inputTokens: 2, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalCents: 0 },
      ],
      updatedAt: "2026-08-02T00:00:00.000Z",
    };
    const merged = mergePersistedSnapshots(older, newer);
    assert.equal(merged.accountLabel, "new@x.com");
    assert.equal(merged.totalTokens, 100);
    assert.equal(merged.events.length, 2);
  });
});
