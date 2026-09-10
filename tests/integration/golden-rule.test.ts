import "dotenv/config";
import { describe, expect, it } from "vitest";
import { answer } from "../../src/agent/graph.ts";
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
      const date = new Date(match.date);
      allowed.add(date.getDate());
      allowed.add(date.getMonth() + 1);
      if (match.status !== "scheduled") {
        allowed.add(match.score.home);
        allowed.add(match.score.away);
      }
    }
  }

  // Strip [pNN] citations first — those digits belong to a passage id, not a fact.
  const textWithoutCitations = state.answer.text.replace(/\[[a-zA-Z0-9]+\]/g, "");
  const numbers = [...textWithoutCitations.matchAll(/\d+/g)].map((match) => Number(match[0]));

  return numbers.filter((n) => !allowed.has(n));
}

describe("golden rule: no number leaks from the vector index", () => {
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
      }
    },
    120_000,
  );
});
