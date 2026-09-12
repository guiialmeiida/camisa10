import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.ts";
import { EMBEDDING } from "../../src/config/models.ts";
import {
  countPoints,
  deleteOrphanChunks,
  ensureCollection,
  fetchDigests,
  getClient,
  insertPoints,
  search,
} from "../../src/vectorstore/qdrant.ts";
import type { Point } from "../../src/vectorstore/types.ts";

function vector(fill: (index: number) => number): number[] {
  return Array.from({ length: EMBEDDING.dimensions }, (_, index) => fill(index));
}

function samplePoint(
  id: number,
  passageId: string,
  contentHash = "0".repeat(40),
  chunk: { chunkIndex: number; chunkCount: number } = { chunkIndex: 0, chunkCount: 1 },
  overrides: { teams?: string[]; publishedAt?: string } = {},
): Point {
  return {
    id,
    vector: vector((index) => (index === id ? 1 : 0)),
    payload: {
      passageId,
      contentHash,
      chunkIndex: chunk.chunkIndex,
      chunkCount: chunk.chunkCount,
      text: `texto ${passageId}`,
      title: `título ${passageId}`,
      source: "Fixture Esportivo",
      url: `https://exemplo.invalido/fixture/${passageId}`,
      type: "article",
      teams: overrides.teams ?? ["palmeiras"],
      matchId: "m1",
      competition: "brasileirao-serie-a",
      matchweek: 12,
      publishedAt: overrides.publishedAt ?? "2026-09-06T08:00:00-03:00",
    },
  };
}

describe("vectorstore round-trip", () => {
  // Runs against its own collection, never `QDRANT_COLLECTION` — that one is the real
  // index `npm run index` populates, and recall.test.ts / golden-rule.test.ts depend on
  // it still holding the 14 fixture passages when they run. `recreate: true` below would
  // otherwise wipe it out from under them.
  const originalCollection = process.env["QDRANT_COLLECTION"];

  beforeAll(async () => {
    process.env["QDRANT_COLLECTION"] = "camisa10-vectorstore-test";
    await ensureCollection({ recreate: true });
  });

  afterAll(async () => {
    await getClient().deleteCollection(loadEnv().QDRANT_COLLECTION);
    if (originalCollection === undefined) {
      delete process.env["QDRANT_COLLECTION"];
    } else {
      process.env["QDRANT_COLLECTION"] = originalCollection;
    }
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

  it("fetchDigests returns digests for known ids and omits ids that aren't in the collection", async () => {
    const points = [samplePoint(11, "p11", "1".repeat(40)), samplePoint(12, "p12", "2".repeat(40))];
    await insertPoints(points);

    const digests = await fetchDigests([11, 12, 999]);

    expect(digests).toHaveLength(2);
    const byPointId = new Map(digests.map((digest) => [digest.pointId, digest]));
    expect(byPointId.get(11)).toMatchObject({ passageId: "p11", contentHash: "1".repeat(40) });
    expect(byPointId.get(12)).toMatchObject({ passageId: "p12", contentHash: "2".repeat(40) });
    expect(byPointId.has(999)).toBe(false);
  });

  it("deleteOrphanChunks removes only the chunks at or past the given chunkCount, against a real server", async () => {
    // A nested should/must filter with a range condition is exactly the kind of thing
    // that passes against a mock and fails against the real thing — this proves it works
    // server-side, not just that qdrant.ts builds the right-shaped JSON.
    const passageId = "p-orphan";
    const points = [
      samplePoint(21, passageId, "0".repeat(40), { chunkIndex: 0, chunkCount: 3 }),
      samplePoint(22, passageId, "0".repeat(40), { chunkIndex: 1, chunkCount: 3 }),
      samplePoint(23, passageId, "0".repeat(40), { chunkIndex: 2, chunkCount: 3 }),
    ];
    await insertPoints(points);
    const before = await countPoints();

    const deleted = await deleteOrphanChunks([{ passageId, chunkCount: 1 }]);

    expect(deleted).toBe(2);
    expect(await countPoints()).toBe(before - 2);

    const digests = await fetchDigests([21, 22, 23]);
    const remainingIds = digests.map((digest) => digest.pointId);
    expect(remainingIds).toEqual([21]);
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

  it("current_matchweek filter (task 04): the publishedAt datetime range and the teams match both work server-side", async () => {
    // Proves the range works as a real datetime comparison on the server, over a
    // publishedAt stored with a -03:00 offset — not just that qdrant.ts builds the
    // right-shaped JSON. A filter that passes against a mock and comes back empty in
    // production is exactly the failure mode this task exists to avoid (spec §11).
    // Deliberately a different month than every other point in this file (which default
    // to 2026-09-06), so the date window below can't accidentally catch them too.
    const before = samplePoint(31, "p-window-before", "0".repeat(40), undefined, {
      publishedAt: "2026-09-20T00:00:00-03:00",
      teams: ["palmeiras"],
    });
    const insidePalmeiras = samplePoint(32, "p-window-inside-palmeiras", "0".repeat(40), undefined, {
      publishedAt: "2026-10-05T00:00:00-03:00",
      teams: ["palmeiras"],
    });
    const insideSantos = samplePoint(33, "p-window-inside-santos", "0".repeat(40), undefined, {
      publishedAt: "2026-10-06T00:00:00-03:00",
      teams: ["santos"],
    });
    const future = samplePoint(34, "p-window-future", "0".repeat(40), undefined, {
      publishedAt: "2026-10-15T00:00:00-03:00",
      teams: ["santos"],
    });
    await insertPoints([before, insidePalmeiras, insideSantos, future]);

    const dateFilter = {
      must: [{ key: "publishedAt", range: { gte: "2026-10-01T00:00:00-03:00", lte: "2026-10-10T00:00:00-03:00" } }],
    };

    const withinWindow = await search({ vector: insidePalmeiras.vector, k: 10, filter: dateFilter });
    const withinWindowIds = withinWindow.map((result) => result.payload.passageId).sort();
    expect(withinWindowIds).toEqual(["p-window-inside-palmeiras", "p-window-inside-santos"]);

    const withTeamClause = await search({
      vector: insidePalmeiras.vector,
      k: 10,
      filter: { must: [...dateFilter.must, { key: "teams", match: { value: "palmeiras" } }] },
    });
    expect(withTeamClause.map((result) => result.payload.passageId)).toEqual(["p-window-inside-palmeiras"]);
  });
});
