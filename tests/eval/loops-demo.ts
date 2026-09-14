import "dotenv/config";
import { allowedNumbers, critique, findOrphanNumbers } from "../../src/agent/nodes/critic.ts";
import { getFacts } from "../../src/sources/index.ts";
import { teamName } from "../../src/generation/match-format.ts";
import type { FinalState } from "../../src/agent/state.ts";
import type { Facts, Match } from "../../src/sources/index.ts";

// Manual demonstration of loop 2 (docs/tasks/06-feedback-loops.md §16) — the one thing
// `npm run ask` cannot show on demand, because a working writer never invents a number
// on its own (that's the whole point of the golden rule). This builds a FinalState by
// hand around real facts and a hand-poisoned answer, then runs `critique()` for real —
// exactly the production function, not a copy — so what prints below is the actual
// mechanism, not a simulation of it.
//
//   npm run demo:loops
//
// Costs one claude-opus-5 (effort medium) call per scenario, two total.

function pickScoredMatch(facts: Facts): Match | undefined {
  return facts.matches.find((match) => match.status === "finished" || match.status === "live");
}

function buildFinalState(question: string, facts: Facts, answerText: string): FinalState {
  return {
    question,
    k: 5,
    trace: [],
    entity: { team: null, competition: facts.competition.id, matchweek: facts.matchweek, confidence: "high" },
    plan: {
      mode: "current_matchweek",
      tools: ["fetch_facts_api"],
      searchQuery: question,
      rationale: "demonstração do loop 2 — não passa pelo planner de verdade",
    },
    facts,
    context: [],
    recentForm: null,
    answer: { text: answerText, citedPassages: [], lowConfidence: false },
  };
}

function printOutcome(label: string, allowed: Set<number>, before: string, orphansBefore: number[]): void {
  console.log(`\n=== ${label} ===`);
  console.log(`allowed numbers: ${[...allowed].sort((a, b) => a - b).join(", ")}`);
  console.log(`answer before:   "${before}"`);
  console.log(`orphan numbers found by the deterministic check: ${orphansBefore.join(", ") || "none"}`);
}

/**
 * Scenario 1: an answer with one invented number (a "streak" the writer would have had
 * to derive itself — exactly what src/generation/writer.ts's system prompt now forbids,
 * spec §10) next to an otherwise correct, API-backed score. The expected, common case:
 * the model's rewrite drops the invented number and keeps the rest.
 */
async function runCleanRewriteScenario(facts: Facts): Promise<void> {
  const match = pickScoredMatch(facts);
  const before = match
    ? `O ${teamName(match.homeTeam, facts.teams)} recebeu o ${teamName(match.awayTeam, facts.teams)} e venceu por ${match.score?.home} x ${match.score?.away}, e vinha de uma sequência de 4 vitórias seguidas.`
    : `Na rodada ${facts.matchweek}, o time vinha de uma sequência de 4 vitórias seguidas.`;

  const state = buildFinalState("como o time chegou a este jogo?", facts, before);
  const allowed = allowedNumbers(state);
  const orphansBefore = findOrphanNumbers(state.answer.text, allowed);
  printOutcome("cenário 1: número derivado ao lado de um placar real", allowed, before, orphansBefore);

  const { state: fixed, report } = await critique(state);

  console.log(`answer after:    "${fixed.answer.text}"`);
  console.log(`rewritten: ${report.rewritten}   remaining orphan numbers: ${report.remainingOrphanNumbers.join(", ") || "none"}`);
  if (report.redactedSentences.length > 0) {
    console.log(`removed at the ceiling: ${report.redactedSentences.map((s) => `"${s.trim()}"`).join(", ")}`);
    console.log(`lowConfidence: ${fixed.answer.lowConfidence}`);
  } else {
    console.log("the rewrite came out clean — no deterministic redaction was needed.");
  }
}

/**
 * Scenario 2: an answer built entirely around a fabricated statistic with no basis in
 * `facts` at all — deliberately adversarial, so a rewrite has nothing true to fall back
 * on. Whether this particular run reaches the deterministic-redaction ceiling or the
 * model manages to generalize the claim away cleanly is not something a real API call
 * can be forced to guarantee either way (same caveat as the `npm run ask` demonstration
 * of loop 1, spec §16) — what's guaranteed, and what this prints either way, is that
 * `findOrphanNumbers` never leaves an orphan number in the final answer.
 */
async function runHardToSaveScenario(facts: Facts): Promise<void> {
  const before =
    "O time balançou as redes 47 vezes nesta temporada, uma marca que ninguém tinha alcançado nos últimos " +
    "91 anos de história do clube. A torcida lotou o estádio para acompanhar o jogo.";

  const state = buildFinalState("o time está numa fase excepcional?", facts, before);
  const allowed = allowedNumbers(state);
  const orphansBefore = findOrphanNumbers(state.answer.text, allowed);
  printOutcome("cenário 2: estatística inventada, sem lastro nenhum em facts", allowed, before, orphansBefore);

  const { state: fixed, report } = await critique(state);

  console.log(`answer after:    "${fixed.answer.text}"`);
  console.log(`rewritten: ${report.rewritten}   remaining orphan numbers: ${report.remainingOrphanNumbers.join(", ") || "none"}`);
  if (report.redactedSentences.length > 0) {
    console.log(`removed at the ceiling: ${report.redactedSentences.map((s) => `"${s.trim()}"`).join(", ")}`);
    console.log(`lowConfidence: ${fixed.answer.lowConfidence}`);
  } else {
    console.log(
      "in this run, the model's rewrite generalized the claim away cleanly — no ceiling reached this time.",
    );
  }

  const remainingAfterFix = findOrphanNumbers(fixed.answer.text, allowedNumbers(fixed));
  console.log(`invariant check — orphan numbers in the final answer: ${remainingAfterFix.length === 0 ? "none" : remainingAfterFix.join(", ")}`);
}

async function main(): Promise<void> {
  const facts = await getFacts({});

  await runCleanRewriteScenario(facts);
  await runHardToSaveScenario(facts);
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
