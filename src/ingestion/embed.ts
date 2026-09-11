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

// Voyage's free tier, without a payment method on file, caps both requests/min (3) and
// tokens/min (10,000) — see docs/tasks/01-data-sources.md and the recorded 429s from
// earlier tasks. Task 02 first shipped assuming a single request per ingestion run
// ("the feed brings dozens of items, not thousands") — wrong the moment the real feed
// (35 passages, ~18.5K estimated tokens) was measured. Reopened here: split into
// token-budgeted batches, paced a minute apart so the *rolling* one-minute token count
// never crosses the ceiling even though each batch alone fits under it.
const MAX_TOKENS_PER_BATCH = 5_000; // headroom under the real 10K/min ceiling for estimation error
// (chars/4 is an English-shaped estimate; accented Portuguese text tokenizes worse, so the
// margin below the real 10K ceiling needs to be wide, not just nonzero)
const BATCH_INTERVAL_MS = 65_000; // > 60s: the window is per-minute, not per-request

// Voyage doesn't expose a free tokenizer-count endpoint to check ahead of a call — ~4
// characters/token is the standard ballpark for Latin-script text on this model family.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Greedy token-budgeted batching — never splits a single text, so one very long text
 * can still produce a batch over budget; that's the Voyage API's problem to reject, not
 * something worth adding chunking machinery here for (chunking is task 03's job). */
function batchByTokenBudget(texts: string[], maxTokensPerBatch: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const text of texts) {
    const tokens = estimateTokens(text);
    if (current.length > 0 && currentTokens + tokens > maxTokensPerBatch) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(text);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);

  return batches;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One EMBEDDING.dimensions vector per text, in the same order.
 *
 * `inputType` follows Voyage's asymmetric embedding design: "document" at ingestion
 * time, "query" at question time. Same underlying vector space, better retrieval than
 * embedding both sides identically — see docs/learning/01.
 *
 * Splits into token-budgeted batches, paced a minute apart, when the input doesn't fit
 * a single request's fair share of Voyage's free-tier rate limit. A single-text call
 * (the common case: one question, at query time) always produces exactly one batch and
 * pays no extra latency.
 */
export async function embedAll(texts: string[], inputType: InputType): Promise<number[][]> {
  if (texts.length === 0) return [];

  const batches = batchByTokenBudget(texts, MAX_TOKENS_PER_BATCH);
  const vectors: number[][] = [];

  for (const [index, batch] of batches.entries()) {
    if (index > 0) {
      // Progress, not a debug log: a real `npm run index -- --recreate` against the full
      // feed takes several minutes of waiting (see docs/tasks/02-ingestion-pipeline.md) —
      // without this, the CLI goes silent long enough to look hung.
      console.log(
        `embedAll: waiting ${BATCH_INTERVAL_MS / 1000}s before batch ${index + 1}/${batches.length} (Voyage's rate-limit window is per minute, not per request)`,
      );
      await sleep(BATCH_INTERVAL_MS);
    }
    vectors.push(...(await embedBatch(batch, inputType)));
  }

  return vectors;
}

async function embedBatch(texts: string[], inputType: InputType): Promise<number[][]> {
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

  // A truncated response (fewer vectors than texts sent) would otherwise shift every
  // vector after the gap onto the wrong text once this batch is concatenated with
  // others in embedAll — silent misalignment, not a missing-embedding error at the end
  // the way it was before batching existed.
  if (vectors.length !== texts.length) {
    throw new Error(`Voyage returned ${vectors.length} embeddings for ${texts.length} texts sent`);
  }

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
