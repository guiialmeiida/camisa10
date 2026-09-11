export interface Competition {
  id: string;
  name: string;
  season: number;
}

export interface Team {
  id: string; // slug: "palmeiras"
  name: string; // "Palmeiras"
  nicknames: string[]; // ["Verdão", "alviverde"] — only the extractEntity prompt uses this
}

export interface Score {
  home: number;
  away: number;
}

export type MatchStatus = "finished" | "live" | "scheduled" | "postponed";

interface MatchBase {
  id: string; // the match's id at football-data.org, as a string
  matchweek: number;
  date: string; // ISO with a -03:00 offset (see time.ts)
  homeTeam: string; // team id (slug)
  awayTeam: string;
  venue: string | null;
}

export type Match =
  | (MatchBase & { status: "finished"; score: Score })
  | (MatchBase & { status: "live"; score: Score; minute: number | null })
  | (MatchBase & { status: "scheduled"; score: null })
  | (MatchBase & { status: "postponed"; score: null });

export type PassageType = "article" | "chronicle" | "matchReport" | "preview";

export interface Passage {
  id: string; // must match /^[a-zA-Z0-9]+$/ — see rss.ts
  matchId: string | null;
  teams: string[]; // team ids; can be []
  type: PassageType;
  title: string;
  source: string; // "Gazeta Esportiva"
  url: string;
  publishedAt: string; // ISO with a -03:00 offset
  text: string;
}

export interface Facts {
  competition: Competition;
  matchweek: number;
  matches: Match[];
  teams: Team[]; // used by the extractEntity prompt to resolve nicknames
  source: "fixture" | "api";
}

export interface FactsFilter {
  competition?: string | undefined;
  matchweek?: number | undefined;
  team?: string | undefined;
}
