import { QdrantClient } from "@qdrant/js-client-rest";
import { z } from "zod";
import { loadEnv } from "../config/env.ts";
import { EMBEDDING } from "../config/models.ts";
import { passagePayloadSchema } from "./types.ts";
import type { IndexedDigest, Point, SearchResult } from "./types.ts";

// Requesting exact point ids (fetchDigests) is one call, no vector involved — retrieve()
// stays under this per-request cap so a batch of thousands of ids doesn't produce a URL/
// body that works in a test and fails in production.
const RETRIEVE_BATCH_SIZE = 256;

// Just enough of the stored payload to compare — never the full text/title.
const digestPayloadSchema = z.object({
  passageId: z.string().min(1),
  contentHash: z.string().min(1),
});

// Derived from the client itself — not hand-retyping the filter shape.
// This client (@qdrant/js-client-rest 1.19) no longer has a `search` method — it was
// replaced by the more general `query` — so the filter is derived from that instead,
// exactly as the spec allows: implementation may use a different client method and
// derive the filter type from that one instead.
export type QdrantFilter = NonNullable<
  NonNullable<Parameters<QdrantClient["query"]>[1]>["filter"]
>;

export interface EnsureCollectionOptions {
  recreate?: boolean | undefined;
}

export interface SearchParams {
  vector: number[];
  k?: number | undefined;
  filter?: QdrantFilter | undefined;
}

let client: QdrantClient | undefined;

/** Shared client, built from QDRANT_URL / QDRANT_API_KEY. */
export function getClient(): QdrantClient {
  if (client) return client;

  const env = loadEnv();
  client = new QdrantClient({
    url: env.QDRANT_URL,
    ...(env.QDRANT_API_KEY !== undefined ? { apiKey: env.QDRANT_API_KEY } : {}),
  });
  return client;
}

function getCollectionName(): string {
  return loadEnv().QDRANT_COLLECTION;
}

/**
 * Creates the collection if it doesn't exist. `recreate: true` drops and recreates it
 * (used by `npm run index`). Dimension EMBEDDING.dimensions (1024), "Cosine" distance.
 * See docs/learning/01: the dimension is permanent.
 */
export async function ensureCollection(options?: EnsureCollectionOptions): Promise<void> {
  const qdrant = getClient();
  const collection = getCollectionName();
  const exists = await qdrant.collectionExists(collection);

  if (exists.exists && options?.recreate) {
    await qdrant.deleteCollection(collection);
  }

  if (!exists.exists || options?.recreate) {
    await qdrant.createCollection(collection, {
      vectors: { size: EMBEDDING.dimensions, distance: "Cosine" },
    });
  }
}

/**
 * Digest of the points that already exist, for the given point ids. Ids that aren't in
 * the collection are simply absent from the result — missing is not an error.
 * Returns [] when the collection doesn't exist yet (first run).
 * Requests only the two payload fields it needs, never the vectors or the full text.
 */
export async function fetchDigests(pointIds: number[]): Promise<IndexedDigest[]> {
  const qdrant = getClient();
  const collection = getCollectionName();
  const url = loadEnv().QDRANT_URL;

  let exists: { exists: boolean };
  try {
    exists = await qdrant.collectionExists(collection);
  } catch (error) {
    throw new Error(`could not reach Qdrant at ${url}: ${describeError(error)}`, { cause: error });
  }

  // Doesn't create the collection here — search()'s "run: npm run index" message stays
  // meaningful for anyone who asks a question before indexing anything.
  if (!exists.exists) {
    return [];
  }

  const digests: IndexedDigest[] = [];

  for (let start = 0; start < pointIds.length; start += RETRIEVE_BATCH_SIZE) {
    const batch = pointIds.slice(start, start + RETRIEVE_BATCH_SIZE);

    let records: Awaited<ReturnType<QdrantClient["retrieve"]>>;
    try {
      records = await qdrant.retrieve(collection, {
        ids: batch,
        with_payload: ["passageId", "contentHash"],
        with_vector: false,
      });
    } catch (error) {
      throw new Error(`could not reach Qdrant at ${url}: ${describeError(error)}`, { cause: error });
    }

    for (const record of records) {
      const parsed = digestPayloadSchema.safeParse(record.payload);
      if (!parsed.success) {
        // A point indexed before contentHash existed — treated as absent, so the
        // pipeline re-indexes it and heals itself on the next npm run index.
        console.warn(`fetchDigests: point ${String(record.id)} has no usable digest payload — will be reindexed`);
        continue;
      }
      digests.push({ pointId: Number(record.id), passageId: parsed.data.passageId, contentHash: parsed.data.contentHash });
    }
  }

  return digests;
}

/** @returns how many points were inserted */
export async function insertPoints(points: Point[]): Promise<number> {
  const qdrant = getClient();
  const collection = getCollectionName();

  await qdrant.upsert(collection, {
    wait: true,
    points: points.map((point) => ({
      id: point.id,
      vector: point.vector,
      payload: point.payload,
    })),
  });

  return points.length;
}

/** k defaults to 5. Ordered by descending score. */
export async function search(params: SearchParams): Promise<SearchResult[]> {
  const qdrant = getClient();
  const collection = getCollectionName();
  const url = loadEnv().QDRANT_URL;

  let exists: { exists: boolean };
  try {
    exists = await qdrant.collectionExists(collection);
  } catch (error) {
    throw new Error(`could not reach Qdrant at ${url}: ${describeError(error)}`, { cause: error });
  }

  if (!exists.exists) {
    throw new Error(`collection '${collection}' does not exist — run: npm run index`);
  }

  let response: Awaited<ReturnType<QdrantClient["query"]>>;
  try {
    response = await qdrant.query(collection, {
      query: params.vector,
      limit: params.k ?? 5,
      with_payload: true,
      ...(params.filter !== undefined ? { filter: params.filter } : {}),
    });
  } catch (error) {
    throw new Error(`could not reach Qdrant at ${url}: ${describeError(error)}`, { cause: error });
  }

  return response.points.map((point) => {
    const parsed = passagePayloadSchema.safeParse(point.payload);
    if (!parsed.success) {
      const passageId =
        point.payload && typeof point.payload === "object" && "passageId" in point.payload
          ? String((point.payload as Record<string, unknown>)["passageId"])
          : "unknown";
      throw new Error(
        `invalid payload for point ${String(point.id)} (passageId: ${passageId}):\n${z.prettifyError(parsed.error)}`,
      );
    }
    return { id: Number(point.id), score: point.score, payload: parsed.data };
  });
}

/** How many points the collection has — the trace prints this. */
export async function countPoints(): Promise<number> {
  const qdrant = getClient();
  const collection = getCollectionName();
  const result = await qdrant.count(collection, { exact: true });
  return result.count;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
