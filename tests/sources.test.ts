import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getFacts } from "../src/sources/index.ts";
import { fixtureSchema, passageSchema } from "../src/sources/fixture-schema.ts";

const FIXTURE_PATH = path.join(
  import.meta.dirname,
  "..",
  "src/sources/fixtures/brasileirao-2026-matchweek-12.json",
);

async function loadRawFixture(): Promise<unknown> {
  const raw = await readFile(FIXTURE_PATH, "utf-8");
  return JSON.parse(raw);
}

const validPassage = {
  id: "p99",
  matchId: "m1",
  teams: ["palmeiras"],
  type: "article",
  title: "teste",
  source: "teste",
  url: "https://exemplo.invalido/fixture/p99",
  publishedAt: "2026-09-06T08:00:00-03:00",
  text: "texto de teste",
};

describe("fixture schema", () => {
  it("parses the fixture file, referential integrity included", async () => {
    const raw = await loadRawFixture();
    const result = fixtureSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it("rejects a passage carrying a score field — the schema-level golden rule", () => {
    const result = passageSchema.safeParse({ ...validPassage, score: { home: 2, away: 0 } });

    expect(result.success).toBe(false);
  });
});

describe("getFacts", () => {
  it("returns every match of the current matchweek without a filter", async () => {
    const facts = await getFacts({});

    expect(facts.matchweek).toBe(12);
    expect(facts.matches).toHaveLength(3);
  });

  it("filters by team", async () => {
    const facts = await getFacts({ team: "palmeiras" });

    expect(facts.matches).toHaveLength(1);
    expect(facts.matches[0]?.id).toBe("m1");
  });

  it("returns an empty match list instead of throwing for an unknown team", async () => {
    const facts = await getFacts({ team: "santos" });

    expect(facts.matches).toEqual([]);
  });
});
