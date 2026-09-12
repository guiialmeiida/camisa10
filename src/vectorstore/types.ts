import { z } from "zod";

// The payload comes back from Qdrant as `unknown` — it's a boundary, so it's zod.
export const passagePayloadSchema = z.strictObject({
  passageId: z.string().min(1),
  contentHash: z.string().length(40), // see src/ingestion/content-hash.ts
  chunkIndex: z.number().int().min(0), // position of this chunk within the passage, 0-based
  chunkCount: z.number().int().positive(), // how many chunks the passage produced in total
  text: z.string().min(1), // the text of THIS chunk, not the whole passage
  title: z.string().min(1),
  source: z.string().min(1),
  url: z.string(),
  type: z.enum(["article", "chronicle", "matchReport", "preview"]),
  teams: z.array(z.string()),
  matchId: z.string().min(1).nullable(), // an RSS passage isn't tied to a match (task 01)
  competition: z.string().min(1),
  matchweek: z.number().int().positive(),
  publishedAt: z.string(),
});

export type PassagePayload = z.infer<typeof passagePayloadSchema>;

export interface Point {
  id: number;
  vector: number[];
  payload: PassagePayload;
}

export interface SearchResult {
  id: number;
  score: number;
  payload: PassagePayload;
}

/** Just enough of a stored point to answer "is it already there, and unchanged?". */
export interface IndexedDigest {
  pointId: number;
  passageId: string;
  contentHash: string;
}
