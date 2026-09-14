import { MODELS } from "../../config/models.ts";
import { buildFactsSection, buildRecentFormSection, computeLowConfidence, extractCitations } from "../../generation/writer.ts";
import { isoDateParts } from "../../generation/match-format.ts";
import type { FinalState, StateWithData } from "../state.ts";
import { callText } from "../llm.ts";

/** Ceiling of decision 7 in docs/architecture.md: the model gets exactly one shot at fixing
 *  the answer; after that the fix is deterministic (spec §9). */
export const MAX_ANSWER_REWRITES = 1;

/** The sentence that replaces an answer whose every sentence had to go. */
export const REDACTED_ANSWER_NOTICE =
  "Não consegui responder com números confirmados pela API: toda a resposta gerada dependia de números sem confirmação nos dados oficiais, e foi removida.";
/** Appended to a partially redacted answer. */
export const REDACTION_NOTICE =
  "(Uma ou mais afirmações foram removidas desta resposta: continham números sem confirmação nos dados oficiais da API.)";

/** Every digit-sequence in `text`, read as a number, in order of appearance. */
function extractNumbers(text: string): number[] {
  return [...text.matchAll(/\d+/g)].map((match) => Number(match[0]));
}

/**
 * Every number the api-sourced sections of the prompt legitimately render (discovery, item 2).
 * Pure: no LLM, no I/O, no clock.
 */
export function allowedNumbers(state: Pick<StateWithData, "facts" | "recentForm">): Set<number> {
  const allowed = new Set<number>();

  if (state.facts !== null) {
    allowed.add(state.facts.matchweek);
    allowed.add(state.facts.competition.season);
    for (const number of extractNumbers(state.facts.competition.name)) {
      allowed.add(number);
    }

    for (const match of state.facts.matches) {
      // Reads the day/month straight off the ISO string's digits, exactly like
      // formatMatchDate does — never new Date(...).getDate(), which depends on the
      // host's timezone (the bug task 00's review fixed in production code).
      const { day, month } = isoDateParts(match.date);
      allowed.add(day);
      allowed.add(month);

      if (match.status === "finished" || match.status === "live") {
        allowed.add(match.score.home);
        allowed.add(match.score.away);
        if (match.status === "live" && match.minute !== null) {
          allowed.add(match.minute);
        }
      }
    }
  }

  if (state.recentForm !== null) {
    allowed.add(state.recentForm.matches.length);
    allowed.add(state.recentForm.record.wins);
    allowed.add(state.recentForm.record.draws);
    allowed.add(state.recentForm.record.losses);

    for (const match of state.recentForm.matches) {
      const { day, month } = isoDateParts(match.date);
      allowed.add(day);
      allowed.add(month);
      allowed.add(match.score.home);
      allowed.add(match.score.away);
    }

    if (state.recentForm.otherCompetitionMatch !== null) {
      const match = state.recentForm.otherCompetitionMatch;
      const { day, month } = isoDateParts(match.date);
      allowed.add(day);
      allowed.add(month);
      allowed.add(match.score.home);
      allowed.add(match.score.away);
      for (const number of extractNumbers(match.competition.name)) {
        allowed.add(number);
      }
    }
  }

  return allowed;
}

/**
 * The numbers in `text` that are in no way backed by the API. Citations are stripped first —
 * the digits in `[p07]` belong to a passage id, not to a fact.
 */
export function findOrphanNumbers(text: string, allowed: Set<number>): number[] {
  const withoutCitations = text.replace(/\[[a-zA-Z0-9]+\]/g, "");
  const seen = new Set<number>();
  const orphans: number[] = [];

  for (const number of extractNumbers(withoutCitations)) {
    if (allowed.has(number) || seen.has(number)) continue;
    seen.add(number);
    orphans.push(number);
  }

  return orphans;
}

export interface RedactionResult {
  text: string;
  /** The sentences that were dropped, verbatim — the trace prints them. */
  removedSentences: string[];
}

// A "." only ends a sentence when it isn't a thousands separator — a "." with a digit on
// both sides ("1.500") is folded into the sentence body instead, so segmentation can't cut
// a number in half. Not a full sentence tokenizer, just enough to not mutilate a number.
const SENTENCE_UNIT = "(?:(?<=\\d)\\.(?=\\d)|[^.!?…])";
const SENTENCE_SLICE_PATTERN = new RegExp(`${SENTENCE_UNIT}+[.!?…]+\\s*|${SENTENCE_UNIT}+$`, "g");

/** Deterministic, no LLM: drops every sentence that carries an orphan number. */
export function redactOrphanSentences(text: string, orphans: number[]): RedactionResult {
  if (orphans.length === 0) {
    return { text, removedSentences: [] };
  }

  const orphanSet = new Set(orphans);
  // Each slice carries its own trailing punctuation and whitespace, so joining every
  // slice back together reproduces the input exactly — no lost line break, no doubled
  // space, when a slice is dropped.
  const slices = text.match(SENTENCE_SLICE_PATTERN) ?? [];

  const kept: string[] = [];
  const removed: string[] = [];

  for (const slice of slices) {
    const withoutCitations = slice.replace(/\[[a-zA-Z0-9]+\]/g, "");
    const numbers = extractNumbers(withoutCitations);
    const hasOrphan = numbers.some((number) => orphanSet.has(number));
    if (hasOrphan) {
      removed.push(slice);
    } else {
      kept.push(slice);
    }
  }

  // Nothing was actually removed (a caller passing an `orphans` number that appears in
  // none of `text`'s sentences): return the input untouched, no notice. Warning about a
  // removal that didn't happen would be its own false claim.
  if (removed.length === 0) {
    return { text, removedSentences: [] };
  }

  const survivors = kept.join("").trim();

  if (survivors.length === 0) {
    return { text: REDACTED_ANSWER_NOTICE, removedSentences: removed };
  }

  return { text: `${survivors} ${REDACTION_NOTICE}`, removedSentences: removed };
}

export interface CriticReport {
  /** What the deterministic check found on the answer the writer produced. */
  orphanNumbers: number[];
  /** Whether the model was called at all. False on the happy path. */
  rewritten: boolean;
  /** What the deterministic check found on the rewritten answer. [] when it wasn't needed. */
  remainingOrphanNumbers: number[];
  /** The sentences the deterministic redaction removed at the ceiling. [] otherwise. */
  redactedSentences: string[];
  /** The answer before the rewrite. null when there was no rewrite. */
  previousAnswer: string | null;
  /** The critic call itself failed — the one allowed rewrite is spent either way, so the
   *  deterministic redaction still runs on the original answer (same as a rewrite that ran
   *  and still left an orphan number); `redactedSentences` may be non-empty here too. */
  error?: string;
}

const CRITIC_SYSTEM = [
  "Você revisa uma resposta sobre futebol brasileiro que contém números sem lastro nos dados oficiais.",
  "Reescreva a resposta removendo ou generalizando TODA afirmação que dependa de um número da lista de números sem lastro. Os únicos números que podem aparecer no texto corrigido são os da lista de números permitidos.",
  "Preserve o resto: o sentido, o tom, o idioma e as citações [passageId] das frases que ficarem.",
  "Nunca invente número, nunca troque um número errado por outro.",
  "Devolva apenas o texto corrigido, sem comentário, sem explicação e sem marcação.",
].join("\n");

/**
 * Only the source="api" sections — never the vector-index <context>, which is exactly the
 * source of the numbers being removed (spec §12).
 */
function buildCriticUser(state: FinalState, allowed: Set<number>, orphans: number[]): string {
  const sortedAllowed = [...allowed].sort((a, b) => a - b);

  return [
    `Pergunta: ${state.question}`,
    "",
    buildFactsSection(state.facts),
    ...(state.plan.mode === "team_form" ? [buildRecentFormSection(state.recentForm, state.facts?.teams ?? [])] : []),
    "",
    `Números permitidos: ${sortedAllowed.join(", ")}`,
    `Números sem lastro encontrados na resposta: ${orphans.join(", ")}`,
    "",
    "Resposta a corrigir:",
    `<answer>${state.answer.text}</answer>`,
  ].join("\n");
}

/**
 * Loop 2 (self-check): deterministic check first, model only to fix what it flagged.
 * Returns the state to hand back to the CLI plus the report the graph turns into a trace entry.
 */
export async function critique(state: FinalState): Promise<{ state: FinalState; report: CriticReport }> {
  const allowed = allowedNumbers(state);
  const orphans = findOrphanNumbers(state.answer.text, allowed);

  if (orphans.length === 0) {
    return {
      state,
      report: {
        orphanNumbers: [],
        rewritten: false,
        remainingOrphanNumbers: [],
        redactedSentences: [],
        previousAnswer: null,
      },
    };
  }

  const retrievedIds = new Set(state.context.map((result) => result.payload.passageId));

  let rewrittenText: string;
  let callError: string | undefined;
  try {
    rewrittenText = await callText({
      config: MODELS.critic,
      system: CRITIC_SYSTEM,
      user: buildCriticUser(state, allowed, orphans),
    });
  } catch (error) {
    // The critic call failing is treated exactly like the one allowed rewrite having run
    // and still left an orphan number: it falls through to the same deterministic
    // redaction below (MAX_ANSWER_REWRITES is spent either way), instead of shipping the
    // original answer with its orphan number untouched. `error` on the report is what
    // distinguishes this from the "rewrite ran but didn't fix it" case in the trace.
    rewrittenText = state.answer.text;
    callError = error instanceof Error ? error.message : String(error);
  }

  // Recalculated, not inherited: the rewrite may have dropped the sentence that carried
  // a citation, and a source list that no longer appears in the text is a trace that lies.
  const citedPassages = extractCitations(rewrittenText, retrievedIds);
  const remaining = findOrphanNumbers(rewrittenText, allowed);

  if (remaining.length === 0 && callError === undefined) {
    return {
      state: {
        ...state,
        answer: { text: rewrittenText, citedPassages, lowConfidence: computeLowConfidence(state) },
      },
      report: {
        orphanNumbers: orphans,
        rewritten: true,
        remainingOrphanNumbers: [],
        redactedSentences: [],
        previousAnswer: state.answer.text,
      },
    };
  }

  // Either the rewrite ran and still left an orphan number, or the call itself failed
  // (callError set, rewrittenText === the original answer) — both converge here: the one
  // allowed rewrite is spent, so what's left is redacted deterministically.
  const redaction = redactOrphanSentences(rewrittenText, remaining);
  const finalCitedPassages = extractCitations(redaction.text, retrievedIds);

  return {
    state: {
      ...state,
      answer: { text: redaction.text, citedPassages: finalCitedPassages, lowConfidence: true },
    },
    report: {
      orphanNumbers: orphans,
      rewritten: callError === undefined,
      remainingOrphanNumbers: remaining,
      redactedSentences: redaction.removedSentences,
      previousAnswer: state.answer.text,
      ...(callError !== undefined ? { error: callError } : {}),
    },
  };
}
