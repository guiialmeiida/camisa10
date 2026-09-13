import { formatMatchDate, formatMatchDateTime, teamName } from "../generation/match-format.ts";
import { CANDIDATE_POOL_FACTOR, TIME_DECAY_HALF_LIFE_DAYS, isDecayedResult } from "../retrieval/time-decay.ts";
import type { Facts, Match, Team } from "../sources/index.ts";
import type { TeamForm, TeamFormMatch } from "../sources/team-form.ts";
import type { QdrantFilter } from "../vectorstore/qdrant.ts";
import type { SearchResult } from "../vectorstore/types.ts";
import { MAX_ANSWER_REWRITES } from "./nodes/critic.ts";
import { MAX_QUERY_REWRITES } from "./nodes/grade.ts";
import type { PassageGrade } from "./nodes/grade.ts";
import type { Entity, FinalState, Plan } from "./state.ts";

export type TraceEntry =
  | { node: "entityExtraction"; model: string; ms: number; entity: Entity }
  | { node: "planner"; model: string; ms: number; plan: Plan }
  | {
      node: "fetch_facts_api";
      model: null;
      ms: number;
      facts: Facts | null;
      /** null outside team_form. */
      recentForm: TeamForm | null;
      error?: string;
      /** getTeamForm's own failure — independent from `error`, which is getFacts'. */
      formError?: string;
    }
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
      /** 1-based: which search of the grading loop this was. */
      attempt: number;
      /** The searchQuery actually embedded. Implicit in the planner entry until task 06 —
       *  from now on it changes per attempt, so it has to be on the entry that used it. */
      query: string;
      error?: string;
    }
  | {
      node: "grader";
      /** MODELS.grader.model — the N parallel calls all use it. */
      model: string;
      /** The whole parallel batch, not the sum of the calls. */
      ms: number;
      /** 1-based: 1 is the fan-out's search, 2 and 3 come after a rewrite. */
      attempt: number;
      /** One per judged passage, in retrieval order. [] when nothing was retrieved. */
      grades: PassageGrade[];
      /** grades.filter(g => g.relevant).length — kept explicit so the trace doesn't have to
       *  recompute the number the decision was made on. */
      approved: number;
      judged: number;
      /** null when judged === 0. */
      approvedRatio: number | null;
      threshold: number;
      /** Whether this grading round triggered a query rewrite. */
      rewriting: boolean;
    }
  | {
      node: "queryRewrite";
      model: string;
      ms: number;
      /** 1-based, at most MAX_QUERY_REWRITES. */
      attempt: number;
      previousQuery: string;
      /** Equal to previousQuery when the planner produced no real change — the loop stops there. */
      newQuery: string;
      rejected: { passageId: string; reason: string }[];
      /** The rewrite call itself failed; the loop stops with the context it already had. */
      error?: string;
    }
  | {
      node: "writer";
      model: string;
      ms: number;
      cited: string[];
      retrievedNotCited: string[];
      /** Which grading attempt's approved context the writer actually saw (spec §6). */
      contextFromAttempt: number;
    }
  | {
      node: "critic";
      /** null when no LLM call was needed — the happy path. */
      model: string | null;
      ms: number;
      orphanNumbers: number[];
      rewritten: boolean;
      remainingOrphanNumbers: number[];
      redactedSentences: string[];
      previousAnswer: string | null;
      error?: string;
    };

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

/**
 * One line of a TeamFormMatch, home team first — `match.score` is already "as played"
 * (spec §5), so which side gets `teamLabel` just depends on `match.side`.
 */
function formatTeamFormMatchLine(match: TeamFormMatch, teamLabel: string, teams: Team[]): string {
  const opponentLabel = teamName(match.opponent, teams);
  const homeLabel = match.side === "home" ? teamLabel : opponentLabel;
  const awayLabel = match.side === "home" ? opponentLabel : teamLabel;
  const date = formatMatchDate(match.date);
  return `${date}  ${homeLabel} ${match.score.home} x ${match.score.away} ${awayLabel}   ${match.side}   ${match.result}`;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * The error/empty/results-with-scores body of a search_vector_context entry — shared by
 * the fan-out's first search and every retry after a rewrite (task 06), which only differ
 * in the header above this and the indent used.
 */
function pushSearchResultLines(
  lines: string[],
  entry: Extract<TraceEntry, { node: "search_vector_context" }>,
  indent: string,
): void {
  if (entry.error !== undefined) {
    lines.push(`${indent}ERROR: ${entry.error}`);
    return;
  }
  if (entry.results.length === 0) {
    lines.push(`${indent}no passages retrieved`);
    return;
  }

  // The pool/decay suffix is derived from the results, not a field on the trace entry:
  // it only ever shows up when at least one result actually went through rankByTimeDecay
  // (spec §9) — everywhere else this prints exactly as before.
  const hasDecayedResults = entry.results.some(isDecayedResult);
  const poolSuffix = hasDecayedResults
    ? `   (pool of ${entry.k * CANDIDATE_POOL_FACTOR}, time decay: half-life ${TIME_DECAY_HALF_LIFE_DAYS}d)`
    : "";
  lines.push(`${indent}k=${entry.k} over ${entry.collectionSize} points in collection ${entry.collection}${poolSuffix}`);

  entry.results.forEach((result, index) => {
    // chunkCount === 1 means the passage wasn't split — the whole fixture today, and
    // printing "chunk 1/1" there wouldn't teach anything. 1-based here because it's text
    // for a human; the underlying field stays 0-based.
    const chunkLabel =
      result.payload.chunkCount > 1 ? `  chunk ${result.payload.chunkIndex + 1}/${result.payload.chunkCount}` : "";
    const decaySuffix = isDecayedResult(result)
      ? `   (sim ${result.similarity.toFixed(3)} × decay ${result.timeDecay.toFixed(3)})`
      : "";
    lines.push(
      `${indent}#${index + 1}  ${result.score.toFixed(3)}  ${result.payload.passageId}${chunkLabel}  ${result.payload.type}  "${truncate(result.payload.text, 45)}"${decaySuffix}`,
    );
  });
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
 * `lowConfidence` is one boolean for several different reasons (src/generation/writer.ts:
 * empty context, missing facts, or — team_form only — missing recent form; task 06 adds a
 * fourth, the critic's redaction) — say which one it actually was instead of a fixed
 * string that's wrong whenever facts failed but context was retrieved.
 */
function describeLowConfidence(state: FinalState): string {
  const noContext = state.context.length === 0;
  const noFacts = state.facts === null;

  let base: string | null;
  if (noContext && noFacts) base = "no narrative context, no API facts";
  else if (noFacts) base = "no API facts (narrative context only, unverifiable against real numbers)";
  else if (noContext) base = "no narrative context, API facts only";
  else base = null;

  const reasons = [base, describeMissingFormReason(state), describeCriticReason(state)].filter(
    (reason): reason is string => reason !== null,
  );

  return reasons.length > 0 ? reasons.join("; ") : "low confidence";
}

/**
 * The team_form-specific reason (discovery, item 7): the question was about a team's
 * form and the form never arrived — either no team was identified at all, or getTeamForm
 * itself failed. null outside team_form, or when the form did arrive.
 */
function describeMissingFormReason(state: FinalState): string | null {
  if (state.plan.mode !== "team_form" || state.recentForm !== null) return null;
  if (state.entity.team === null) {
    return "no team identified in the question, so no recent form and no team filter";
  }
  return "no recent form for the team";
}

/**
 * Task 06's reason: the critic hit the self-check ceiling and had to remove a claim
 * outright. Reads the trace instead of a dedicated Answer field (spec §11) — the trace
 * already is the record of what happened in the graph, and a second field would just be
 * a copy of the critic entry that could drift out of sync with it.
 */
function describeCriticReason(state: FinalState): string | null {
  const criticEntries = state.trace.filter(
    (entry): entry is Extract<TraceEntry, { node: "critic" }> => entry.node === "critic",
  );
  const lastCritic = criticEntries[criticEntries.length - 1];
  if (lastCritic === undefined || lastCritic.redactedSentences.length === 0) return null;

  const count = lastCritic.redactedSentences.length;
  return `${count} claim${count === 1 ? "" : "s"} removed from the answer: number(s) ${lastCritic.remainingOrphanNumbers.join(", ")} had no API backing`;
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
        if (entry.formError !== undefined) {
          lines.push(`    │   RECENT FORM ERROR: ${entry.formError}`);
        } else if (entry.recentForm !== null) {
          const teams = entry.facts?.teams ?? [];
          const teamLabel = teamName(entry.recentForm.team, teams);
          const { wins, draws, losses } = entry.recentForm.record;
          lines.push(
            `    │   recent form (${teamLabel}), BSA only: ${wins}W ${draws}D ${losses}L in the last ${entry.recentForm.matches.length}`,
          );
          for (const match of entry.recentForm.matches) {
            lines.push(`    │   ${formatTeamFormMatchLine(match, teamLabel, teams)}`);
          }
          if (entry.recentForm.otherCompetitionMatch !== null) {
            lines.push(
              `    │   outside BSA: ${formatTeamFormMatchLine(entry.recentForm.otherCompetitionMatch, teamLabel, teams)}   ${entry.recentForm.otherCompetitionMatch.competition.name}`,
            );
          } else {
            lines.push("    │   outside BSA: none");
          }
        }
        lines.push("    │");
        break;
      }

      case "search_vector_context": {
        embeddingCalls += 1;

        // attempt === 1 is the fan-out's own search — it prints inside that block,
        // exactly as before task 06. Every retry after a rewrite (attempt > 1) never ran
        // in parallel with fetch_facts_api, so it gets its own numbered step instead.
        if (entry.attempt === 1) {
          fanOutMs = Math.max(fanOutMs, entry.ms);
          if (fanOutHeaderIndex >= 0) {
            lines[fanOutHeaderIndex] = `${lines[fanOutHeaderIndex]}    ${formatSeconds(fanOutMs)}`;
          }
          const waitedSuffix =
            entry.waitedForFactsMs > 0 ? `    (waited ${formatSeconds(entry.waitedForFactsMs)} for fetch_facts_api)` : "";
          lines.push(`    └── search_vector_context    ${entry.model}    ${formatSeconds(entry.ms)}${waitedSuffix}`);
          lines.push(`        filter: ${entry.filter !== null ? JSON.stringify(entry.filter) : "none"}`);
          pushSearchResultLines(lines, entry, "        ");
          lines.push("");
        } else {
          stepNumber += 1;
          lines.push(
            `[${stepNumber}] search_vector_context (attempt ${entry.attempt})    ${entry.model}    ${formatSeconds(entry.ms)}`,
          );
          lines.push(`    query: "${entry.query}"`);
          lines.push(`    filter: ${entry.filter !== null ? JSON.stringify(entry.filter) : "none"}`);
          pushSearchResultLines(lines, entry, "    ");
          lines.push("");
        }
        break;
      }

      case "grader": {
        stepNumber += 1;
        llmCalls += entry.grades.length;
        lines.push(
          `[${stepNumber}] grader    ${entry.model} ×${entry.grades.length} in parallel    ${formatSeconds(entry.ms)}    attempt ${entry.attempt}/${MAX_QUERY_REWRITES + 1}`,
        );
        if (entry.grades.length === 0) {
          lines.push(`    no passages judged   → ${entry.rewriting ? "rewriting the query" : "keeping this context"}`);
        } else {
          const ratioLabel = entry.approvedRatio === null ? "n/a" : entry.approvedRatio.toFixed(2);
          const comparison = entry.approvedRatio === null ? "" : entry.approvedRatio < entry.threshold ? "<" : ">=";
          const outcome = entry.rewriting ? "rewriting the query" : "keeping this context";
          lines.push(
            `    approved ${entry.approved} of ${entry.judged} judged   ratio ${ratioLabel} ${comparison} threshold ${entry.threshold.toFixed(2)}   → ${outcome}`,
          );
          for (const grade of entry.grades) {
            const mark = grade.relevant ? "✓" : "✗";
            lines.push(`    ${mark} ${grade.passageId}  "${grade.reason}"`);
          }
        }
        lines.push("");
        break;
      }

      case "queryRewrite": {
        stepNumber += 1;
        llmCalls += 1;
        lines.push(
          `[${stepNumber}] queryRewrite    ${entry.model}    ${formatSeconds(entry.ms)}    attempt ${entry.attempt}/${MAX_QUERY_REWRITES}`,
        );
        if (entry.error !== undefined) {
          lines.push(`    ERROR: ${entry.error}`);
        } else {
          lines.push(`    from: "${entry.previousQuery}"`);
          lines.push(`    to:   "${entry.newQuery}"`);
        }
        lines.push("");
        break;
      }

      case "writer": {
        stepNumber += 1;
        llmCalls += 1;
        lines.push(`[${stepNumber}] writer    ${entry.model}    ${formatSeconds(entry.ms)}`);
        lines.push("    allowed numbers: only the API facts above");
        lines.push(`    context from attempt ${entry.contextFromAttempt}`);
        const cited = entry.cited.length > 0 ? entry.cited.join(", ") : "none";
        const notCited =
          entry.retrievedNotCited.length > 0
            ? `   (retrieved but not cited: ${entry.retrievedNotCited.join(", ")})`
            : "";
        lines.push(`    cited: ${cited}${notCited}`);
        lines.push("");
        break;
      }

      case "critic": {
        stepNumber += 1;
        if (entry.model !== null) llmCalls += 1;
        const modelLabel = entry.model ?? "deterministic check";
        lines.push(`[${stepNumber}] critic    ${modelLabel}    ${formatSeconds(entry.ms)}`);

        if (entry.orphanNumbers.length === 0) {
          lines.push("    orphan numbers: none → answer unchanged");
          lines.push("");
          break;
        }

        const rewriteStatus = entry.rewritten
          ? `answer rewritten (${MAX_ANSWER_REWRITES} of ${MAX_ANSWER_REWRITES})`
          : "answer unchanged (critic call failed)";
        lines.push(`    orphan numbers found: ${entry.orphanNumbers.join(", ")}   → ${rewriteStatus}`);

        if (entry.previousAnswer !== null) {
          lines.push(`    before: "${truncate(entry.previousAnswer, 120)}"`);
        }

        if (entry.error !== undefined) {
          lines.push(`    ERROR: ${entry.error}`);
        } else if (entry.rewritten && entry.remainingOrphanNumbers.length === 0) {
          lines.push("    after the rewrite: clean");
        } else if (entry.redactedSentences.length > 0) {
          const sentenceWord = entry.redactedSentences.length === 1 ? "sentence" : "sentences";
          lines.push(
            `    after the rewrite: still orphan: ${entry.remainingOrphanNumbers.join(", ")}   → ${entry.redactedSentences.length} ${sentenceWord} removed (deterministic)`,
          );
          for (const sentence of entry.redactedSentences) {
            lines.push(`    removed: "${sentence.trim()}"`);
          }
        }
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

  // fetch_facts_api and search_vector_context's first attempt run inside the same
  // Promise.allSettled — summing every entry's ms would double-count that overlap, same
  // mistake the fan-out header avoided above with Math.max. A retry search (attempt > 1)
  // never runs in parallel with anything, so it's summed like any other sequential step.
  let totalMs = 0;
  let totalFanOutMs = 0;
  for (const entry of state.trace) {
    if (entry.node === "fetch_facts_api" || (entry.node === "search_vector_context" && entry.attempt === 1)) {
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
