import { createHash } from "node:crypto";
import type { Passage } from "../sources/types.ts";

/**
 * Fingerprint of the passage content that was indexed. Covers title + text: both come
 * from the same feed item, the text is what gets embedded, and the title is what the
 * writer cites — an edited headline should refresh the point too.
 *
 * Deliberately does NOT cover `type`, `teams`, `matchweek` or `competition`:
 * `type` is produced by the classifier (hashing it would force a classification before
 * the hash, defeating the point), and `matchweek` changes every week — hashing it would
 * invalidate the whole index every Sunday.
 */
export function contentHash(passage: Pick<Passage, "title" | "text">): string {
  return createHash("sha1").update(`${passage.title}\n${passage.text}`).digest("hex");
}
