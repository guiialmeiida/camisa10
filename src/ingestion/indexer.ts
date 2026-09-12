import { loadEnv } from "../config/env.ts";
import { getFacts, listPassages } from "../sources/index.ts";
import type { Passage, PassageType } from "../sources/types.ts";
import { deleteOrphanChunks, ensureCollection, fetchDigests, insertPoints } from "../vectorstore/qdrant.ts";
import type { OrphanSweep } from "../vectorstore/qdrant.ts";
import { pointIdFromChunk } from "../vectorstore/point-id.ts";
import type { IndexedDigest, Point } from "../vectorstore/types.ts";
import { classifyPassageTypes } from "./classify.ts";
import { chunkText } from "./chunk.ts";
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
  /** How many chunks those passages produce in total — indexed or not. */
  chunks: number;
  /** Not in the collection yet. */
  newPassages: number;
  /** Already there, but incomplete or with a different contentHash. */
  changed: number;
  /** Skipped: every chunk present with the same contentHash. No embedding, no write. */
  unchanged: number;
  /** Chunk points upserted. */
  points: number;
  /** Leftover chunks of a previous, longer version of a passage, removed by the sweep. */
  orphanPointsDeleted: number;
  classificationFallbacks: number;
  /** Per PassageType, counted per *passage* indexed — sums to newPassages + changed. */
  typeCounts: Record<PassageType, number>;
}

// Batches the upsert to Qdrant, matching fetchDigests' own RETRIEVE_BATCH_SIZE spirit —
// a single request with thousands of vectors is the kind of thing that works in a test
// and fails in production.
const UPSERT_BATCH_SIZE = 64;

/** One passage split into its chunks, with everything derived once and reused downstream. */
interface ChunkedPassage {
  passage: Passage;
  chunks: string[];
  hash: string;
  pointIds: number[];
}

function emptyTypeCounts(): Record<PassageType, number> {
  return { article: 0, chronicle: 0, matchReport: 0, preview: 0 };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function chunkPassage(passage: Passage): ChunkedPassage {
  const chunks = chunkText(passage.text);
  const hash = contentHash({ title: passage.title, chunks });
  const pointIds = chunks.map((_chunk, chunkIndex) => pointIdFromChunk(passage.id, chunkIndex));
  return { passage, chunks, hash, pointIds };
}

/**
 * Converges the collection to the source instead of rebuilding it: each passage is
 * classified as `new`, `changed` or `unchanged` — now at the granularity of "are all of
 * its chunks present with the current hash?" — and only `new`/`changed` pay embedding, an
 * LLM call and a write to Qdrant. `recreate: true` keeps the old rebuild-from-scratch
 * escape hatch. See docs/learning/03-ingestion-pipeline.md and docs/learning/04-chunking.md.
 */
export async function indexPassages(options?: IndexOptions): Promise<IndexReport> {
  const recreate = options?.recreate ?? false;
  const [passages, facts] = await Promise.all([listPassages(), getFacts({})]);

  // A source with an empty passage list must fail *before* anything touches Qdrant —
  // this matters even more in recreate mode, which is destructive by design.
  if (passages.length === 0) {
    throw new Error("indexPassages: the source returned 0 passages — refusing to recreate the collection");
  }

  // The same passage id appearing twice (a dedup bug upstream, e.g. src/sources/passages.ts)
  // would otherwise classify and embed it twice, paying for it twice, and upsert it to the
  // same point ids — the second write silently winning with no signal anything was wrong.
  const seenPassageIds = new Set<string>();
  for (const passage of passages) {
    if (seenPassageIds.has(passage.id)) {
      throw new Error(`indexPassages: duplicate passage id "${passage.id}" from the source`);
    }
    seenPassageIds.add(passage.id);
  }

  // Chunking, once, for every passage — the total chunk count across all of them is the
  // `chunks` field of the report, whether or not each passage ends up indexed.
  const chunkedPassages = passages.map((passage) => chunkPassage(passage));
  const totalChunks = chunkedPassages.reduce((sum, chunked) => sum + chunked.chunks.length, 0);

  // Two different (passageId, chunkIndex) pairs truncating to the same 48-bit point id
  // would otherwise silently overwrite one another.
  const seenByPointId = new Map<number, string>();
  for (const chunked of chunkedPassages) {
    chunked.pointIds.forEach((pointId, chunkIndex) => {
      const label = `${chunked.passage.id}#${chunkIndex}`;
      const seenLabel = seenByPointId.get(pointId);
      if (seenLabel !== undefined && seenLabel !== label) {
        throw new Error(`indexPassages: point id collision between "${seenLabel}" and "${label}"`);
      }
      seenByPointId.set(pointId, label);
    });
  }

  const allPointIds = chunkedPassages.flatMap((chunked) => chunked.pointIds);

  let digests: IndexedDigest[];
  if (recreate) {
    // Non-destructive health check before spending embedding/LLM money: creates the
    // collection if missing, does nothing if it already exists.
    await ensureCollection();
    digests = [];
  } else {
    // Also this mode's health check: if Qdrant doesn't respond, this is where the run
    // dies, before a cent is spent.
    digests = await fetchDigests(allPointIds);
  }

  const digestByPointId = new Map(digests.map((digest) => [digest.pointId, digest]));

  const newPassages: ChunkedPassage[] = [];
  const changedPassages: ChunkedPassage[] = [];
  let unchanged = 0;

  for (const chunked of chunkedPassages) {
    const chunkDigests = chunked.pointIds.map((pointId) => digestByPointId.get(pointId));

    for (const digest of chunkDigests) {
      if (digest !== undefined && digest.passageId !== chunked.passage.id) {
        throw new Error(
          `indexPassages: point id collision between indexed passage "${digest.passageId}" and new passage "${chunked.passage.id}"`,
        );
      }
    }

    const presentCount = chunkDigests.filter((digest) => digest !== undefined).length;

    if (presentCount === 0) {
      newPassages.push(chunked);
      continue;
    }

    // Every chunk must be present *and* match the current hash to count as unchanged.
    // A missing digest (`digest === undefined`) never equals `chunked.hash` here, so a
    // partial write from a run that died mid-way — some chunks present, some missing —
    // already falls through to `changedPassages` on its own; reindexing the whole
    // passage is what resumes it. There's no separate branch for "some chunks missing"
    // because this check already covers it.
    const allSameHash = chunkDigests.every((digest) => digest?.contentHash === chunked.hash);
    if (allSameHash) {
      unchanged += 1;
    } else {
      changedPassages.push(chunked);
    }
  }

  const toIndex = [...newPassages, ...changedPassages];

  if (toIndex.length === 0) {
    return {
      collection: loadEnv().QDRANT_COLLECTION,
      mode: recreate ? "recreate" : "incremental",
      passages: passages.length,
      chunks: totalChunks,
      newPassages: newPassages.length,
      changed: changedPassages.length,
      unchanged,
      points: 0,
      orphanPointsDeleted: 0,
      classificationFallbacks: 0,
      typeCounts: emptyTypeCounts(),
    };
  }

  // One classification per passage, not per chunk: `type` is the genre of the article —
  // classifying the same text N times would pay N times for the same answer.
  const classifications = await classifyPassageTypes(toIndex.map((chunked) => chunked.passage));
  const vectors = await embedAll(
    toIndex.flatMap((chunked) => chunked.chunks),
    "document",
  );

  if (recreate) {
    // The destruction happens as late as possible, after embeddings and classification
    // have already succeeded — same defensive ordering the previous implementation used.
    await ensureCollection({ recreate: true });
  } else {
    await ensureCollection();
  }

  // The sweep runs before the upsert, and only outside recreate mode (the collection just
  // got created — nothing to sweep). This order is what keeps the pipeline idempotent
  // without a transaction (spec §8.2): if the process dies between the sweep and the
  // upsert, the chunks 0..M-1 still carry the *old* contentHash, so the next run sees
  // `changed` and reindexes + sweeps again. In the opposite order, dying mid-upsert would
  // leave chunks 0..M-1 with the *new* hash — the next run would see `unchanged` and the
  // orphans would never be swept again.
  let orphanPointsDeleted = 0;
  if (!recreate) {
    const sweeps: OrphanSweep[] = toIndex.map((chunked) => ({
      passageId: chunked.passage.id,
      chunkCount: chunked.chunks.length,
    }));
    orphanPointsDeleted = await deleteOrphanChunks(sweeps);
  }

  const typeCounts = emptyTypeCounts();
  const points: Point[] = [];
  let vectorIndex = 0;

  toIndex.forEach((chunked, passageIndex) => {
    const classification = classifications[passageIndex];
    if (!classification || classification.passageId !== chunked.passage.id) {
      throw new Error(`classification/passage mismatch for passage ${chunked.passage.id}`);
    }
    typeCounts[classification.type] += 1;

    chunked.chunks.forEach((chunk, chunkIndex) => {
      const vector = vectors[vectorIndex];
      vectorIndex += 1;
      if (!vector) {
        throw new Error(`missing embedding for passage ${chunked.passage.id} chunk ${chunkIndex}`);
      }

      const pointId = chunked.pointIds[chunkIndex];
      if (pointId === undefined) {
        throw new Error(`indexPassages: no point id computed for passage ${chunked.passage.id} chunk ${chunkIndex} — this is a bug`);
      }

      points.push({
        id: pointId,
        vector,
        payload: {
          passageId: chunked.passage.id,
          contentHash: chunked.hash,
          chunkIndex,
          chunkCount: chunked.chunks.length,
          text: chunk,
          title: chunked.passage.title,
          source: chunked.passage.source,
          url: chunked.passage.url,
          type: classification.type,
          teams: chunked.passage.teams,
          matchId: chunked.passage.matchId,
          competition: facts.competition.id,
          // The matchweek is the one facts.ts reports for the current run, not derived
          // from passage.matchId — an RSS passage isn't tied to a match at all (task 01).
          matchweek: facts.matchweek,
          publishedAt: chunked.passage.publishedAt,
        },
      });
    });
  });

  let inserted = 0;
  for (let start = 0; start < points.length; start += UPSERT_BATCH_SIZE) {
    const batch = points.slice(start, start + UPSERT_BATCH_SIZE);
    try {
      inserted += await insertPoints(batch);
    } catch (error) {
      // No rollback: the batches written so far have stable ids and correct
      // contentHash, so the next run sees them as unchanged (or changed, if a passage's
      // chunks are split across batches) and resumes exactly where this one stopped.
      // Idempotency in place of a transaction.
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
    chunks: totalChunks,
    newPassages: newPassages.length,
    changed: changedPassages.length,
    unchanged,
    points: inserted,
    orphanPointsDeleted,
    classificationFallbacks,
    typeCounts,
  };
}
