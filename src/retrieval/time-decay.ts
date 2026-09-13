import type { SearchResult } from "../vectorstore/types.ts";

/** A passage loses half its weight every 14 days (discovery, item 4). */
export const TIME_DECAY_HALF_LIFE_DAYS = 14;

/**
 * How many candidates to ask Qdrant for, per requested result. Decay can only reorder
 * what the pool already contains — see docs/learning/06-time-decay.md.
 */
export const CANDIDATE_POOL_FACTOR = 4;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface TimeDecayOptions {
  /** Injectable so tests don't depend on the wall clock. Defaults to new Date(). */
  now?: Date | undefined;
  /** Defaults to TIME_DECAY_HALF_LIFE_DAYS. */
  halfLifeDays?: number | undefined;
}

/** 0.5 ** (ageDays / halfLifeDays), in (0, 1]. */
export function timeDecayWeight(publishedAt: string, options?: TimeDecayOptions): number {
  const halfLifeDays = options?.halfLifeDays ?? TIME_DECAY_HALF_LIFE_DAYS;
  if (halfLifeDays <= 0) {
    // Programming error, not bad data — a caller passing a nonsense half-life doesn't
    // get a silently wrong ranking.
    throw new Error(`halfLifeDays must be positive, got ${halfLifeDays}`);
  }

  const publishedAtMs = Date.parse(publishedAt);
  if (Number.isNaN(publishedAtMs)) {
    // A passage with bad metadata is ranked as if it were published today (weight 1),
    // not silently dropped — the warn is the trail.
    console.warn(`time-decay.ts: could not parse publishedAt "${publishedAt}" — using weight 1`);
    return 1;
  }

  const now = options?.now ?? new Date();
  // A negative age (publishedAt in the future — a stale feed clock, a timezone typo)
  // is clamped to 0 instead of producing a weight above 1: nobody gets a bonus for
  // being from the future.
  const ageDays = Math.max(0, (now.getTime() - publishedAtMs) / MS_PER_DAY);
  return 0.5 ** (ageDays / halfLifeDays);
}

export interface DecayedResult extends SearchResult {
  /** The raw cosine similarity Qdrant returned, before decay. */
  similarity: number;
  /** The weight applied to it. `score` is the product of the two. */
  timeDecay: number;
}

/** Narrowing helper for the trace, which prints the two factors when they exist. */
export function isDecayedResult(result: SearchResult): result is DecayedResult {
  return "similarity" in result && "timeDecay" in result;
}

/**
 * Reranks a candidate pool by `similarity x timeDecay` and cuts it to `k`.
 * Pure: returns a new array, never mutates `results`.
 */
export function rankByTimeDecay(results: SearchResult[], k: number, options?: TimeDecayOptions): DecayedResult[] {
  if (k <= 0) {
    throw new Error(`k must be positive, got ${k}`);
  }

  const decayed: DecayedResult[] = results.map((result) => {
    const similarity = result.score;
    const timeDecay = timeDecayWeight(result.payload.publishedAt, options);
    // Overwriting `score` is deliberate: `score` means "the number this result is at this
    // position for", and the trace prints `score` in order. The two factors stay visible
    // in the new fields.
    return { ...result, score: similarity * timeDecay, similarity, timeDecay };
  });

  // A copy, sorted — `Array.prototype.sort` is stable, so a tie in the product keeps the
  // order Qdrant returned it in.
  decayed.sort((a, b) => b.score - a.score);

  return decayed.slice(0, k);
}
