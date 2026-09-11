import { createHash } from "node:crypto";

/**
 * Deterministic Qdrant point id for a passage. Qdrant only accepts an unsigned integer
 * or a UUID as a point id, and our ids are strings — so we hash the passage id and read
 * the first 48 bits of the digest as an integer. 48 bits fits in Number.MAX_SAFE_INTEGER
 * (2^53), so the value survives JSON round-trips without precision loss.
 *
 * Total on purpose: it accepts any string, not just the 12-hex ids rss.ts produces.
 * The fixture double's ids ("p03") are not hex, and Number.parseInt("p03", 16) is NaN.
 */
export function pointIdFromPassageId(passageId: string): number {
  if (passageId.length === 0) {
    throw new Error("pointIdFromPassageId: empty passage id");
  }

  const digest = createHash("sha1").update(passageId).digest("hex").slice(0, 12);
  return Number.parseInt(digest, 16);
}
