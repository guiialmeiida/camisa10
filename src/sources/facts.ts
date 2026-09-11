import { loadEnv } from "../config/env.ts";
import { applyLiveScores, fetchLiveMatches } from "./api-football.ts";
import { COMPETITION } from "./competition.ts";
import { fetchCompetition, fetchMatchweek, mapMatches } from "./football-data.ts";
import { listTeams } from "./teams.ts";
import type { Facts, FactsFilter } from "./types.ts";

/**
 * team: team id (e.g. "palmeiras"). Without `team`, returns the whole matchweek.
 * Without `matchweek`, uses the competition's current matchday.
 * A filter with no match returns `matches: []` — absence of data is not an error.
 *
 * getFacts only ever talks to the two structured APIs (football-data.org, and
 * api-football.io only when a match is live) — never to the RSS feed. That's the golden
 * rule made literal: there is no code path where a number reaches the answer from the
 * narrative side.
 */
export async function getFacts(filter?: FactsFilter): Promise<Facts> {
  const info = await fetchCompetition();
  const teams = await listTeams();

  if (filter?.competition !== undefined && filter.competition !== COMPETITION.id) {
    return {
      competition: { id: COMPETITION.id, name: info.name, season: info.season },
      matchweek: filter.matchweek ?? info.currentMatchday,
      matches: [],
      teams,
      source: "api",
    };
  }

  const matchweek = filter?.matchweek ?? info.currentMatchday;
  const rawMatches = await fetchMatchweek(matchweek);
  const mapped = await mapMatches(rawMatches);
  let matches = mapped.matches;

  // Applied client-side: ~10 matches per matchweek, not worth spending another
  // football-data.org request (10 req/min) to do what a .filter() already does.
  if (filter?.team) {
    const team = filter.team;
    matches = matches.filter((match) => match.homeTeam === team || match.awayTeam === team);
  }

  const hasLiveMatch = matches.some((match) => match.status === "live");
  if (hasLiveMatch) {
    const { API_FOOTBALL_KEY } = loadEnv();
    if (API_FOOTBALL_KEY) {
      matches = applyLiveScores(matches, await fetchLiveMatches());
    } else if (!warnedMissingKey) {
      console.warn(
        "facts.ts: API_FOOTBALL_KEY is not set — the live match's score comes only from " +
          "football-data.org, which may lag behind the real result",
      );
      warnedMissingKey = true;
    }
  }

  // Spec §5: a synthetic team (a club football-data.org knows about that teams.json
  // doesn't) still belongs in Facts.teams — otherwise its display name never reaches
  // the user, and writer/trace fall back to printing the raw slug instead of a name.
  const allTeams = mapped.syntheticTeams.length > 0 ? [...teams, ...mapped.syntheticTeams] : teams;

  return {
    competition: { id: COMPETITION.id, name: info.name, season: info.season },
    matchweek,
    matches,
    teams: allTeams,
    source: "api",
  };
}

let warnedMissingKey = false;
