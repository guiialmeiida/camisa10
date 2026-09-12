import { loadEnv } from "../config/env.ts";
import { EMBEDDING, MODELS } from "../config/models.ts";
import { write } from "../generation/writer.ts";
import { buildCurrentMatchweekFilter } from "../retrieval/filters.ts";
import { searchContext } from "../retrieval/search-context.ts";
import { getFacts } from "../sources/index.ts";
import type { Facts } from "../sources/index.ts";
import { countPoints } from "../vectorstore/qdrant.ts";
import type { QdrantFilter } from "../vectorstore/qdrant.ts";
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
    // Deduped: task 03 lets two chunks of the same passage both land in context, so
    // without this the same passageId could print twice in "retrieved but not cited".
    retrievedNotCited: [
      ...new Set(
        stateWithData.context
          .map((result) => result.payload.passageId)
          .filter((id) => !writeResult.value.answer.citedPassages.includes(id)),
      ),
    ],
  });

  return writeResult.value;
}

/** If the planner returns an empty tool list, the graph — not the node — forces the minimum. */
function forceNonEmptyTools(state: StateWithPlan): StateWithPlan {
  if (state.plan.tools.length > 0) return state;
  return { ...state, plan: { ...state.plan, tools: ["fetch_facts_api"] } };
}

interface ContextOutcome {
  results: SearchResult[];
  /** The rigid filter actually sent to Qdrant — null when the search ran unfiltered. */
  filter: QdrantFilter | null;
  /** How long this branch sat waiting for the facts call. 0 when it didn't wait. */
  waitedForFactsMs: number;
}

/**
 * The search branch of the fan-out. In current_matchweek mode the date window comes from
 * the facts, so this branch waits for the facts call — defensively: a rejected facts call
 * becomes "no date window", never a rejected search. team_form doesn't wait at all.
 */
async function runContextCall(
  state: StateWithPlan,
  factsCall: Promise<{ value: Facts; ms: number }>,
): Promise<ContextOutcome> {
  let filter: QdrantFilter | null = null;
  let waitedForFactsMs = 0;

  if (state.plan.mode === "current_matchweek") {
    const waitStart = performance.now();
    // The .catch here — not the allSettled below — is what preserves resilience: without
    // it, a football API that's down would reject both branches of the allSettled, and
    // the question would lose the narrative too. With it, the search still runs, just
    // without a date window (the team clause, if any, still applies).
    const facts = await factsCall.then((settled) => settled.value).catch(() => null);
    waitedForFactsMs = performance.now() - waitStart;
    filter = buildCurrentMatchweekFilter({ facts, team: state.entity.team });
  }

  const results = await searchContext({
    query: state.plan.searchQuery,
    k: state.k,
    ...(filter !== null ? { filter } : {}),
  });

  return { results, filter, waitedForFactsMs };
}

/** Exported separately so the Promise.allSettled resilience (spec §6) is testable without spending on the API. */
export async function runFanOut(state: StateWithPlan, trace: TraceEntry[]): Promise<StateWithData> {
  const factsCall = measure(() =>
    getFacts({
      team: state.entity.team ?? undefined,
      competition: state.entity.competition ?? undefined,
      matchweek: state.entity.matchweek ?? undefined,
    }),
  );
  const contextCall = measure(() => runContextCall(state, factsCall));

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
  let filter: QdrantFilter | null = null;
  let waitedForFactsMs = 0;
  let contextMs = 0;
  let contextError: string | undefined;
  if (contextSettled.status === "fulfilled") {
    context = contextSettled.value.value.results;
    filter = contextSettled.value.value.filter;
    waitedForFactsMs = contextSettled.value.value.waitedForFactsMs;
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
    collection: loadEnv().QDRANT_COLLECTION,
    collectionSize,
    filter,
    waitedForFactsMs,
    results: context,
    ...(contextError !== undefined ? { error: contextError } : {}),
  });

  return { ...state, facts, context };
}

function describeError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
