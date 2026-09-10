import type { Facts, Match, Team } from "../sources/index.ts";
import type { SearchResult } from "../vectorstore/types.ts";
import type { Entity, FinalState, Plan } from "./state.ts";

export type TraceEntry =
  | { node: "entityExtraction"; model: string; ms: number; entity: Entity }
  | { node: "planner"; model: string; ms: number; plan: Plan }
  | { node: "fetch_facts_api"; model: null; ms: number; facts: Facts | null; error?: string }
  | {
      node: "search_vector_context";
      model: string;
      ms: number;
      k: number;
      collectionSize: number;
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

function formatShortDate(iso: string): string {
  const date = new Date(iso);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${day}/${month} ${hour}:${minute}`;
}

function formatMatchSummary(match: Match, teams: Team[]): string {
  const homeName = teams.find((team) => team.id === match.homeTeam)?.name ?? match.homeTeam;
  const awayName = teams.find((team) => team.id === match.awayTeam)?.name ?? match.awayTeam;
  const date = formatShortDate(match.date);

  if (match.status === "scheduled") {
    return `${homeName} x ${awayName}   scheduled   ${date}`;
  }
  return `${homeName} ${match.score.home} x ${match.score.away} ${awayName}   ${match.status}   ${date}`;
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
        lines.push(`    ├── fetch_facts_api    source: fixture    ${formatSeconds(entry.ms)}`);
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
        lines.push(`    └── search_vector_context    ${entry.model}    ${formatSeconds(entry.ms)}`);
        if (entry.error !== undefined) {
          lines.push(`        ERROR: ${entry.error}`);
        } else if (entry.results.length === 0) {
          lines.push("        no passages retrieved");
        } else {
          lines.push(
            `        k=${entry.k} over ${entry.collectionSize} points in collection camisa10`,
          );
          entry.results.forEach((result, index) => {
            lines.push(
              `        #${index + 1}  ${result.score.toFixed(3)}  ${result.payload.passageId}  ${result.payload.type}  "${truncate(result.payload.text, 45)}"`,
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
    lines.push("⚠ low confidence: no narrative context, API facts only");
    lines.push("");
  }

  if (state.answer.citedPassages.length > 0) {
    lines.push("sources:");
    for (const passageId of state.answer.citedPassages) {
      lines.push(`  [${passageId}] ${findPassageSource(state.trace, passageId)}`);
    }
    lines.push("");
  }

  const totalMs = state.trace.reduce((sum, entry) => sum + entry.ms, 0);
  lines.push(
    `total: ${formatSeconds(totalMs)} · ${llmCalls} LLM calls · ${embeddingCalls} embedding call${embeddingCalls === 1 ? "" : "s"}`,
  );

  return lines.join("\n");
}
