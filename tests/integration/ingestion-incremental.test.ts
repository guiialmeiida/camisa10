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
    "recreate, then a no-op run, then a run with one changed passage",
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
    },
    60_000,
  );
});
