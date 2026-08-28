import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  groupModelAggs,
  isAutoModelIntent,
  modelFamilyKey,
  modelVariantMode,
  resolveEventSlugs,
} from "../modelNormalize";
import { ModelAgg, UsageEvent } from "../models";

function agg(model: string, total: number): ModelAgg {
  return { model, inputTokens: total, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: total };
}

function event(model: string): UsageEvent {
  return {
    model,
    kind: "USAGE",
    timestamp: 1,
    totalTokens: 10,
    inputTokens: 5,
    outputTokens: 5,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalCents: 0,
  };
}

describe("modelFamilyKey", () => {
  it("keeps auto/default separate", () => {
    assert.equal(modelFamilyKey("Default"), "__auto__");
    assert.equal(modelFamilyKey("auto"), "__auto__");
    assert.ok(isAutoModelIntent("Default"));
  });

  it("groups composer fast and standard variants", () => {
    assert.equal(modelFamilyKey("composer-2.5-fast"), "composer-2.5");
    assert.equal(modelFamilyKey("Composer 2.5 Fast"), "composer-2.5");
    assert.equal(modelFamilyKey("composer-2.5"), "composer-2.5");
    assert.equal(modelFamilyKey("Composer 2.5"), "composer-2.5");
  });
});

describe("modelVariantMode", () => {
  it("detects fast and high-fast modes from raw ids", () => {
    assert.equal(modelVariantMode("Composer 2.5 Fast"), "fast");
    assert.equal(modelVariantMode("composer-2.5"), "standard");
    assert.equal(modelVariantMode("claude-4-6-opus-high-fast"), "high-fast");
    assert.equal(modelVariantMode("claude-4-6-opus-high"), "high");
  });
});

describe("resolveEventSlugs", () => {
  it("maps intent labels to event slugs by family and mode", () => {
    const events = [event("composer-2.5-fast"), event("composer-2.5")];
    assert.deepEqual(resolveEventSlugs("Composer 2.5 Fast", events), ["composer-2.5-fast"]);
    assert.deepEqual(resolveEventSlugs("Composer 2.5", events), ["composer-2.5"]);
  });
});

describe("groupModelAggs", () => {
  it("merges composer variants into one group", () => {
    const groups = groupModelAggs([
      agg("Default", 1000),
      agg("Composer 2.5 Fast", 50),
      agg("Composer 2.5", 20),
    ]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].familyKey, "__auto__");
    assert.equal(groups[0].totalTokens, 1000);
    const composer = groups.find((g) => g.familyKey === "composer-2.5");
    assert.ok(composer);
    assert.equal(composer!.totalTokens, 70);
    assert.equal(composer!.variants.length, 2);
  });

  it("fills filterSlugs from events not intent labels", () => {
    const events = [event("composer-2.5-fast"), event("composer-2.5")];
    const groups = groupModelAggs([agg("Composer 2.5 Fast", 50), agg("Composer 2.5", 20)], events);
    const composer = groups.find((g) => g.familyKey === "composer-2.5");
    assert.ok(composer);
    assert.equal(composer!.filterSlugs, "composer-2.5-fast|composer-2.5");
    assert.equal(composer!.variantFilterSlugs["Composer 2.5 Fast"], "composer-2.5-fast");
  });
});
