import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatCompactNumber } from "../formatNumber";

describe("formatCompactNumber", () => {
  it("uses 亿 for large Chinese values instead of 万 overflow", () => {
    assert.equal(formatCompactNumber(108_583_000, true), "1.1亿");
    assert.equal(formatCompactNumber(500_000_000, true), "5亿");
  });

  it("uses 万 for mid-range Chinese values", () => {
    assert.equal(formatCompactNumber(50_000, true), "5万");
    assert.equal(formatCompactNumber(9_999, true), "9999");
  });

  it("uses K/M/B for English values", () => {
    assert.equal(formatCompactNumber(1_500, false), "1.5K");
    assert.equal(formatCompactNumber(2_500_000, false), "2.5M");
    assert.equal(formatCompactNumber(1_200_000_000, false), "1.2B");
  });
});
