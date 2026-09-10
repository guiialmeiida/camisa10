import { z } from "zod";
import { loadEnv } from "../config/env.ts";
import { HttpStatusError, HttpTimeoutError, fetchJson } from "./http.ts";
import { teamIdFromFootballData } from "./teams.ts";
import { toSaoPauloIso } from "./time.ts";
import type { Match, MatchStatus } from "./types.ts";

const FOOTBALL_DATA_BASE = "https://api.football-data.org/v4";
const COMPETITION_CODE = "BSA"; // Brasileirão Série A (discovery item 2)

export interface CompetitionInfo {
  name: string;
  season: number; // year of currentSeason.startDate
  currentMatchday: number;
}

const fdScoreSchema = z.object({
  fullTime: z.object({
    home: z.number().int().nullable(),
    away: z.number().int().nullable(),
  }),
});

const fdTeamSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  shortName: z.string().nullish(),
  tla: z.string().nullish(),
});

const fdMatchSchema = z.object({
  id: z.number().int(),
  utcDate: z.string(),
  status: z.string(),
  matchday: z.number().int(),
  venue: z.string().nullish(),
  // Spec §6's technical note (docs/tasks/01-data-sources.md): the approved spec required
  // `season` here, but the sample payload right below it in the same spec doesn't include the
  // field, and mapMatches never reads it (only fetchCompetition needs season/currentMatchday,
  // from /v4/competitions/BSA, not from /matches). This task had no FOOTBALL_DATA_TOKEN
  // available to confirm the field against a live /matches response (see this task's
  // "Implementação" section), so it's made optional here instead of required — a required
  // field the real endpoint doesn't send would break the very first live call.
  season: z
    .object({ startDate: z.string(), currentMatchday: z.number().int().nullable() })
    .optional(),
  homeTeam: fdTeamSchema,
  awayTeam: fdTeamSchema,
  score: fdScoreSchema,
});

export const footballDataMatchesSchema = z.object({
  competition: z.object({ id: z.number().int(), name: z.string(), code: z.string() }),
  matches: z.array(fdMatchSchema),
});

export const footballDataCompetitionSchema = z.object({
  name: z.string(),
  code: z.string(),
  currentSeason: z.object({ startDate: z.string(), currentMatchday: z.number().int().nullable() }),
});

// The only allowed translation from football-data.org's status strings — see spec §6's table.
const STATUS_MAP: Record<string, MatchStatus> = {
  FINISHED: "finished",
  AWARDED: "finished",
  IN_PLAY: "live",
  PAUSED: "live",
  SCHEDULED: "scheduled",
  TIMED: "scheduled",
  POSTPONED: "postponed",
  SUSPENDED: "postponed",
  CANCELLED: "postponed",
};

async function request(path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`${FOOTBALL_DATA_BASE}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }

  try {
    return await fetchJson(url.toString(), {
      headers: { "X-Auth-Token": loadEnv().FOOTBALL_DATA_TOKEN },
      timeoutMs: 10_000,
    });
  } catch (error) {
    if (error instanceof HttpTimeoutError) {
      throw new Error(`football-data.org timed out after ${error.timeoutMs}ms`);
    }
    if (error instanceof HttpStatusError) {
      if (error.status === 429) {
        const reset = error.headers.get("x-requestcounter-reset");
        throw new Error(
          `football-data.org rate limit reached (10 req/min); retry in ${reset ?? "unknown"}s`,
        );
      }
      if (error.status === 403) {
        throw new Error("football-data.org rejected the token (403) — check FOOTBALL_DATA_TOKEN");
      }
      throw new Error(`football-data.org request failed: ${error.status} ${error.method} ${error.path}`);
    }
    throw error;
  }
}

/** GET /v4/competitions/BSA — name, season and the current matchday. */
export async function fetchCompetition(): Promise<CompetitionInfo> {
  const raw = await request(`/competitions/${COMPETITION_CODE}`);
  const parsed = footballDataCompetitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `football-data.org competition response failed validation:\n${z.prettifyError(parsed.error)}`,
    );
  }

  const { name, currentSeason } = parsed.data;
  if (currentSeason.currentMatchday === null) {
    throw new Error("football-data.org did not report a current matchday for BSA");
  }

  return {
    name,
    season: seasonYear(currentSeason.startDate),
    currentMatchday: currentSeason.currentMatchday,
  };
}

/** GET /v4/competitions/BSA/matches?matchday=N — the raw, unvalidated response body. */
export async function fetchMatchweek(matchweek: number): Promise<unknown> {
  return request(`/competitions/${COMPETITION_CODE}/matches`, { matchday: String(matchweek) });
}

/**
 * Validates the raw response and maps it to `Match[]`. Testable against a recorded payload,
 * no network: this is the "resposta validada -> Match[]" boundary the spec describes — it does
 * its own `zod` parsing (so a test can hand it `JSON.parse(fixture)` directly) and then only
 * pure transformation.
 */
export async function mapMatches(raw: unknown): Promise<Match[]> {
  const parsed = footballDataMatchesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `football-data.org matches response failed validation:\n${z.prettifyError(parsed.error)}`,
    );
  }

  const matches: Match[] = [];

  for (const fdMatch of parsed.data.matches) {
    const status = STATUS_MAP[fdMatch.status];
    if (!status) {
      console.warn(
        `football-data.ts: unknown match status "${fdMatch.status}" for match ${fdMatch.id} — dropped`,
      );
      continue;
    }

    const base = {
      id: String(fdMatch.id),
      matchweek: fdMatch.matchday,
      date: toSaoPauloIso(fdMatch.utcDate),
      homeTeam: await teamIdFromFootballData(fdMatch.homeTeam.id, fdMatch.homeTeam.name),
      awayTeam: await teamIdFromFootballData(fdMatch.awayTeam.id, fdMatch.awayTeam.name),
      venue: fdMatch.venue ?? null,
    };

    if (status === "scheduled" || status === "postponed") {
      matches.push({ ...base, status, score: null });
      continue;
    }

    const { home, away } = fdMatch.score.fullTime;
    if (home === null || away === null) {
      // Never fabricate a score — a made-up 0x0 is exactly the kind of unbacked number
      // the golden rule exists to keep out, and the worst place for one to be born is
      // inside the facts source itself.
      console.warn(
        `football-data.ts: match ${fdMatch.id} is ${status} but has no final score — dropped`,
      );
      continue;
    }

    matches.push(
      status === "live"
        ? { ...base, status, score: { home, away }, minute: null }
        : { ...base, status, score: { home, away } },
    );
  }

  return matches;
}

function seasonYear(startDate: string): number {
  const year = Number.parseInt(startDate.slice(0, 4), 10);
  if (Number.isNaN(year)) {
    throw new Error(`could not parse season year from startDate: ${startDate}`);
  }
  return year;
}
