import { describe, expect, it } from "vitest";
import { pointIdFromChunk } from "../../src/vectorstore/point-id.ts";

const FIXTURE_IDS = Array.from({ length: 14 }, (_, index) => `p${String(index + 1).padStart(2, "0")}`);
const RSS_LIKE_IDS = ["9f2c41ab77de", "1b70de4a90c2", "5527c820cf1f"];
const CHUNK_INDEXES = [0, 1, 2, 3, 4];

describe("pointIdFromChunk", () => {
  it("returns the same id for the same (passageId, chunkIndex) in two calls — the property incremental indexing relies on", () => {
    expect(pointIdFromChunk("p03", 0)).toBe(pointIdFromChunk("p03", 0));
    expect(pointIdFromChunk("9f2c41ab77de", 2)).toBe(pointIdFromChunk("9f2c41ab77de", 2));
  });

  it("gives a different id for a different chunkIndex of the same passage", () => {
    const ids = new Set(CHUNK_INDEXES.map((chunkIndex) => pointIdFromChunk("p03", chunkIndex)));
    expect(ids.size).toBe(CHUNK_INDEXES.length);
  });

  it("gives a different id for the same chunkIndex of different passages", () => {
    const ids = new Set(FIXTURE_IDS.map((passageId) => pointIdFromChunk(passageId, 0)));
    expect(ids.size).toBe(FIXTURE_IDS.length);
  });

  it("gives 70 distinct ids for the 14 fixture ids x chunkIndex 0..4", () => {
    const ids = new Set<number>();
    for (const passageId of FIXTURE_IDS) {
      for (const chunkIndex of CHUNK_INDEXES) {
        ids.add(pointIdFromChunk(passageId, chunkIndex));
      }
    }
    expect(ids.size).toBe(FIXTURE_IDS.length * CHUNK_INDEXES.length);
  });

  it("returns an integer, not NaN, for a non-hexadecimal id (the test double's ids)", () => {
    const id = pointIdFromChunk("p03", 0);
    expect(Number.isNaN(id)).toBe(false);
    expect(Number.isInteger(id)).toBe(true);
  });

  it("returns a safe integer within [0, 2^48) for a sample of fixture and RSS-like ids", () => {
    for (const passageId of [...FIXTURE_IDS, ...RSS_LIKE_IDS]) {
      for (const chunkIndex of CHUNK_INDEXES) {
        const id = pointIdFromChunk(passageId, chunkIndex);
        expect(Number.isSafeInteger(id)).toBe(true);
        expect(id).toBeGreaterThanOrEqual(0);
        expect(id).toBeLessThan(2 ** 48);
      }
    }
  });

  it("throws on an empty passage id", () => {
    expect(() => pointIdFromChunk("", 0)).toThrow(/empty passage id/);
  });

  it("throws on an invalid chunk index", () => {
    expect(() => pointIdFromChunk("p03", -1)).toThrow(/invalid chunk index -1/);
    expect(() => pointIdFromChunk("p03", 1.5)).toThrow(/invalid chunk index 1.5/);
    expect(() => pointIdFromChunk("p03", Number.NaN)).toThrow(/invalid chunk index NaN/);
  });
});
