import { loadEnv } from "../config/env.ts";
import { getFacts, listPassages } from "../sources/index.ts";
import type { Passage, PassageType } from "../sources/types.ts";
import { ensureCollection, fetchDigests, insertPoints } from "../vectorstore/qdrant.ts";
import { pointIdFromPassageId } from "../vectorstore/point-id.ts";
import type { IndexedDigest, Point } from "../vectorstore/types.ts";
import { classifyPassageTypes } from "./classify.ts";
import { contentHash } from "./content-hash.ts";
import { embedAll } from "./embed.ts";

export interface IndexOptions {
  /** Drop and rebuild the collection instead of converging to the source. */
  recreate?: boolean | undefined;
}

export interface IndexReport {
  collection: string;
  mode: "incremental" | "recreate";
  /** How many passages the source returned. */
  passages: number;
  /** Not in the collection yet. */
  newPassages: number;
  /** Already there, with a different contentHash. */
  changed: number;
  /** Skipped: same contentHash, no embedding and no write. */
  unchanged: number;
  /** Points upserted — always newPassages + changed. */
  points: number;
  /** How many classifications fell back to "article" because the LLM call failed. */
  classificationFallbacks: number;
  /** How many points were written per PassageType — the CLI prints this. Sums to `points`. */
  typeCounts: Record<PassageType, number>;
}

// Batches the upsert to Qdrant, matching fetchDigests' own RETRIEVE_BATCH_SIZE spirit —
// a single request with thousands of vectors is the kind of thing that works in a test
// and fails in production.
const UPSERT_BATCH_SIZE = 64;

function emptyTypeCounts(): Record<PassageType, number> {
  return { article: 0, chronicle: 0, matchReport: 0, preview: 0 };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Converges the collection to the source instead of rebuilding it: each passage is
 * classified as `new`, `changed` or `unchanged`, and only the first two cost embedding,
 * an LLM call and a write to Qdrant. `recreate: true` keeps the old rebuild-from-scratch
 * escape hatch. See docs/learning/03-ingestion-pipeline.md for the concept.
 */
export async function indexPassages(options?: IndexOptions): Promise<IndexReport> {
  const recreate = options?.recreate ?? false;
  const [passages, facts] = await Promise.all([listPassages(), getFacts({})]);

  // A source with an empty passage list must fail *before* anything touches Qdrant —
  // this matters even more in recreate mode, which is destructive by design.
  if (passages.length === 0) {
    throw new Error("indexPassages: the source returned 0 passages — refusing to recreate the collection");
  }

  const pointIds = passages.map((passage) => pointIdFromPassageId(passage.id));

  // Intra-batch collision guard: two different passage ids truncating to the same
  // 48-bit point id would otherwise silently overwrite one another.
  const seenByPointId = new Map<number, string>();
  passages.forEach((passage, index) => {
    const pointId = pointIds[index];
    if (pointId === undefined) return;
    const seenPassageId = seenByPointId.get(pointId);
    if (seenPassageId !== undefined && seenPassageId !== passage.id) {
      throw new Error(
        `indexPassages: point id collision between passages "${seenPassageId}" and "${passage.id}"`,
      );
    }
    seenByPointId.set(pointId, passage.id);
  });

  let digests: IndexedDigest[];
  if (recreate) {
    // Non-destructive health check before spending embedding/LLM money: creates the
    // collection if missing, does nothing if it already exists.
    await ensureCollection();
    digests = [];
  } else {
    // Also this mode's health check: if Qdrant doesn't respond, this is where the run
    // dies, before a cent is spent.
    digests = await fetchDigests(pointIds);
  }

  const digestByPointId = new Map(digests.map((digest) => [digest.pointId, digest]));

  const newPassages: Passage[] = [];
  const changedPassages: Passage[] = [];
  let unchanged = 0;
  const hashByPassageId = new Map<string, string>();

  passages.forEach((passage, index) => {
    const pointId = pointIds[index];
    if (pointId === undefined) return;
    const hash = contentHash(passage);
    hashByPassageId.set(passage.id, hash);
    const digest = digestByPointId.get(pointId);

    if (digest === undefined) {
      newPassages.push(passage);
      return;
    }

    if (digest.passageId !== passage.id) {
      throw new Error(
        `indexPassages: point id collision between indexed passage "${digest.passageId}" and new passage "${passage.id}"`,
      );
    }

    if (digest.contentHash !== hash) {
      changedPassages.push(passage);
    } else {
      unchanged += 1;
    }
  });

  const toIndex = [...newPassages, ...changedPassages];

  if (toIndex.length === 0) {
    return {
      collection: loadEnv().QDRANT_COLLECTION,
      mode: recreate ? "recreate" : "incremental",
      passages: passages.length,
      newPassages: newPassages.length,
      changed: changedPassages.length,
      unchanged,
      points: 0,
      classificationFallbacks: 0,
      typeCounts: emptyTypeCounts(),
    };
  }

  const classifications = await classifyPassageTypes(toIndex);
  const vectors = await embedAll(
    toIndex.map((passage) => passage.text),
    "document",
  );

  if (recreate) {
    // The destruction happens as late as possible, after embeddings and classification
    // have already succeeded — same defensive ordering the previous implementation used.
    await ensureCollection({ recreate: true });
  } else {
    await ensureCollection();
  }

  const typeCounts = emptyTypeCounts();
  const points: Point[] = toIndex.map((passage, index) => {
    const vector = vectors[index];
    if (!vector) {
      throw new Error(`missing embedding for passage ${passage.id}`);
    }

    const classification = classifications[index];
    if (!classification || classification.passageId !== passage.id) {
      throw new Error(`classification/passage mismatch for passage ${passage.id}`);
    }

    const hash = hashByPassageId.get(passage.id);
    if (hash === undefined) {
      throw new Error(`missing content hash for passage ${passage.id}`);
    }

    typeCounts[classification.type] += 1;

    return {
      id: pointIdFromPassageId(passage.id),
      vector,
      payload: {
        passageId: passage.id,
        contentHash: hash,
        text: passage.text,
        title: passage.title,
        source: passage.source,
        url: passage.url,
        type: classification.type,
        teams: passage.teams,
        matchId: passage.matchId,
        competition: facts.competition.id,
        // The matchweek is the one facts.ts reports for the current run, not derived
        // from passage.matchId — an RSS passage isn't tied to a match at all (task 01).
        matchweek: facts.matchweek,
        publishedAt: passage.publishedAt,
      },
    };
  });

  let inserted = 0;
  for (let start = 0; start < points.length; start += UPSERT_BATCH_SIZE) {
    const batch = points.slice(start, start + UPSERT_BATCH_SIZE);
    try {
      inserted += await insertPoints(batch);
    } catch (error) {
      // No rollback: the batches written so far have stable ids and correct
      // contentHash, so the next run sees them as unchanged and resumes exactly where
      // this one stopped. Idempotency in place of a transaction (spec §9).
      throw new Error(
        `indexPassages: insertPoints failed after ${inserted} point(s) were already written — ${describeError(error)}`,
        { cause: error },
      );
    }
  }

  const classificationFallbacks = classifications.filter((classification) => classification.fallback).length;

  return {
    collection: loadEnv().QDRANT_COLLECTION,
    mode: recreate ? "recreate" : "incremental",
    passages: passages.length,
    newPassages: newPassages.length,
    changed: changedPassages.length,
    unchanged,
    points: inserted,
    classificationFallbacks,
    typeCounts,
  };
}
