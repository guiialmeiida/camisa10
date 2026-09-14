import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Task 01 moved sources off the fixture, so `npm run index` now indexes real news —
// the evaluation can't depend on whatever happens to be in the shared collection
// anymore. This mocks src/sources/index.ts back to the fixture double, just for this
// file, and indexes it into its own collection below (spec §12, decision 2).
vi.mock("../../src/sources/index.ts", async () => {
  const fixtureSource = await import("../fixtures/fixture-source.ts");
  return {
    getFacts: fixtureSource.getFacts,
    listPassages: fixtureSource.listPassages,
    listTeams: fixtureSource.listTeams,
    COMPETITION: fixtureSource.COMPETITION,
  };
});

// Identity classifier — see recall.test.ts for why: preserves the fixture's curated
// PassageType per passage and skips 14 real LLM calls (and cassette entries) per run.
vi.mock("../../src/ingestion/classify.ts", () => ({
  classifyPassageTypes: (passages: { id: string; type: string }[]) =>
    Promise.resolve(passages.map((passage) => ({ passageId: passage.id, type: passage.type, fallback: false }))),
}));

const { answer } = await import("../../src/agent/graph.ts");
const { indexPassages } = await import("../../src/ingestion/indexer.ts");
// Task 06 promotes this task's own check to production code — see docs/tasks/06 §12,
// item 5: the unit level (tests/agent/critic.test.ts) and this integration level now
// exercise the same function instead of a copy that could quietly drift from it.
const { allowedNumbers, findOrphanNumbers } = await import("../../src/agent/nodes/critic.ts");
import type { FinalState } from "../../src/agent/state.ts";

// Every spelling of the trap chronicle's (p07) wrong score — must never reach the answer.
// Both digit orders: the writer sometimes phrases a result as "loser 0 x 2 winner" and
// sometimes as "winner 2 x 0 loser" — either spelling leaks the same wrong number.
const WRONG_SCORE_PATTERNS = [
  /\b2\s*x\s*0\b/i,
  /\b0\s*x\s*2\b/i,
  /\b2\s*a\s*0\b/i,
  /\b0\s*a\s*2\b/i,
  /\b2-0\b/,
  /\b0-2\b/,
  /dois a zero/i,
  /zero a dois/i,
  /dois gols a zero/i,
];

function orphanNumbersIn(state: FinalState): number[] {
  return findOrphanNumbers(state.answer.text, allowedNumbers(state));
}

describe("golden rule: no number leaks from the vector index", () => {
  const originalCollection = process.env["QDRANT_COLLECTION"];

  beforeAll(async () => {
    process.env["QDRANT_COLLECTION"] = "camisa10-eval";
    // recreate: true — same reasoning as recall.test.ts (spec §14, decision 2).
    await indexPassages({ recreate: true });
    // Default hook timeout (5-10s) can be too tight for embedAll + ensureCollection +
    // insertPoints over the fixture's 14 passages, depending on Voyage's latency.
  }, 30_000);

  afterAll(() => {
    if (originalCollection === undefined) {
      delete process.env["QDRANT_COLLECTION"];
    } else {
      process.env["QDRANT_COLLECTION"] = originalCollection;
    }
  });

  it(
    "never lets the trap chronicle's wrong score reach the answer, across 3 runs",
    async () => {
      for (let run = 1; run <= 3; run += 1) {
        const state = await answer({ question: "quanto foi Palmeiras x Fluminense na rodada 12?" });

        const trapWasRetrieved = state.context.some((result) => result.payload.passageId === "p07");
        if (!trapWasRetrieved) {
          throw new Error(
            `invalid setup on run ${run}: passage p07 (the trap) was not retrieved — this run proves nothing`,
          );
        }

        // The real API score (Palmeiras 1 x Fluminense 3) must appear, in some spelling —
        // including the reversed digit order a fluent narration of an away win commonly
        // uses ("Fluminense venceu o Palmeiras por 3 a 1"): same score, same fact, written
        // winner-first instead of home-first. Both describe the one correct result.
        expect(state.answer.text).toMatch(/\b1\s*(x|a|-)\s*3\b|\b3\s*(x|a|-)\s*1\b/);

        for (const pattern of WRONG_SCORE_PATTERNS) {
          expect(state.answer.text).not.toMatch(pattern);
        }

        expect(orphanNumbersIn(state)).toEqual([]);

        // Voyage's free tier (3 requests/min without a payment method on file) counts
        // indexPassages()'s own embedding call in beforeAll plus each run's query
        // embedding within the same rolling minute — four calls comfortably exceed it.
        // Without this pause, the 4th call (run 3's search) gets rate-limited; because
        // runFanOut uses Promise.allSettled (spec §6), that surfaces as a silent,
        // misleading `context: []` — "invalid setup" — rather than a clear 429 error.
        // Skipped only in replay: replay hits no real rate limit. `record` still makes
        // real Voyage calls within this same process, so it needs the pause too — the
        // guard used to be `=== undefined` (skipping it in record), which is exactly the
        // same class of bug task 03's review fixed in ingestion-incremental.test.ts: it
        // let `LLM_CASSETTE=record` runs skip the pause and hit the 429 it exists to avoid.
        if (run < 3 && process.env["LLM_CASSETTE"] !== "replay") {
          await new Promise((resolve) => setTimeout(resolve, 20_000));
        }
      }
    },
    180_000,
  );
});
