import type { Team } from "../sources/index.ts";

export function teamName(teamId: string, teams: Team[]): string {
  return teams.find((team) => team.id === teamId)?.name ?? teamId;
}

/**
 * Reads day/month/hour/minute straight off the ISO string instead of building a
 * `Date` and calling local getters. `new Date(iso).getDate()` depends on the host's
 * timezone — the same fixture match (offset -03:00) reports a different calendar day
 * depending on where the process runs (confirmed: 05/09 under America/Sao_Paulo,
 * 06/09 under UTC). This reads the wall-clock date exactly as written in the ISO
 * string, independent of the host.
 */
export function isoDateParts(iso: string): { day: number; month: number; hour: number; minute: number } {
  const match = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!match) {
    throw new Error(`not a valid ISO datetime: ${iso}`);
  }
  const [, month, day, hour, minute] = match;
  return { day: Number(day), month: Number(month), hour: Number(hour), minute: Number(minute) };
}

export function formatMatchDate(iso: string): string {
  const { day, month } = isoDateParts(iso);
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`;
}

export function formatMatchDateTime(iso: string): string {
  const { day, month, hour, minute } = isoDateParts(iso);
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
