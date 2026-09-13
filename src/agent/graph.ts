import { loadEnv } from "../config/env.ts";
import { EMBEDDING, MODELS } from "../config/models.ts";
import { write } from "../generation/writer.ts";
import { buildCurrentMatchweekFilter, buildTeamFormFilter } from "../retrieval/filters.ts";
import { searchContext } from "../retrieval/search-context.ts";
import { CANDIDATE_POOL_FACTOR, rankByTimeDecay } from "../retrieval/time-decay.ts";
import { getFacts } from "../sources/index.ts";
import type { Facts } from "../sources/index.ts";
import { getTeamForm } from "../sources/team-form.ts";
import type { TeamForm } from "../sources/team-form.ts";
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
 * becomes "no date window", never a rejected search. team_form doesn't wait at all: it
 * builds its own filter straight from the question's entity, and instead of `k` results
 * it asks for a pool of `k * CANDIDATE_POOL_FACTOR` candidates, reranked client-side by
 * time decay (spec §3/§7 — Qdrant's filter is boolean, it can't apply a continuous weight).
 */
async function runContextCall(
  state: StateWithPlan,
  factsCall: Promise<{ value: FactsOutcome; ms: number }>,
): Promise<ContextOutcome> {
  if (state.plan.mode === "current_matchweek") {
    const waitStart = performance.now();
    // The .catch here — not the allSettled below — is what preserves resilience: without
    // it, a football API that's down would reject both branches of the allSettled, and
    // the question would lose the narrative too. With it, the search still runs, just
    // without a date window (the team clause, if any, still applies).
    const outcome = await factsCall.then((settled) => settled.value).catch(() => null);
    const waitedForFactsMs = performance.now() - waitStart;
    const filter = buildCurrentMatchweekFilter({ facts: outcome?.facts ?? null, team: state.entity.team });

    const results = await searchContext({
      query: state.plan.searchQuery,
      k: state.k,
      ...(filter !== null ? { filter } : {}),
    });

    return { results, filter, waitedForFactsMs };
  }

  const team = state.entity.team?.trim();
  if (state.plan.mode === "team_form" && team) {
    // Always applied, unconditionally — unlike current_matchweek's team clause, this
    // mode has no path that searches without a team filter (discovery, item 6).
    const filter = buildTeamFormFilter(team);
    const pool = await searchContext({ query: state.plan.searchQuery, k: state.k * CANDIDATE_POOL_FACTOR, filter });
    // `now` passed explicitly: the parameter exists to be injected, and a caller that
    // omits it teaches the opposite (spec §8).
    const results = rankByTimeDecay(pool, state.k, { now: new Date() });
    return { results, filter, waitedForFactsMs: 0 };
  }

  // Everything else — including team_form with no team (discovery, item 7) — is exactly
  // today's path: no filter, no wider pool, no decay.
  const results = await searchContext({ query: state.plan.searchQuery, k: state.k });
  return { results, filter: null, waitedForFactsMs: 0 };
}

export interface FactsOutcome {
  facts: Facts | null;
  recentForm: TeamForm | null;
  factsError?: string;
  formError?: string;
}

/**
 * The facts branch of the fan-out: getFacts always, plus getTeamForm when the question is
 * about a team's form. The two run in parallel and settle independently — one failing
 * never costs the other, and neither ever rejects this branch (spec §8).
 */
async function runFactsCall(state: StateWithPlan): Promise<FactsOutcome> {
  const team = state.entity.team?.trim();
  const formCall =
    state.plan.mode === "team_form" && team !== undefined && team.length > 0
      ? getTeamForm(team)
      : Promise.resolve(null);

  const [factsSettled, formSettled] = await Promise.allSettled([
    getFacts({
      team: state.entity.team ?? undefined,
      competition: state.entity.competition ?? undefined,
      matchweek: state.entity.matchweek ?? undefined,
    }),
    formCall,
  ]);

  return {
    facts: factsSettled.status === "fulfilled" ? factsSettled.value : null,
    recentForm: formSettled.status === "fulfilled" ? formSettled.value : null,
    ...(factsSettled.status === "rejected" ? { factsError: describeError(factsSettled.reason) } : {}),
    ...(formSettled.status === "rejected" ? { formError: describeError(formSettled.reason) } : {}),
  };
}

/** Exported separately so the Promise.allSettled resilience (spec §6) is testable without spending on the API. */
export async function runFanOut(state: StateWithPlan, trace: TraceEntry[]): Promise<StateWithData> {
  const factsCall = measure(() => runFactsCall(state));
  const contextCall = measure(() => runContextCall(state, factsCall));

  const [factsSettled, contextSettled] = await Promise.allSettled([factsCall, contextCall]);

  let facts: Facts | null;
  let recentForm: TeamForm | null;
  let factsMs = 0;
  let factsError: string | undefined;
  let formError: string | undefined;
  if (factsSettled.status === "fulfilled") {
    facts = factsSettled.value.value.facts;
    recentForm = factsSettled.value.value.recentForm;
    factsError = factsSettled.value.value.factsError;
    formError = factsSettled.value.value.formError;
    factsMs = factsSettled.value.ms;
  } else {
    // runFactsCall never rejects on its own (it settles both calls internally) — landing
    // here means a bug in this file, not an API outage. Both fields zero out (spec §8).
    facts = null;
    recentForm = null;
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
    recentForm,
    ...(factsError !== undefined ? { error: factsError } : {}),
    ...(formError !== undefined ? { formError } : {}),
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

  return { ...state, facts, context, recentForm };
}

function describeError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
