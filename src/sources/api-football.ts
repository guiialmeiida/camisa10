import { z } from "zod";
import { loadEnv } from "../config/env.ts";
import { fetchJson } from "./http.ts";
import { resolveTeamId } from "./teams.ts";
import type { Match, Score } from "./types.ts";

const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const BSA_LEAGUE_ID = 71; // discovery item 3, confirmed live

export interface LiveMatch {
  homeTeam: string; // team id (slug), already resolved
  awayTeam: string;
  score: Score;
  minute: number | null;
}

const apiFootballFixtureSchema = z.object({
  fixture: z.object({
    id: z.number().int(),
    status: z.object({
      long: z.string(),
      short: z.string(),
      elapsed: z.number().int().nullable(),
    }),
  }),
  league: z.object({ id: z.number().int() }),
  teams: z.object({
    home: z.object({ id: z.number().int(), name: z.string() }),
    away: z.object({ id: z.number().int(), name: z.string() }),
  }),
  goals: z.object({ home: z.number().int().nullable(), away: z.number().int().nullable() }),
});

const apiFootballResponseSchema = z.object({
  // api-sports.io sends `[]` on success and an object on failure (e.g. { token: "..." }).
  errors: z.union([z.array(z.string()), z.record(z.string(), z.string())]),
  // Each element gets validated individually, after the league filter below — not with
  // apiFootballFixtureSchema here. /fixtures?live=all returns every live match in the
  // world; validating the strict per-fixture shape at this level means a format quirk
  // in some other league we don't even read would fail the whole batch and drop BSA's
  // enrichment along with it.
  response: z.array(z.unknown()),
});

/**
 * `[]` when the key is missing, the API fails, or there's no live match. Never throws:
 * this is an enrichment source, so if it falls over the answer still carries
 * football-data.org's score, which is the primary source — letting this one throw would
 * invert the hierarchy the discovery decided on.
 *
 * A missing key isn't warned about here — facts.ts is the only real caller, and it
 * already decides whether to call this function based on the key's presence, so a
 * warning here would either never fire (facts.ts already skipped the call) or duplicate
 * the one facts.ts prints when it matters (there's actually a live match to enrich).
 */
export async function fetchLiveMatches(): Promise<LiveMatch[]> {
  const { API_FOOTBALL_KEY } = loadEnv();
  if (!API_FOOTBALL_KEY) return [];

  let raw: unknown;
  try {
    // League filter is applied client-side (see BSA_LEAGUE_ID below): combining `live`
    // and `league` in the query string was never confirmed against the free plan, and
    // this is the call the discovery confirmed working.
    raw = await fetchJson(`${API_FOOTBALL_BASE}/fixtures?live=all`, {
      headers: { "x-apisports-key": API_FOOTBALL_KEY },
      timeoutMs: 10_000,
    });
  } catch (error) {
    console.warn(`api-football.ts: request failed — ${describeError(error)}`);
    return [];
  }

  const parsed = apiFootballResponseSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`api-football.ts: response failed validation:\n${z.prettifyError(parsed.error)}`);
    return [];
  }

  const hasErrors = Array.isArray(parsed.data.errors)
    ? parsed.data.errors.length > 0
    : Object.keys(parsed.data.errors).length > 0;
  if (hasErrors) {
    console.warn(`api-football.ts: API reported errors: ${JSON.stringify(parsed.data.errors)}`);
    return [];
  }

  const liveMatches: LiveMatch[] = [];

  for (const rawFixture of parsed.data.response) {
    // Cheap, defensive pre-filter before the strict schema below — league is the only
    // field we need to read speculatively, since it decides whether we even care.
    const leagueId = (rawFixture as { league?: { id?: unknown } } | null)?.league?.id;
    if (leagueId !== BSA_LEAGUE_ID) continue;

    const fixtureParsed = apiFootballFixtureSchema.safeParse(rawFixture);
    if (!fixtureParsed.success) {
      console.warn(
        `api-football.ts: a fixture in league ${BSA_LEAGUE_ID} failed validation, skipped:\n${z.prettifyError(fixtureParsed.error)}`,
      );
      continue;
    }
    const fixture = fixtureParsed.data;

    const homeTeam = await resolveTeamId(fixture.teams.home.name);
    const awayTeam = await resolveTeamId(fixture.teams.away.name);
    if (!homeTeam || !awayTeam) {
      console.warn(
        `api-football.ts: could not resolve team names "${fixture.teams.home.name}" / "${fixture.teams.away.name}" — enrichment skipped for fixture ${fixture.fixture.id}`,
      );
      continue;
    }

    const { home, away } = fixture.goals;
    if (home === null || away === null) {
      console.warn(`api-football.ts: fixture ${fixture.fixture.id} has no goal count — skipped`);
      continue;
    }

    liveMatches.push({
      homeTeam,
      awayTeam,
      score: { home, away },
      minute: fixture.fixture.status.elapsed,
    });
  }

  return liveMatches;
}

/**
 * Pure. Overwrites score/minute of the `live` matches that match by team pair — never by
 * kickoff time, since several Brasileirão matches routinely start at the same minute.
 */
export function applyLiveScores(matches: Match[], live: LiveMatch[]): Match[] {
  return matches.map((match) => {
    if (match.status !== "live") return match;

    const found = live.find((l) => l.homeTeam === match.homeTeam && l.awayTeam === match.awayTeam);
    if (!found) {
      console.warn(
        `api-football.ts: no live-score match for ${match.homeTeam} x ${match.awayTeam} (id ${match.id}) — keeping football-data.org's score`,
      );
      return match;
    }

    return { ...match, score: found.score, minute: found.minute };
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
