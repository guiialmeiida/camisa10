import type { Facts } from "../sources/index.ts";
import type { SearchResult } from "../vectorstore/types.ts";
// Type-only import: TraceEntry lives in trace.ts, which in turn needs FinalState from
// here for formatTrace's signature. Both directions are `import type`, erased at
// compile time by verbatimModuleSyntax, so there is no runtime circular dependency.
import type { TraceEntry } from "./trace.ts";

export type Mode = "current_matchweek" | "team_form";
export type Confidence = "high" | "low";
export type ToolName = "fetch_facts_api" | "search_vector_context";

export interface Entity {
  team: string | null;
  competition: string | null;
  matchweek: number | null;
  confidence: Confidence;
}

export interface Plan {
  mode: Mode;
  tools: ToolName[];
  searchQuery: string;
  rationale: string;
}

export interface Answer {
  text: string;
  citedPassages: string[];
  lowConfidence: boolean;
}

export interface InitialState {
  question: string;
  k: number;
  trace: TraceEntry[];
}
export interface StateWithEntity extends InitialState {
  entity: Entity;
}
export interface StateWithPlan extends StateWithEntity {
  plan: Plan;
}
export interface StateWithData extends StateWithPlan {
  facts: Facts | null; // null = the call failed; the writer is told
  context: SearchResult[]; // [] = nothing retrieved, or the search failed
}
export interface FinalState extends StateWithData {
  answer: Answer;
}
