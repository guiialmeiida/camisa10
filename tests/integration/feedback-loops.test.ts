import "dotenv/config";
import { describe, expect, it } from "vitest";
import { allowedNumbers, critique, findOrphanNumbers } from "../../src/agent/nodes/critic.ts";
import { getFacts } from "../fixtures/fixture-source.ts";
import type { FinalState } from "../../src/agent/state.ts";

// Proof of loop 2 end to end (docs/tasks/06-feedback-loops.md §15/§16), without waiting
// for the writer to accidentally hallucinate a number on its own — a working writer
// never does that, which is the whole point of task 06. This builds a FinalState by
// hand around the fixture's real facts and a hand-poisoned answer, and runs critique()
// against the real Anthropic API — the one claude-opus-5 call this test makes is cached
// by LLM_CASSETTE (support/llm-cassette.ts, wired in vitest.integration.config.ts), the
// same as every other integration test that talks to Anthropic.
describe("feedback loop 2: the critic catches and fixes an orphan number", () => {
  it(
    "flags the poisoned score, has the model rewrite it, and leaves no orphan number in the final answer",
    async () => {
      const facts = await getFacts({ matchweek: 12 });
      const realMatch = facts.matches[0];
      if (!realMatch || realMatch.score === null) {
        throw new Error("invalid fixture setup: expected matches[0] to have a real score to poison");
      }

      const state: FinalState = {
        question: "quanto foi Palmeiras x Fluminense na rodada 12?",
        k: 5,
        trace: [],
        entity: { team: "palmeiras", competition: facts.competition.id, matchweek: facts.matchweek, confidence: "high" },
        plan: {
          mode: "current_matchweek",
          tools: ["fetch_facts_api"],
          searchQuery: "Palmeiras x Fluminense rodada 12",
          rationale: "pergunta pede o placar de um jogo específico",
        },
        facts,
        context: [],
        recentForm: null,
        // The fixture's real score (facts.matches[0]) is 1 x 3 — this claims 2 x 0, a
        // number ("2") with no backing anywhere in facts.
        answer: {
          text: "O Palmeiras venceu por 2 x 0 sobre o Fluminense na rodada 12.",
          citedPassages: [],
          lowConfidence: false,
        },
      };

      const allowed = allowedNumbers(state);
      const orphansBefore = findOrphanNumbers(state.answer.text, allowed);
      expect(orphansBefore).toEqual([2]);

      const { state: fixed, report } = await critique(state);

      expect(report.orphanNumbers).toEqual([2]);
      expect(report.rewritten).toBe(true);

      // The invariant that matters, regardless of whether the model's own rewrite came
      // out clean or the deterministic redaction (spec §9) had to step in at the
      // ceiling: no orphan number survives into the answer the user sees.
      const orphansAfter = findOrphanNumbers(fixed.answer.text, allowedNumbers(fixed));
      expect(orphansAfter).toEqual([]);
    },
    60_000,
  );
});
