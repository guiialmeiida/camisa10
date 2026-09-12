import { formatMatchDateTime, teamName } from "../generation/match-format.ts";
import type { Facts, Match, Team } from "../sources/index.ts";
import type { QdrantFilter } from "../vectorstore/qdrant.ts";
import type { SearchResult } from "../vectorstore/types.ts";
import type { Entity, FinalState, Plan } from "./state.ts";

export type TraceEntry =
  | { node: "entityExtraction"; model: string; ms: number; entity: Entity }
  | { node: "planner"; model: string; ms: number; plan: Plan }
  | { node: "fetch_facts_api"; model: null; ms: number; facts: Facts | null; error?: string }
  | {
      node: "search_vector_context";
      model: string;
      /** The whole branch: waiting for the facts (when the mode needs them) + embedding + query. */
      ms: number;
      k: number;
      collection: string;
      collectionSize: number;
      /** The rigid filter sent to Qdrant, or null when the search ran unfiltered. */
      filter: QdrantFilter | null;
      /** How long the branch waited for fetch_facts_api. Always 0 outside current_matchweek. */
      waitedForFactsMs: number;
      results: SearchResult[];
      error?: string;
    }
  | { node: "writer"; model: string; ms: number; cited: string[]; retrievedNotCited: string[] };

export async function measure<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  const ms = performance.now() - start;
  return { value, ms };
}

export function record(trace: TraceEntry[], entry: TraceEntry): void {
  trace.push(entry);
}

function assertNever(value: never): never {
  throw new Error(`unhandled trace entry: ${JSON.stringify(value)}`);
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatMatchSummary(match: Match, teams: Team[]): string {
  const homeName = teamName(match.homeTeam, teams);
  const awayName = teamName(match.awayTeam, teams);
  const date = formatMatchDateTime(match.date);

  if (match.status === "scheduled") {
    return `${homeName} x ${awayName}   scheduled   ${date}`;
  }
  if (match.status === "postponed") {
    return `${homeName} x ${awayName}   postponed   ${date}`;
  }

  const minuteSuffix = match.status === "live" && match.minute !== null ? ` (${match.minute}')` : "";
  return `${homeName} ${match.score.home} x ${match.score.away} ${awayName}   ${match.status}${minuteSuffix}   ${date}`;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function findPassageSource(trace: TraceEntry[], passageId: string): string {
  for (const entry of trace) {
    if (entry.node !== "search_vector_context") continue;
    const match = entry.results.find((result) => result.payload.passageId === passageId);
    if (match) return `${match.payload.title} — ${match.payload.source}`;
  }
  return "unknown source";
}

/**
 * `lowConfidence` is one boolean for two different reasons (src/generation/writer.ts:
 * empty context, or missing facts) — say which one it actually was instead of a fixed
 * string that's wrong whenever facts failed but context was retrieved.
 */
function describeLowConfidence(state: FinalState): string {
  const noContext = state.context.length === 0;
  const noFacts = state.facts === null;

  if (noContext && noFacts) return "no narrative context, no API facts";
  if (noFacts) return "no API facts (narrative context only, unverifiable against real numbers)";
  if (noContext) return "no narrative context, API facts only";
  return "low confidence";
}

/**
 * The trace is this task's main learning artifact, not a debug log: it makes visible
 * what's normally invisible — which model ran at each step, what the vector search
 * returned and with what score, and where every number in the answer came from.
 */
export function formatTrace(state: FinalState): string {
  const lines: string[] = [];
  let stepNumber = 0;
  let llmCalls = 0;
  let embeddingCalls = 0;
  let fanOutHeaderIndex = -1;
  let fanOutMs = 0;

  lines.push(`┌ question ${"─".repeat(60)}`);
  lines.push(`│ ${state.question}`);
  lines.push(`└${"─".repeat(72)}`);
  lines.push("");

  for (const entry of state.trace) {
    switch (entry.node) {
      case "entityExtraction": {
        stepNumber += 1;
        llmCalls += 1;
        lines.push(`[${stepNumber}] entityExtraction    ${entry.model}    ${formatSeconds(entry.ms)}`);
        lines.push(
          `    team: ${entry.entity.team ?? "unknown"}   competition: ${entry.entity.competition ?? "unknown"}   matchweek: ${entry.entity.matchweek ?? "unknown"}`,
        );
        lines.push(`    confidence: ${entry.entity.confidence}`);
        lines.push("");
        break;
      }

      case "planner": {
        stepNumber += 1;
        llmCalls += 1;
        lines.push(`[${stepNumber}] planner    ${entry.model}    ${formatSeconds(entry.ms)}`);
        lines.push(`    mode: ${entry.plan.mode}`);
        lines.push(`    tools: ${entry.plan.tools.join(" + ")}`);
        lines.push(`    searchQuery: "${entry.plan.searchQuery}"`);
        lines.push(`    rationale: ${entry.plan.rationale}`);
        lines.push("");
        break;
      }

      case "fetch_facts_api": {
        stepNumber += 1;
        fanOutMs = entry.ms;
        fanOutHeaderIndex = lines.length;
        lines.push(`[${stepNumber}] fan-out (Promise.all)`);
        lines.push(`    ├── fetch_facts_api    source: ${entry.facts?.source ?? "unknown"}    ${formatSeconds(entry.ms)}`);
        if (entry.error !== undefined) {
          lines.push(`    │   ERROR: ${entry.error}`);
        } else if (!entry.facts) {
          lines.push("    │   no facts available");
        } else if (entry.facts.matches.length === 0) {
          lines.push("    │   0 matches for the requested filter");
        } else {
          lines.push(`    │   ${entry.facts.matches.length} match(es) for matchweek ${entry.facts.matchweek}`);
          for (const match of entry.facts.matches) {
            lines.push(`    │   ${formatMatchSummary(match, entry.facts.teams)}`);
          }
        }
        lines.push("    │");
        break;
      }

      case "search_vector_context": {
        embeddingCalls += 1;
        fanOutMs = Math.max(fanOutMs, entry.ms);
        if (fanOutHeaderIndex >= 0) {
          lines[fanOutHeaderIndex] = `${lines[fanOutHeaderIndex]}    ${formatSeconds(fanOutMs)}`;
        }
        const waitedSuffix =
          entry.waitedForFactsMs > 0 ? `    (waited ${formatSeconds(entry.waitedForFactsMs)} for fetch_facts_api)` : "";
        lines.push(`    └── search_vector_context    ${entry.model}    ${formatSeconds(entry.ms)}${waitedSuffix}`);
        lines.push(`        filter: ${entry.filter !== null ? JSON.stringify(entry.filter) : "none"}`);
        if (entry.error !== undefined) {
          lines.push(`        ERROR: ${entry.error}`);
        } else if (entry.results.length === 0) {
          lines.push("        no passages retrieved");
        } else {
          lines.push(`        k=${entry.k} over ${entry.collectionSize} points in collection ${entry.collection}`);
          entry.results.forEach((result, index) => {
            // chunkCount === 1 means the passage wasn't split — the whole fixture today,
            // and printing "chunk 1/1" there wouldn't teach anything. 1-based here because
            // it's text for a human; the underlying field stays 0-based.
            const chunkLabel =
              result.payload.chunkCount > 1 ? `  chunk ${result.payload.chunkIndex + 1}/${result.payload.chunkCount}` : "";
            lines.push(
              `        #${index + 1}  ${result.score.toFixed(3)}  ${result.payload.passageId}${chunkLabel}  ${result.payload.type}  "${truncate(result.payload.text, 45)}"`,
            );
          });
        }
        lines.push("");
        break;
      }

      case "writer": {
        stepNumber += 1;
        llmCalls += 1;
        lines.push(`[${stepNumber}] writer    ${entry.model}    ${formatSeconds(entry.ms)}`);
        lines.push("    allowed numbers: only the API facts above");
        const cited = entry.cited.length > 0 ? entry.cited.join(", ") : "none";
        const notCited =
          entry.retrievedNotCited.length > 0
            ? `   (retrieved but not cited: ${entry.retrievedNotCited.join(", ")})`
            : "";
        lines.push(`    cited: ${cited}${notCited}`);
        lines.push("");
        break;
      }

      default:
        assertNever(entry);
    }
  }

  lines.push(`─ answer ${"─".repeat(62)}`);
  lines.push(state.answer.text);
  lines.push("");

  if (state.answer.lowConfidence) {
    lines.push(`⚠ low confidence: ${describeLowConfidence(state)}`);
    lines.push("");
  }

  if (state.answer.citedPassages.length > 0) {
    lines.push("sources:");
    for (const passageId of state.answer.citedPassages) {
      lines.push(`  [${passageId}] ${findPassageSource(state.trace, passageId)}`);
    }
    lines.push("");
  }

  // fetch_facts_api and search_vector_context run inside the same Promise.allSettled —
  // summing every entry's ms would double-count that overlap, same mistake the fan-out
  // header avoided above with Math.max.
  let totalMs = 0;
  let totalFanOutMs = 0;
  for (const entry of state.trace) {
    if (entry.node === "fetch_facts_api" || entry.node === "search_vector_context") {
      totalFanOutMs = Math.max(totalFanOutMs, entry.ms);
    } else {
      totalMs += entry.ms;
    }
  }
  totalMs += totalFanOutMs;

  lines.push(
    `total: ${formatSeconds(totalMs)} · ${llmCalls} LLM call${llmCalls === 1 ? "" : "s"} · ${embeddingCalls} embedding call${embeddingCalls === 1 ? "" : "s"}`,
  );

  return lines.join("\n");
}
