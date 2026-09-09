import "dotenv/config";
import { beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.ts";
import { EMBEDDING } from "../../src/config/models.ts";
import { countPoints, ensureCollection, getClient, insertPoints, search } from "../../src/vectorstore/qdrant.ts";
import type { Point } from "../../src/vectorstore/types.ts";

function vector(fill: (index: number) => number): number[] {
  return Array.from({ length: EMBEDDING.dimensions }, (_, index) => fill(index));
}

function samplePoint(id: number, passageId: string): Point {
  return {
    id,
    vector: vector((index) => (index === id ? 1 : 0)),
    payload: {
      passageId,
      text: `texto ${passageId}`,
      title: `título ${passageId}`,
      source: "Fixture Esportivo",
      url: `https://exemplo.invalido/fixture/${passageId}`,
      type: "article",
      teams: ["palmeiras"],
      matchId: "m1",
      competition: "brasileirao-serie-a",
      matchweek: 12,
      publishedAt: "2026-09-06T08:00:00-03:00",
    },
  };
}

describe("vectorstore round-trip", () => {
  beforeAll(async () => {
    await ensureCollection({ recreate: true });
  });

  it("ensureCollection + insertPoints + search does the full cycle", async () => {
    const points = [samplePoint(1, "p01"), samplePoint(2, "p02")];
    const inserted = await insertPoints(points);
    expect(inserted).toBe(2);

    const firstPoint = points[0];
    if (!firstPoint) throw new Error("invalid test setup");

    const results = await search({ vector: firstPoint.vector, k: 2 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.payload.passageId).toBe("p01");
    expect(await countPoints()).toBeGreaterThanOrEqual(2);
  });

  it("rejects a vector with the wrong dimension — confirms the dimension is really locked", async () => {
    const badPoint: Point = { ...samplePoint(3, "p03"), vector: [0.1, 0.2, 0.3] };

    await expect(insertPoints([badPoint])).rejects.toThrow();
  });

  it("throws on search when a stored payload doesn't match the schema", async () => {
    const collection = loadEnv().QDRANT_COLLECTION;
    const invalidVector = vector(() => 0.01);

    // Bypasses insertPoints' type safety on purpose, to prove search() validates the
    // boundary itself rather than assuming insertPoints always wrote a good payload.
    await getClient().upsert(collection, {
      wait: true,
      points: [{ id: 999, vector: invalidVector, payload: { passageId: "p-invalid" } }],
    });

    await expect(search({ vector: invalidVector, k: 1 })).rejects.toThrow();
  });
});
