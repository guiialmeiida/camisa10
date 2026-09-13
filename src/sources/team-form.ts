import { z } from "zod";
import { COMPETITION_CODE, STATUS_MAP, fetchTeamMatches, footballDataTeamMatchesSchema } from "./football-data.ts";
import { footballDataIdFor, teamIdFromFootballData } from "./teams.ts";
import { toSaoPauloIso } from "./time.ts";
import type { Score } from "./types.ts";

/** How many finished matches make up a team's recent form (discovery, item 2). BSA only. */
export const RECENT_FORM_SIZE = 5;
/**
 * How many matches the API is asked for, before the competition split. Live verification
 * (task 05, §2) found 2 of the last 5 matches of a club playing a continental cup were
 * *not* BSA — asking for RECENT_FORM_SIZE alone would silently produce a "last 5" that's
 * only 3 deep. 20 covers even a patological ~70%-outside-BSA stretch with room to spare;
 * see docs/learning/06-time-decay.md for the full reasoning.
 */
export const FORM_FETCH_LIMIT = 20;

export type MatchResult = "win" | "draw" | "loss";

export interface TeamFormMatch {
  id: string; // the match's id at football-data.org, as a string
  date: string; // ISO with a -03:00 offset (toSaoPauloIso)
  opponent: string; // team id (slug), or a synthetic slug for an unknown club
  side: "home" | "away"; // which side the queried team played on
  score: Score; // as played: { home, away } of the match, not of the team
  result: MatchResult; // from the queried team's point of view
  /** Never null: a match whose competition the response doesn't declare is dropped (rule 2). */
  competition: { code: string; name: string };
}

export interface TeamForm {
  team: string; // team id (slug)
  /** The record itself: most recent first, at most RECENT_FORM_SIZE, COMPETITION_CODE only. */
  matches: TeamFormMatch[];
  /** The single most recent match *outside* COMPETITION_CODE, or null if there was none
   *  among the FORM_FETCH_LIMIT fetched. Extra information, never part of `record`. */
  otherCompetitionMatch: TeamFormMatch | null;
  /** Counted over `matches` only — the league record, not "every game the club played". */
  record: { wins: number; draws: number; losses: number };
  source: "api";
}

/**
 * The team's recent form as exact facts. Talks only to football-data.org — never to the
 * vector index and never to the RSS feed, same as getFacts. No cache: the call runs once
 * per question.
 */
export async function getTeamForm(teamId: string): Promise<TeamForm> {
  const footballDataId = await footballDataIdFor(teamId);
  if (footballDataId === null) {
    throw new Error(`unknown team id "${teamId}" — not in teams.json`);
  }

  const raw = await fetchTeamMatches(footballDataId, FORM_FETCH_LIMIT);
  return mapTeamForm(teamId, footballDataId, raw);
}

/**
 * The pure half: validates a recorded body and maps it. Testable with no network.
 *
 * Async, unlike mapMatches' sibling in spirit but not in signature: resolving an
 * opponent's slug goes through teamIdFromFootballData, which reads teams.json (loadIndex)
 * and is itself async — the same reason mapMatches is async. See this task's
 * Implementação section for the one place this deviates from the spec's literal
 * (synchronous) signature.
 */
export async function mapTeamForm(teamId: string, footballDataId: number, raw: unknown): Promise<TeamForm> {
  const parsed = footballDataTeamMatchesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `football-data.org team matches response failed validation:\n${z.prettifyError(parsed.error)}`,
    );
  }

  // A candidate still carries the opponent as raw football-data.org id/name — resolving it
  // to a slug (teamIdFromFootballData) is deferred until after the partition below, so it
  // only ever runs for matches that actually survive into `matches`/`otherCompetitionMatch`.
  // Resolving eagerly here would call it for every fetched match, including the ones the
  // BSA cut and the "only the most recent other-competition match" rule throw away —
  // needless synthetic-team console.warn noise for games nobody ever sees (task 05 review,
  // achado 3).
  interface Candidate {
    id: string;
    date: string;
    side: "home" | "away";
    score: Score;
    result: MatchResult;
    competition: { code: string; name: string };
    opponentFootballDataId: number;
    opponentFallbackName: string;
  }

  const candidates: Candidate[] = [];

  for (const match of parsed.data.matches) {
    if (STATUS_MAP[match.status] !== "finished") {
      console.warn(`team-form.ts: match ${match.id} has status "${match.status}", not finished — dropped`);
      continue;
    }

    const { home: homeGoals, away: awayGoals } = match.score.fullTime;
    if (homeGoals === null || awayGoals === null) {
      // Never fabricate a score — same rule as mapMatches.
      console.warn(`team-form.ts: match ${match.id} is finished but has no final score — dropped`);
      continue;
    }

    const { competition } = match;
    if (competition == null || !competition.code || !competition.name) {
      // Never guess a competition either: an undeclared competition can't honestly be
      // called BSA (would contaminate `record`) nor "other" (would label it in the
      // prompt as something nobody confirmed). Covers all three unusable shapes — absent,
      // `null`, or present without a usable `code`/`name` — same rule for each (spec §5/§12).
      console.warn(`team-form.ts: match ${match.id} has no usable declared competition — dropped`);
      continue;
    }

    let side: "home" | "away";
    let opponentFootballDataId: number;
    let opponentFallbackName: string;
    if (match.homeTeam.id === footballDataId) {
      side = "home";
      opponentFootballDataId = match.awayTeam.id;
      opponentFallbackName = match.awayTeam.name;
    } else if (match.awayTeam.id === footballDataId) {
      side = "away";
      opponentFootballDataId = match.homeTeam.id;
      opponentFallbackName = match.homeTeam.name;
    } else {
      console.warn(`team-form.ts: match ${match.id} doesn't include team ${footballDataId} on either side — dropped`);
      continue;
    }

    const teamGoals = side === "home" ? homeGoals : awayGoals;
    const opponentGoals = side === "home" ? awayGoals : homeGoals;
    const result: MatchResult = teamGoals > opponentGoals ? "win" : teamGoals < opponentGoals ? "loss" : "draw";

    candidates.push({
      id: String(match.id),
      date: toSaoPauloIso(match.utcDate),
      side,
      score: { home: homeGoals, away: awayGoals },
      result,
      competition: { code: competition.code, name: competition.name },
      opponentFootballDataId,
      opponentFallbackName,
    });
  }

  // Ordering is mandatory, not style (spec §5, rule 6): it's what makes this function
  // correct regardless of how the API orders the response (the live call came back
  // ascending) or how `limit` truncates it.
  candidates.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  const survivingCandidates: Candidate[] = [];
  let otherCandidate: Candidate | null = null;

  for (const candidate of candidates) {
    if (candidate.competition.code === COMPETITION_CODE) {
      if (survivingCandidates.length < RECENT_FORM_SIZE) {
        survivingCandidates.push(candidate);
      }
    } else if (otherCandidate === null) {
      // The first non-BSA match encountered in the (already date-descending) list is the
      // most recent one — "a última partida", singular (discovery, item 10).
      otherCandidate = candidate;
    }
  }

  // Only now, with the partition and the RECENT_FORM_SIZE cut already applied, is the
  // opponent resolved — one teamIdFromFootballData call per surviving match, never per
  // fetched match.
  async function resolveCandidate(candidate: Candidate): Promise<TeamFormMatch> {
    const opponent = await teamIdFromFootballData(candidate.opponentFootballDataId, candidate.opponentFallbackName);
    return {
      id: candidate.id,
      date: candidate.date,
      opponent: opponent.id,
      side: candidate.side,
      score: candidate.score,
      result: candidate.result,
      competition: candidate.competition,
    };
  }

  const matches = await Promise.all(survivingCandidates.map(resolveCandidate));
  const otherCompetitionMatch = otherCandidate === null ? null : await resolveCandidate(otherCandidate);

  const record = matches.reduce(
    (acc, match) => {
      if (match.result === "win") acc.wins += 1;
      else if (match.result === "draw") acc.draws += 1;
      else acc.losses += 1;
      return acc;
    },
    { wins: 0, draws: 0, losses: 0 },
  );

  return { team: teamId, matches, otherCompetitionMatch, record, source: "api" };
}
