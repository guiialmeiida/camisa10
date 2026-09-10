import { z } from "zod";
import { loadEnv } from "../config/env.ts";
import { EMBEDDING } from "../config/models.ts";

const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";

// Response is `unknown` off the wire — it's a boundary, so it's zod.
const voyageResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()),
      index: z.number().int(),
    }),
  ),
});

export type InputType = "query" | "document";

/**
 * One EMBEDDING.dimensions vector per text, in the same order.
 *
 * `inputType` follows Voyage's asymmetric embedding design: "document" at ingestion
 * time, "query" at question time. Same underlying vector space, better retrieval than
 * embedding both sides identically — see docs/learning/01.
 */
export async function embedAll(texts: string[], inputType: InputType): Promise<number[][]> {
  if (texts.length === 0) return [];

  const { VOYAGE_API_KEY } = loadEnv();
  const response = await fetch(VOYAGE_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: texts,
      model: EMBEDDING.model,
      input_type: inputType,
    }),
    // Same reasoning as the Anthropic client's timeout: an unbounded request can hang
    // for a very long time instead of failing fast.
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Voyage embeddings request failed: ${response.status} ${await response.text()}`);
  }

  const parsed = voyageResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(`Unexpected Voyage embeddings response shape: ${z.prettifyError(parsed.error)}`);
  }

  const vectors = [...parsed.data.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);

  for (const vector of vectors) {
    if (vector.length !== EMBEDDING.dimensions) {
      throw new Error(
        `embedding has ${vector.length} dimensions, expected ${EMBEDDING.dimensions} — did the model change?`,
      );
    }
  }

  return vectors;
}

export async function embed(text: string, inputType: InputType): Promise<number[]> {
  const [vector] = await embedAll([text], inputType);
  if (!vector) {
    throw new Error("embedding call returned no vectors");
  }
  return vector;
}
