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
  const matchweekByMatchId = new Map(facts.matches.map((match) => [match.id, match.matchweek]));

  const vectors = await embedAll(passages.map((passage) => passage.text));

  await ensureCollection({ recreate: true });

  const points: Point[] = passages.map((passage, index) => {
    const vector = vectors[index];
    if (!vector) {
      throw new Error(`missing embedding for passage ${passage.id}`);
    }

    const matchweek = matchweekByMatchId.get(passage.matchId);
    if (matchweek === undefined) {
      throw new Error(`passage ${passage.id} references unknown match ${passage.matchId}`);
    }

    return {
      id: index + 1, // sequential integer — Qdrant point ids don't accept the fixture's string ids
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
        matchweek,
        publishedAt: passage.publishedAt,
      },
    };
  });

  const inserted = await insertPoints(points);

  return { passages: passages.length, points: inserted, collection: loadEnv().QDRANT_COLLECTION };
}
