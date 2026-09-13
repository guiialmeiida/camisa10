import { describe, expect, it, vi } from "vitest";
import {
  CANDIDATE_POOL_FACTOR,
  TIME_DECAY_HALF_LIFE_DAYS,
  isDecayedResult,
  rankByTimeDecay,
  timeDecayWeight,
} from "../../src/retrieval/time-decay.ts";
import type { PassagePayload } from "../../src/vectorstore/types.ts";
import type { SearchResult } from "../../src/vectorstore/types.ts";

function samplePayload(overrides: Partial<PassagePayload> = {}): PassagePayload {
  return {
    passageId: "p01",
    contentHash: "0".repeat(40),
    chunkIndex: 0,
    chunkCount: 1,
    text: "texto de exemplo",
    title: "título de exemplo",
    source: "Fixture Esportivo",
    url: "https://exemplo.invalido/fixture/p01",
    type: "article",
    teams: ["palmeiras"],
    matchId: null,
    competition: "brasileirao-serie-a",
    matchweek: 12,
    publishedAt: "2026-09-06T08:00:00-03:00",
    ...overrides,
  };
}

function result(id: number, score: number, publishedAt: string, passageId = `p${id}`): SearchResult {
  return { id, score, payload: samplePayload({ passageId, publishedAt }) };
}

describe("timeDecayWeight", () => {
  it("matches the discovery formula exactly: half-life 14 days -> 0.5, 28 days -> 0.25, 0 days -> 1, 7 days -> 0.5 ** 0.5", () => {
    const now = new Date("2026-09-12T12:00:00.000Z");

    expect(timeDecayWeight(new Date(now.getTime() - 14 * 86_400_000).toISOString(), { now })).toBeCloseTo(0.5, 6);
    expect(timeDecayWeight(new Date(now.getTime() - 28 * 86_400_000).toISOString(), { now })).toBeCloseTo(0.25, 6);
    expect(timeDecayWeight(now.toISOString(), { now })).toBeCloseTo(1, 6);
    expect(timeDecayWeight(new Date(now.getTime() - 7 * 86_400_000).toISOString(), { now })).toBeCloseTo(
      0.5 ** 0.5,
      6,
    );
  });

  it("a custom halfLifeDays changes the result accordingly", () => {
    const now = new Date("2026-09-12T12:00:00.000Z");
    const publishedAt = new Date(now.getTime() - 7 * 86_400_000).toISOString();

    expect(timeDecayWeight(publishedAt, { now, halfLifeDays: 7 })).toBeCloseTo(0.5, 6);
  });

  it("a publishedAt in the future is clamped to weight 1, never above", () => {
    const now = new Date("2026-09-12T12:00:00.000Z");
    const future = new Date(now.getTime() + 10 * 86_400_000).toISOString();

    expect(timeDecayWeight(future, { now })).toBe(1);
  });

  it("an unparseable publishedAt returns weight 1 and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(timeDecayWeight("not a date", { now: new Date() })).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a date"));

    warn.mockRestore();
  });

  it("halfLifeDays <= 0 throws — a programming error, not bad data", () => {
    expect(() => timeDecayWeight(new Date().toISOString(), { halfLifeDays: 0 })).toThrow();
    expect(() => timeDecayWeight(new Date().toISOString(), { halfLifeDays: -1 })).toThrow();
  });

  it("locks the discovery constants", () => {
    expect(TIME_DECAY_HALF_LIFE_DAYS).toBe(14);
    expect(CANDIDATE_POOL_FACTOR).toBe(4);
  });
});

describe("rankByTimeDecay", () => {
  const now = new Date("2026-09-12T12:00:00-03:00");

  // The spec §7 literal example: p02 is the most similar of the pool but old enough
  // (almost 4 half-lives) that decay drops it out of a k=2 cut.
  function specPool(): SearchResult[] {
    return [
      result(11, 0.62, "2026-09-10T08:00:00-03:00", "p01"),
      result(12, 0.71, "2026-08-15T20:00:00-03:00", "p02"),
      result(13, 0.48, "2026-09-12T09:00:00-03:00", "p03"),
    ];
  }

  it("the central case: reranks the pool by similarity x decay and drops the most-similar-but-stale result", () => {
    const ranked = rankByTimeDecay(specPool(), 2, { now });

    expect(ranked.map((r) => r.payload.passageId)).toEqual(["p01", "p03"]);
    expect(ranked[0]?.similarity).toBeCloseTo(0.62, 6);
    expect(ranked[0]?.timeDecay).toBeCloseTo(0.8982806084303977, 6);
    expect(ranked[0]?.score).toBeCloseTo(0.5569, 3);
    expect(ranked[1]?.similarity).toBeCloseTo(0.48, 6);
    expect(ranked[1]?.timeDecay).toBeCloseTo(0.9938302971522361, 6);
    expect(ranked[1]?.score).toBeCloseTo(0.477, 3);
  });

  it("does not mutate the input array or its objects", () => {
    const pool = specPool();
    const snapshot = pool.map((r) => ({ ...r }));

    rankByTimeDecay(pool, 2, { now });

    expect(pool).toEqual(snapshot);
    expect(pool.map((r) => r.payload.passageId)).toEqual(["p01", "p02", "p03"]);
  });

  it("a tie in the product preserves input order (stable sort)", () => {
    const pool = [result(1, 0.5, now.toISOString(), "tie-a"), result(2, 0.5, now.toISOString(), "tie-b")];

    const ranked = rankByTimeDecay(pool, 2, { now });

    expect(ranked.map((r) => r.payload.passageId)).toEqual(["tie-a", "tie-b"]);
  });

  it("a pool smaller than k returns everything it has", () => {
    const pool = [result(1, 0.5, now.toISOString(), "only")];

    expect(rankByTimeDecay(pool, 5, { now })).toHaveLength(1);
  });

  it("k <= 0 throws", () => {
    expect(() => rankByTimeDecay(specPool(), 0, { now })).toThrow();
    expect(() => rankByTimeDecay(specPool(), -1, { now })).toThrow();
  });
});

describe("isDecayedResult", () => {
  it("is false for a plain SearchResult and true for a DecayedResult", () => {
    const plain = result(1, 0.5, "2026-09-06T08:00:00-03:00");
    const [decayed] = rankByTimeDecay([plain], 1, { now: new Date("2026-09-12T12:00:00-03:00") });

    expect(isDecayedResult(plain)).toBe(false);
    expect(decayed && isDecayedResult(decayed)).toBe(true);
  });
});
