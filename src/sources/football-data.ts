import { z } from "zod";
import { loadEnv } from "../config/env.ts";
import { HttpStatusError, HttpTimeoutError, fetchJson } from "./http.ts";
import { teamIdFromFootballData } from "./teams.ts";
import { toSaoPauloIso } from "./time.ts";
import type { Match, MatchStatus, Team } from "./types.ts";

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
  // `season` made optional per the approved spec's technical note — confirmed against a
  // live /matches response that the field isn't always present, and mapMatches doesn't
  // read it anyway (only fetchCompetition needs season/currentMatchday, from a different
  // endpoint). See this task's Implementação section for the full history.
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

// Spec §8: "the only cache here is the process's own memory for fetchCompetition, which
// dies with the CLI." No TTL — a single process answers one question (or one test run)
// and exits, so there's no staleness window to manage.
let cachedCompetitionInfo: CompetitionInfo | undefined;

/** GET /v4/competitions/BSA — name, season and the current matchday. */
export async function fetchCompetition(): Promise<CompetitionInfo> {
  if (cachedCompetitionInfo) return cachedCompetitionInfo;

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

  cachedCompetitionInfo = {
    name,
    season: seasonYear(currentSeason.startDate),
    currentMatchday: currentSeason.currentMatchday,
  };
  return cachedCompetitionInfo;
}

/** Test-only: clears the process-lifetime cache so each test starts from a clean fetch. */
export function resetCompetitionCacheForTests(): void {
  cachedCompetitionInfo = undefined;
}

/** GET /v4/competitions/BSA/matches?matchday=N — the raw, unvalidated response body. */
export async function fetchMatchweek(matchweek: number): Promise<unknown> {
  return request(`/competitions/${COMPETITION_CODE}/matches`, { matchday: String(matchweek) });
}

export interface MappedMatches {
  matches: Match[];
  // A team the curated teams.json doesn't know about degrades to a synthetic slug
  // (teams.ts) instead of dropping the match — but the spec is explicit that the
  // synthetic entry still belongs in Facts.teams, or its display name never reaches the
  // user (writer/trace fall back to printing the raw slug, e.g. "cr-vasco-da-gama").
  syntheticTeams: Team[];
}

/**
 * Validates the raw response and maps it to `Match[]`. Testable against a recorded payload,
 * no network: this is the "resposta validada -> Match[]" boundary the spec describes — it does
 * its own `zod` parsing (so a test can hand it `JSON.parse(fixture)` directly) and then only
 * pure transformation.
 */
export async function mapMatches(raw: unknown): Promise<MappedMatches> {
  const parsed = footballDataMatchesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `football-data.org matches response failed validation:\n${z.prettifyError(parsed.error)}`,
    );
  }

  const matches: Match[] = [];
  const syntheticTeams = new Map<string, Team>();

  for (const fdMatch of parsed.data.matches) {
    const status = STATUS_MAP[fdMatch.status];
    if (!status) {
      console.warn(
        `football-data.ts: unknown match status "${fdMatch.status}" for match ${fdMatch.id} — dropped`,
      );
      continue;
    }

    const home = await resolveTeam(fdMatch.homeTeam.id, fdMatch.homeTeam.name);
    const away = await resolveTeam(fdMatch.awayTeam.id, fdMatch.awayTeam.name);
    if (home.team) syntheticTeams.set(home.team.id, home.team);
    if (away.team) syntheticTeams.set(away.team.id, away.team);

    const base = {
      id: String(fdMatch.id),
      matchweek: fdMatch.matchday,
      date: toSaoPauloIso(fdMatch.utcDate),
      homeTeam: home.id,
      awayTeam: away.id,
      venue: fdMatch.venue ?? null,
    };

    if (status === "scheduled" || status === "postponed") {
      matches.push({ ...base, status, score: null });
      continue;
    }

    const { home: homeGoals, away: awayGoals } = fdMatch.score.fullTime;
    if (homeGoals === null || awayGoals === null) {
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
        ? { ...base, status, score: { home: homeGoals, away: awayGoals }, minute: null }
        : { ...base, status, score: { home: homeGoals, away: awayGoals } },
    );
  }

  // A response with matches where every single one fails to map isn't the same thing as
  // an empty matchweek: it's a sign the response itself is corrupted (confirmed live —
  // football-data.org's free tier intermittently returns a timestamp in the `status`
  // field instead of the enum; see this task's Implementação section). Swallowing that
  // as matches: [] would make getFacts say "no games this round", which is false — the
  // "the source didn't answer" case belongs in the exception path (spec §13), same as
  // any other primary-source failure.
  if (parsed.data.matches.length > 0 && matches.length === 0) {
    throw new Error(
      `football-data.org: all ${parsed.data.matches.length} matches in this response failed to map ` +
        "(unknown status or missing score) — likely a corrupted upstream response, not an empty matchweek",
    );
  }

  return { matches, syntheticTeams: [...syntheticTeams.values()] };
}

async function resolveTeam(footballDataId: number, fallbackName: string): Promise<{ id: string; team: Team | null }> {
  const resolution = await teamIdFromFootballData(footballDataId, fallbackName);
  if (!resolution.synthesized) return { id: resolution.id, team: null };
  return { id: resolution.id, team: { id: resolution.id, name: fallbackName, nicknames: [] } };
}

function seasonYear(startDate: string): number {
  const year = Number.parseInt(startDate.slice(0, 4), 10);
  if (Number.isNaN(year)) {
    throw new Error(`could not parse season year from startDate: ${startDate}`);
  }
  return year;
}
