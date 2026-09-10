import type { Match, Team } from "./fixture-schema.ts";

export interface Competition {
  id: string;
  name: string;
  season: number;
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
