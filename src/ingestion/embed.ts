import OpenAI from "openai";
import { loadEnv } from "../config/env.ts";
import { EMBEDDING } from "../config/models.ts";

let client: OpenAI | undefined;

function getClient(): OpenAI {
  if (client) return client;
  client = new OpenAI({ apiKey: loadEnv().OPENAI_API_KEY });
  return client;
}

/** One EMBEDDING.dimensions vector per text, in the same order. */
export async function embedAll(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const openai = getClient();
  const response = await openai.embeddings.create({
    model: EMBEDDING.model,
    input: texts,
  });

  const vectors = [...response.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);

  for (const vector of vectors) {
    if (vector.length !== EMBEDDING.dimensions) {
      throw new Error(
        `embedding has ${vector.length} dimensions, expected ${EMBEDDING.dimensions} — did the model change?`,
      );
    }
  }

  return vectors;
}

export async function embed(text: string): Promise<number[]> {
  const [vector] = await embedAll([text]);
  if (!vector) {
    throw new Error("embedding call returned no vectors");
  }
  return vector;
}
