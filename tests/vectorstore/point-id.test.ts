import { describe, expect, it } from "vitest";
import { pointIdFromPassageId } from "../../src/vectorstore/point-id.ts";

const FIXTURE_IDS = Array.from({ length: 14 }, (_, index) => `p${String(index + 1).padStart(2, "0")}`);
const RSS_LIKE_IDS = ["9f2c41ab77de", "1b70de4a90c2", "5527c820cf1f"];

describe("pointIdFromPassageId", () => {
  it("returns the same id for the same input in two calls — the property incremental indexing relies on", () => {
    expect(pointIdFromPassageId("p03")).toBe(pointIdFromPassageId("p03"));
    expect(pointIdFromPassageId("9f2c41ab77de")).toBe(pointIdFromPassageId("9f2c41ab77de"));
  });

  it("returns an integer, not NaN, for a non-hexadecimal id (the test double's ids)", () => {
    const id = pointIdFromPassageId("p03");
    expect(Number.isNaN(id)).toBe(false);
    expect(Number.isInteger(id)).toBe(true);
  });

  it("returns a safe integer within [0, 2^48) for a sample of fixture and RSS-like ids", () => {
    for (const passageId of [...FIXTURE_IDS, ...RSS_LIKE_IDS]) {
      const id = pointIdFromPassageId(passageId);
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(2 ** 48);
    }
  });

  it("gives different ids for different ids, across the 14 fixture ids", () => {
    const ids = new Set(FIXTURE_IDS.map((passageId) => pointIdFromPassageId(passageId)));
    expect(ids.size).toBe(FIXTURE_IDS.length);
  });

  it("throws on an empty string", () => {
    expect(() => pointIdFromPassageId("")).toThrow(/empty passage id/);
  });
});
