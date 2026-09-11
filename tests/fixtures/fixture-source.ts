import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { fixtureSchema } from "./fixture-schema.ts";
import type { Fixture, Passage, Team } from "./fixture-schema.ts";
import type { Facts, FactsFilter } from "../../src/sources/types.ts";

// Task 01 moved this whole test double out of src/sources/ — the golden-rule trap
// (p07) only exists here now, not in production. See docs/tasks/01-data-sources.md §12.
const FIXTURE_PATH = path.join(import.meta.dirname, "brasileirao-2026-matchweek-12.json");

// Mirrors the fixture JSON's `competition.id`/`name` — kept as a sync constant so this
// test double's COMPETITION export has the same shape (no Promise) as the real
// src/sources/competition.ts, which extract-entity.ts imports directly.
export const COMPETITION = { id: "brasileirao-serie-a", name: "Brasileirão Série A" };

let cachedFixture: Fixture | undefined;

async function loadFixture(): Promise<Fixture> {
  if (cachedFixture) return cachedFixture;

  const raw = await readFile(FIXTURE_PATH, "utf-8");
  const parsed = fixtureSchema.safeParse(JSON.parse(raw));

  if (!parsed.success) {
    throw new Error(`invalid fixture at ${FIXTURE_PATH}:\n${z.prettifyError(parsed.error)}`);
  }

  cachedFixture = parsed.data;
  return cachedFixture;
}

/**
 * team: team id (e.g. "palmeiras"). Without `team`, returns the whole matchweek.
 * Without `matchweek`, uses the fixture's current matchweek.
 * A filter with no match returns `matches: []` — absence of data is not an error.
 */
export async function getFacts(filter?: FactsFilter): Promise<Facts> {
  const fixture = await loadFixture();
  const matchweek = filter?.matchweek ?? fixture.matchweek;
  const competitionMismatch =
    filter?.competition !== undefined && filter.competition !== fixture.competition.id;

  const matches = competitionMismatch
    ? []
    : fixture.matches.filter((match) => {
        if (match.matchweek !== matchweek) return false;
        if (filter?.team && match.homeTeam !== filter.team && match.awayTeam !== filter.team) {
          return false;
        }
        return true;
      });

  return {
    competition: fixture.competition,
    matchweek,
    matches,
    teams: fixture.teams,
    source: "fixture",
  };
}

/** Narrative text, for ingestion only — never called at question time. */
export async function listPassages(): Promise<Passage[]> {
  const fixture = await loadFixture();
  return fixture.passages;
}

/** Same surface as src/sources/teams.ts' listTeams() — the fixture's teams are already
 * `{ id, name, nicknames }`, nothing else to strip. */
export async function listTeams(): Promise<Team[]> {
  const fixture = await loadFixture();
  return fixture.teams;
}
