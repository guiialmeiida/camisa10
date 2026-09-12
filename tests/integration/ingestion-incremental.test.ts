import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as embedModule from "../../src/ingestion/embed.ts";

// This is the test that proves the task: a passage source that only changes one item
// between runs must only pay for that one item's embedding and write, and running the
// pipeline twice in a row with nothing changed must cost nothing at all.
const state = vi.hoisted(() => ({
  overridePassageId: "p03",
  overrideText: undefined as string | undefined,
}));

vi.mock("../../src/sources/index.ts", async () => {
  const fixtureSource = await import("../fixtures/fixture-source.ts");
  return {
    getFacts: fixtureSource.getFacts,
    listTeams: fixtureSource.listTeams,
    COMPETITION: fixtureSource.COMPETITION,
    listPassages: async () => {
      const passages = await fixtureSource.listPassages();
      if (state.overrideText === undefined) return passages;
      return passages.map((passage) =>
        passage.id === state.overridePassageId ? { ...passage, text: state.overrideText as string } : passage,
      );
    },
  };
});

// Identity classifier — same reasoning as recall.test.ts / golden-rule.test.ts: this
// file measures the diff/convergence behavior of indexPassages, not the classifier, so
// mocking it avoids spending LLM calls and introducing model variance here.
vi.mock("../../src/ingestion/classify.ts", () => ({
  classifyPassageTypes: (passages: { id: string; type: string }[]) =>
    Promise.resolve(passages.map((passage) => ({ passageId: passage.id, type: passage.type, fallback: false }))),
}));

const { indexPassages } = await import("../../src/ingestion/indexer.ts");
const { countPoints, getClient, search } = await import("../../src/vectorstore/qdrant.ts");

// Real Voyage embedding calls (classify.ts is mocked, embedAll isn't) were never part of
// the LLM_CASSETTE recording — same reasoning as live-sources.test.ts: there's nothing to
// replay here, so this file only makes sense against the real network.
const shouldSkip = process.env["LLM_CASSETTE"] === "replay";

describe.skipIf(shouldSkip)("ingestion pipeline converges instead of rebuilding", () => {
  const originalCollection = process.env["QDRANT_COLLECTION"];
  const embedSpy = vi.spyOn(embedModule, "embedAll");

  beforeAll(() => {
    process.env["QDRANT_COLLECTION"] = "camisa10-ingestion-test";
  });

  afterAll(async () => {
    await getClient().deleteCollection("camisa10-ingestion-test");
    if (originalCollection === undefined) {
      delete process.env["QDRANT_COLLECTION"];
    } else {
      process.env["QDRANT_COLLECTION"] = originalCollection;
    }
  });

  it(
    "recreate, then a no-op run, then a run with one changed passage, then one that grows to 3 chunks, then shrinks back",
    async () => {
      // 1. First run: recreate — every fixture passage is new.
      const first = await indexPassages({ recreate: true });
      expect(first.points).toBe(14);
      expect(await countPoints()).toBe(14);

      // 2. Second run: nothing changed — unchanged: 14, points: 0, no embedding call.
      embedSpy.mockClear();
      const second = await indexPassages();
      expect(second.unchanged).toBe(14);
      expect(second.newPassages).toBe(0);
      expect(second.changed).toBe(0);
      expect(second.points).toBe(0);
      expect(await countPoints()).toBe(14);
      expect(embedSpy).not.toHaveBeenCalled();

      // 3. Third run: one passage's text changed in the double — changed: 1, points: 1,
      // the collection still has 14 points (updated in place, not duplicated), and the
      // point's stored text is the new one.
      //
      // Operational note: step 1's recreate already spent one embedding call. Observed
      // against the real free-tier limit, two embedAll calls back-to-back (zero gap) trip
      // the 429 far more often than the same two calls spaced out — golden-rule.test.ts's
      // own 20s-apart calls never do. So this step gets the same pause as steps 4 and 5,
      // even though the spec only calls it out for those two.
      //
      // The guard is `!== "replay"`, matching `shouldSkip` above — not `=== undefined`.
      // This file's real Voyage calls were never recorded into LLM_CASSETTE (like
      // live-sources.test.ts), so LLM_CASSETTE=record still runs this file for real; an
      // `=== undefined` guard would skip the pause in that mode and hit the exact 429
      // this pause exists to avoid.
      if (process.env["LLM_CASSETTE"] !== "replay") {
        await new Promise((resolve) => setTimeout(resolve, 21_000));
      }
      embedSpy.mockClear();
      const newText = "Texto totalmente reescrito para provar que o point foi atualizado, não duplicado.";
      state.overrideText = newText;

      const third = await indexPassages();

      expect(third.changed).toBe(1);
      expect(third.newPassages).toBe(0);
      expect(third.points).toBe(1);
      expect(await countPoints()).toBe(14);
      expect(embedSpy).toHaveBeenCalledTimes(1);

      const changedVector = await embedSpy.mock.results[0]?.value;
      expect(changedVector).toBeDefined();
      const results = await search({ vector: changedVector[0], k: 1 });
      expect(results[0]?.payload.passageId).toBe(state.overridePassageId);
      expect(results[0]?.payload.text).toBe(newText);

      // Voyage's free tier is 3 requests/minute without a payment method on file —
      // steps 1-3 above already spent one embedding call each within the last rolling
      // minute (recreate, no-op has none, one changed passage). Space out before the
      // next real call, same pattern as golden-rule.test.ts.
      if (process.env["LLM_CASSETTE"] !== "replay") {
        await new Promise((resolve) => setTimeout(resolve, 21_000));
      }

      // 4. Fourth run: the same passage grows to a long enough text to produce 3 chunks
      // — changed: 1, points: 3, no orphan yet (this passage never had more chunks than
      // this), and the collection gains 2 points (14 -> 16). A search against the vector
      // of one of the new chunks returns a point reporting chunkCount: 3.
      embedSpy.mockClear();
      const longText = Array.from(
        { length: 20 },
        (_, index) => `Parágrafo número ${index} sobre a reformulação total do elenco e da comissão técnica do time.`,
      ).join(" ");
      state.overrideText = longText;

      const fourth = await indexPassages();

      expect(fourth.changed).toBe(1);
      expect(fourth.points).toBe(3);
      expect(fourth.orphanPointsDeleted).toBe(0);
      expect(await countPoints()).toBe(16);
      expect(embedSpy).toHaveBeenCalledTimes(1);

      const longVectors = await embedSpy.mock.results[0]?.value;
      expect(longVectors).toHaveLength(3);
      const longResults = await search({ vector: longVectors[0], k: 1 });
      expect(longResults[0]?.payload.passageId).toBe(state.overridePassageId);
      expect(longResults[0]?.payload.chunkCount).toBe(3);

      if (process.env["LLM_CASSETTE"] !== "replay") {
        await new Promise((resolve) => setTimeout(resolve, 21_000));
      }

      // 5. Fifth run: the passage goes back to a short (1-chunk) text — changed: 1,
      // points: 1, and the 2 leftover chunks from step 4 are swept: orphanPointsDeleted:
      // 2, and the collection shrinks back to 14. This is the proof the orphan sweep
      // works — the consequence the discovery flagged as unresolved.
      embedSpy.mockClear();
      state.overrideText = newText;

      const fifth = await indexPassages();

      expect(fifth.changed).toBe(1);
      expect(fifth.points).toBe(1);
      expect(fifth.orphanPointsDeleted).toBe(2);
      expect(await countPoints()).toBe(14);
    },
    240_000,
  );
});
