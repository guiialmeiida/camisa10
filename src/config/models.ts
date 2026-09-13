export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Discriminated union by model. Haiku 4.5 rejects `effort` on the API, so the type
 * forbids it: `{ model: "claude-haiku-4-5", effort: "high" }` doesn't compile.
 */
export type ModelConfig =
  | { readonly model: "claude-haiku-4-5"; readonly maxTokens: number; readonly effort?: never }
  | { readonly model: "claude-opus-5"; readonly effort: Effort; readonly maxTokens: number };

export const MODELS = {
  entityExtraction: { model: "claude-haiku-4-5", maxTokens: 512 },
  // Ingestion (task 02), not an agent runtime node — classifies PassageType per passage.
  passageClassification: { model: "claude-haiku-4-5", maxTokens: 128 },
  planner: { model: "claude-opus-5", effort: "medium", maxTokens: 1024 },
  /** One call per retrieved passage, N in parallel — the answer is a boolean plus one sentence. */
  grader: { model: "claude-haiku-4-5", maxTokens: 256 },
  writer: { model: "claude-opus-5", effort: "high", maxTokens: 2048 },
  /** Only ever called after the deterministic check flagged something — it rewrites a whole
   *  answer, so it gets the writer's token budget, not the grader's. */
  critic: { model: "claude-opus-5", effort: "medium", maxTokens: 2048 },
} as const satisfies Record<string, ModelConfig>;

export const EMBEDDING = {
  model: "voyage-3.5",
  dimensions: 1024,
} as const;
