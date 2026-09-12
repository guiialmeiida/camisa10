import { createHash } from "node:crypto";

/**
 * Deterministic Qdrant point id for one chunk of a passage. Same 48-bit sha1 truncation as
 * before (Qdrant only takes an unsigned integer or a UUID as a point id), now over
 * `${passageId}#${chunkIndex}` — so every chunk of a passage gets its own stable id, and the
 * id of chunk i can be recomputed without knowing how many chunks the passage has. 48 bits
 * fits in Number.MAX_SAFE_INTEGER (2^53), so the value survives JSON round-trips without
 * precision loss.
 *
 * Total on purpose: it accepts any string, not just the 12-hex ids rss.ts produces.
 * The fixture double's ids ("p03") are not hex, and Number.parseInt("p03", 16) is NaN.
 *
 * Hashing the concatenated string (instead of packing passageId's hash and chunkIndex into
 * separate bits of one integer) is deliberate: packing would cap the number of chunks a
 * passage can have at whatever bit width is left over, turning "passage with more chunks
 * than that" into a silent overwrite bug. Hashing has no such cap — the only risk it adds is
 * collision, and that already has a guard since task 02 (indexer.ts), now over the pair
 * (passageId, chunkIndex).
 */
export function pointIdFromChunk(passageId: string, chunkIndex: number): number {
  if (passageId.length === 0) {
    throw new Error("pointIdFromChunk: empty passage id");
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error(`pointIdFromChunk: invalid chunk index ${chunkIndex}`);
  }

  const digest = createHash("sha1").update(`${passageId}#${chunkIndex}`).digest("hex").slice(0, 12);
  return Number.parseInt(digest, 16);
}
