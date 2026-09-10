import "dotenv/config";
import { describe, expect, it } from "vitest";
import { getFacts, listPassages } from "../../src/sources/index.ts";

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
});
