import type { Facts } from "../sources/index.ts";
import type { QdrantFilter } from "../vectorstore/qdrant.ts";

/** How far before the matchweek's first match the publication window opens. */
export const CURRENT_MATCHWEEK_LOOKBACK_DAYS = 3;

// QdrantFilter["must"] is typed as `Condition | Condition[] | Record<string, unknown>` by
// the generated client schema — too loose to build up incrementally. This is the concrete
// shape of the two clauses this module ever produces; it's structurally assignable to
// Qdrant's FieldCondition, so `{ must: FilterClause[] }` still satisfies QdrantFilter.
type FilterClause = { key: "publishedAt"; range: { gte: string; lte: string } } | { key: "teams"; match: { value: string } };

export interface CurrentMatchweekFilterParams {
  /** null when the facts call failed — then there is no date window, only the team clause. */
  facts: Facts | null;
  /** entity.team, already a team id (slug). null when the question names no team. */
  team: string | null;
  /** Injectable so the tests don't depend on the wall clock. Defaults to new Date(). */
  now?: Date | undefined;
}

/**
 * The rigid filter for the current_matchweek mode: publishedAt inside the matchweek's
 * window, and (when the question names a team) the passage must mention that team.
 * Pure function — no network, no state, no implicit clock. Returns null when there is
 * no clause at all — the caller then searches unfiltered.
 */
export function buildCurrentMatchweekFilter(params: CurrentMatchweekFilterParams): QdrantFilter | null {
  const now = params.now ?? new Date();
  const must: FilterClause[] = [];

  const dateClause = buildDateClause(params.facts, now);
  if (dateClause !== null) {
    must.push(dateClause);
  }

  const team = params.team?.trim();
  if (team !== undefined && team.length > 0) {
    must.push({ key: "teams", match: { value: team } });
  }

  if (must.length === 0) {
    return null;
  }

  return { must };
}

/**
 * The rigid filter for the team_form mode: the passage must mention the team.
 * Always applied in this mode (discovery, item 6) — the caller is responsible for not
 * calling it when there is no team (discovery, item 7).
 */
export function buildTeamFormFilter(team: string): QdrantFilter {
  return { must: [{ key: "teams", match: { value: team } }] };
}

function buildDateClause(facts: Facts | null, now: Date): FilterClause | null {
  if (facts === null || facts.matches.length === 0) {
    return null;
  }

  const times = facts.matches.map((match) => Date.parse(match.date)).filter((time) => Number.isFinite(time));
  if (times.length === 0) {
    return null;
  }

  const from = new Date(Math.min(...times) - CURRENT_MATCHWEEK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  if (from > now) {
    // The window would be empty (or in the future) — see spec §3, rule 2: the same
    // degenerate-case escape valve as "no matches at all", applied to the other case
    // where a useful window can't be computed.
    return null;
  }

  return { key: "publishedAt", range: { gte: from.toISOString(), lte: now.toISOString() } };
}
