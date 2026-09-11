import { createHash } from "node:crypto";

export interface HashedContent {
  title: string;
  /** The chunks exactly as they will be indexed — chunkText's output. */
  chunks: string[];
}

/**
 * Fingerprint of what was actually indexed for a passage: the title plus the chunk texts.
 * Covering the chunks (and not the raw text) means that changing CHUNK_SIZE/CHUNK_OVERLAP
 * changes every hash, so the next `npm run index` reindexes everything instead of silently
 * keeping the old chunking. Still deliberately does NOT cover `type`, `teams`, `matchweek`
 * or `competition` — same reasoning as task 02: `type` is produced by the classifier (hashing
 * it would force a classification before the hash, defeating the point), and `matchweek`
 * changes every week (hashing it would invalidate the whole index every Sunday).
 */
export function contentHash(content: HashedContent): string {
  if (content.chunks.length === 0) {
    throw new Error("contentHash: empty chunk list");
  }
  return createHash("sha1").update(`${content.title}\n${content.chunks.join("\n")}`).digest("hex");
}
