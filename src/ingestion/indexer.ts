import { loadEnv } from "../config/env.ts";
import { getFacts, listPassages } from "../sources/index.ts";
import { ensureCollection, insertPoints } from "../vectorstore/qdrant.ts";
import type { Point } from "../vectorstore/types.ts";
import { embedAll } from "./embed.ts";

export interface IndexReport {
  passages: number;
  points: number;
  collection: string;
}

/**
 * Reads the passages from the source, generates embeddings and recreates the
 * collection from scratch. This task's chunking: one passage = one chunk, no
 * splitting. Naive on purpose — real chunking is task 03, and this task's recall@k
 * is its ruler.
 */
export async function indexPassages(): Promise<IndexReport> {
  const [passages, facts] = await Promise.all([listPassages(), getFacts({})]);

  // A source with an empty passage list must fail *before* the collection is touched:
  // ensureCollection({ recreate: true }) is destructive, and an empty list caused by a
  // network blip would otherwise silently wipe the whole index.
  if (passages.length === 0) {
    throw new Error("indexPassages: the source returned 0 passages — refusing to recreate the collection");
  }

  const vectors = await embedAll(
    passages.map((passage) => passage.text),
    "document",
  );

  await ensureCollection({ recreate: true });

  const points: Point[] = passages.map((passage, index) => {
    const vector = vectors[index];
    if (!vector) {
      throw new Error(`missing embedding for passage ${passage.id}`);
    }

    return {
      id: index + 1, // sequential integer — Qdrant point ids don't accept our string ids
      vector,
      payload: {
        passageId: passage.id,
        text: passage.text,
        title: passage.title,
        source: passage.source,
        url: passage.url,
        type: passage.type,
        teams: passage.teams,
        matchId: passage.matchId,
        competition: facts.competition.id,
        // The matchweek is the one facts.ts reports for the current query, not derived
        // from passage.matchId — an RSS passage isn't tied to a match at all (task 01).
        matchweek: facts.matchweek,
        publishedAt: passage.publishedAt,
      },
    };
  });

  const inserted = await insertPoints(points);

  return { passages: passages.length, points: inserted, collection: loadEnv().QDRANT_COLLECTION };
}
