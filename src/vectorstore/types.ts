import { z } from "zod";

// The payload comes back from Qdrant as `unknown` — it's a boundary, so it's zod.
export const passagePayloadSchema = z.strictObject({
  passageId: z.string().min(1),
  text: z.string().min(1),
  title: z.string().min(1),
  source: z.string().min(1),
  url: z.string(),
  type: z.enum(["article", "chronicle", "matchReport", "preview"]),
  teams: z.array(z.string()),
  matchId: z.string().min(1),
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
