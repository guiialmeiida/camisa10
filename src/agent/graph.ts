import { EMBEDDING, MODELS } from "../config/models.ts";
import { write } from "../generation/writer.ts";
import { searchContext } from "../retrieval/search-context.ts";
import { getFacts } from "../sources/index.ts";
import type { Facts } from "../sources/index.ts";
import { countPoints } from "../vectorstore/qdrant.ts";
import type { SearchResult } from "../vectorstore/types.ts";
import { extractEntity } from "./nodes/extract-entity.ts";
import { plan as planNode } from "./nodes/plan.ts";
import type { FinalState, InitialState, StateWithData, StateWithPlan } from "./state.ts";
import { measure, record } from "./trace.ts";
import type { TraceEntry } from "./trace.ts";

export interface AskInput {
  question: string;
  k?: number | undefined;
}

/**
 * Fixed sequence: extractEntity -> plan -> Promise.allSettled -> write. No cycles
 * (those are task 06). The FinalState return type is the guarantee that no path
 * leaves the graph without an answer.
 */
export async function answer(input: AskInput): Promise<FinalState> {
  const initial: InitialState = {
    question: input.question,
    k: input.k ?? 5,
    trace: [],
  };

  const entityResult = await measure(() => extractEntity(initial));
  record(initial.trace, {
    node: "entityExtraction",
    model: MODELS.entityExtraction.model,
    ms: entityResult.ms,
    entity: entityResult.value.entity,
  });

  const planResult = await measure(() => planNode(entityResult.value));
  const stateWithPlan = forceNonEmptyTools(planResult.value);
  record(initial.trace, {
    node: "planner",
    model: `${MODELS.planner.model} (effort ${MODELS.planner.effort})`,
    ms: planResult.ms,
    plan: stateWithPlan.plan,
  });

  const stateWithData = await runFanOut(stateWithPlan, initial.trace);

  const writeResult = await measure(() => write(stateWithData));
  record(initial.trace, {
    node: "writer",
    model: `${MODELS.writer.model} (effort ${MODELS.writer.effort})`,
    ms: writeResult.ms,
    cited: writeResult.value.answer.citedPassages,
    retrievedNotCited: stateWithData.context
      .map((result) => result.payload.passageId)
      .filter((id) => !writeResult.value.answer.citedPassages.includes(id)),
  });

  return writeResult.value;
}

/** If the planner returns an empty tool list, the graph — not the node — forces the minimum. */
function forceNonEmptyTools(state: StateWithPlan): StateWithPlan {
  if (state.plan.tools.length > 0) return state;
  return { ...state, plan: { ...state.plan, tools: ["fetch_facts_api"] } };
}

async function runFanOut(state: StateWithPlan, trace: TraceEntry[]): Promise<StateWithData> {
  const factsCall = measure(() =>
    getFacts({
      team: state.entity.team ?? undefined,
      competition: state.entity.competition ?? undefined,
      matchweek: state.entity.matchweek ?? undefined,
    }),
  );
  const contextCall = measure(() => searchContext({ query: state.plan.searchQuery, k: state.k }));

  const [factsSettled, contextSettled] = await Promise.allSettled([factsCall, contextCall]);

  let facts: Facts | null;
  let factsMs = 0;
  let factsError: string | undefined;
  if (factsSettled.status === "fulfilled") {
    facts = factsSettled.value.value;
    factsMs = factsSettled.value.ms;
  } else {
    facts = null;
    factsError = describeError(factsSettled.reason);
  }

  let context: SearchResult[];
  let contextMs = 0;
  let contextError: string | undefined;
  if (contextSettled.status === "fulfilled") {
    context = contextSettled.value.value;
    contextMs = contextSettled.value.ms;
  } else {
    context = [];
    contextError = describeError(contextSettled.reason);
  }

  const collectionSize = await countPoints().catch(() => 0);

  record(trace, {
    node: "fetch_facts_api",
    model: null,
    ms: factsMs,
    facts,
    ...(factsError !== undefined ? { error: factsError } : {}),
  });

  record(trace, {
    node: "search_vector_context",
    model: EMBEDDING.model,
    ms: contextMs,
    k: state.k,
    collectionSize,
    results: context,
    ...(contextError !== undefined ? { error: contextError } : {}),
  });

  return { ...state, facts, context };
}

function describeError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
