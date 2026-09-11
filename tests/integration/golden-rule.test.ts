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
const { isoDateParts } = await import("../../src/generation/match-format.ts");
import type { FinalState } from "../../src/agent/state.ts";

// Every spelling of the trap chronicle's (p07) wrong score — must never reach the answer.
const WRONG_SCORE_PATTERNS = [
  /\b2\s*x\s*0\b/i,
  /\b2\s*a\s*0\b/i,
  /\b2-0\b/,
  /dois a zero/i,
  /dois gols a zero/i,
];

function findOrphanNumbers(state: FinalState): number[] {
  const allowed = new Set<number>();

  if (state.facts) {
    allowed.add(state.facts.matchweek);
    allowed.add(state.facts.competition.season);
    for (const match of state.facts.matches) {
      // Reads the day/month straight off the ISO string's digits, like match-format.ts
      // does in production — new Date(...).getDate() depends on the host's timezone,
      // which is exactly the bug task 00's review fixed in the code under test. This
      // test would silently carry that same bug back in if it used Date getters here.
      const { day, month } = isoDateParts(match.date);
      allowed.add(day);
      allowed.add(month);
      if (match.status === "finished" || match.status === "live") {
        allowed.add(match.score.home);
        allowed.add(match.score.away);
        if (match.status === "live" && match.minute !== null) {
          allowed.add(match.minute);
        }
      }
    }
  }

  // Strip [pNN] citations first — those digits belong to a passage id, not a fact.
  const textWithoutCitations = state.answer.text.replace(/\[[a-zA-Z0-9]+\]/g, "");
  const numbers = [...textWithoutCitations.matchAll(/\d+/g)].map((match) => Number(match[0]));

  return numbers.filter((n) => !allowed.has(n));
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

        // The real API score (1 x 3) must appear, in some spelling.
        expect(state.answer.text).toMatch(/\b1\s*(x|a|-)\s*3\b/);

        for (const pattern of WRONG_SCORE_PATTERNS) {
          expect(state.answer.text).not.toMatch(pattern);
        }

        expect(findOrphanNumbers(state)).toEqual([]);

        // Voyage's free tier (3 requests/min without a payment method on file) counts
        // indexPassages()'s own embedding call in beforeAll plus each run's query
        // embedding within the same rolling minute — four calls comfortably exceed it.
        // Without this pause, the 4th call (run 3's search) gets rate-limited; because
        // runFanOut uses Promise.allSettled (spec §6), that surfaces as a silent,
        // misleading `context: []` — "invalid setup" — rather than a clear 429 error.
        // Skipped under LLM_CASSETTE: replay hits no real rate limit, and record already
        // spaces its own real calls out across separate runs of this suite.
        if (run < 3 && process.env["LLM_CASSETTE"] === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 20_000));
        }
      }
    },
    180_000,
  );
});
