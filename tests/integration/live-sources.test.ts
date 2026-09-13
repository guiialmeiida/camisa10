import "dotenv/config";
import { describe, expect, it } from "vitest";
import { getFacts, listPassages } from "../../src/sources/index.ts";
import { getTeamForm } from "../../src/sources/team-form.ts";

// Live data has no ground truth to grade against — recall@k needs the fixture for that
// (recall.test.ts). This only asserts shape and invariant: the schema parses, ids
// resolve, dates carry the right offset. Skipped under LLM_CASSETTE=replay because
// there's nothing to replay here — football-data.org/api-football/RSS were never part
// of the cassette (spec §15: only the LLM and embedding calls are cached).
const shouldSkip = process.env["LLM_CASSETTE"] === "replay";

describe.skipIf(shouldSkip)("live sources: structural invariants only, no ground truth", () => {
  it(
    "getFacts returns a schema-valid matchweek with every team resolved",
    async () => {
      const facts = await getFacts({});

      expect(facts.matchweek).toBeGreaterThanOrEqual(1);
      expect(facts.matchweek).toBeLessThanOrEqual(38);
      // A real matchweek always has games. An empty list here would mean the invariant
      // loop below never ran — which is exactly how the football-data.org status-field
      // corruption bug (documented in this task's Implementação section) used to hide
      // behind a green test instead of failing loudly.
      expect(facts.matches.length).toBeGreaterThan(0);

      const teamIds = new Set(facts.teams.map((team) => team.id));
      for (const match of facts.matches) {
        expect(teamIds.has(match.homeTeam)).toBe(true);
        expect(teamIds.has(match.awayTeam)).toBe(true);
        expect(match.date.endsWith("-03:00")).toBe(true);
      }
    },
    30_000,
  );

  it(
    "listPassages returns passages with an alphanumeric id and non-empty text",
    async () => {
      const passages = await listPassages();

      expect(passages.length).toBeGreaterThan(0);
      for (const passage of passages) {
        expect(passage.id).toMatch(/^[a-zA-Z0-9]+$/);
        expect(passage.text.length).toBeGreaterThan(0);
        expect(passage.publishedAt.endsWith("-03:00")).toBe(true);
      }
    },
    30_000,
  );

  // The live check that gated task 05's schema (spec §2), now permanent: the team
  // endpoint mixes competitions, so this is what actually catches a regression in the
  // BSA/non-BSA split — no ground truth, just the structural invariants the split promises.
  it(
    "getTeamForm returns at most 5 BSA-only matches, a coherent record, and a distinct otherCompetitionMatch",
    async () => {
      const form = await getTeamForm("palmeiras");

      expect(form.matches.length).toBeLessThanOrEqual(5);
      for (const match of form.matches) {
        expect(match.date.endsWith("-03:00")).toBe(true);
        expect(match.competition.code).toBe("BSA");

        const teamGoals = match.side === "home" ? match.score.home : match.score.away;
        const opponentGoals = match.side === "home" ? match.score.away : match.score.home;
        const expectedResult = teamGoals > opponentGoals ? "win" : teamGoals < opponentGoals ? "loss" : "draw";
        expect(match.result).toBe(expectedResult);
      }

      // Most recent first.
      const timestamps = form.matches.map((match) => Date.parse(match.date));
      expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));

      expect(form.record.wins + form.record.draws + form.record.losses).toBe(form.matches.length);

      if (form.otherCompetitionMatch !== null) {
        expect(form.otherCompetitionMatch.competition.code).not.toBe("BSA");
        expect(form.matches.some((match) => match.id === form.otherCompetitionMatch?.id)).toBe(false);
      }
    },
    30_000,
  );
});
