import { z } from "zod";
import { MODELS } from "../../config/models.ts";
import type { SearchResult } from "../../vectorstore/types.ts";
import { callStructured } from "../llm.ts";

/** Below this ratio of approved passages the query gets rewritten (spec §5). */
export const GRADER_APPROVAL_THRESHOLD = 0.4;
/** Ceiling of decision 7 in docs/architecture.md: at most 2 rewrites, so at most 3 searches. */
export const MAX_QUERY_REWRITES = 2;

export const passageGradeSchema = z.strictObject({
  relevant: z.boolean(),
  /** One short sentence, in Portuguese — it shows up in the trace, like plan.rationale. */
  reason: z.string().min(1),
});

export interface PassageGrade {
  passageId: string;
  chunkIndex: number;
  relevant: boolean;
  reason: string;
  /** Set when the grader call itself failed. In that case `relevant` is true: an infra
   *  failure never silently drops a passage the search did retrieve. */
  error?: string;
}

export interface GradeOutcome {
  /** One per input result, in the same order — length always equals results.length. */
  grades: PassageGrade[];
  /** What the writer gets: every result whose grade came back `relevant`, plus the ones
   *  whose grader call failed. Same relative order as the input. */
  approved: SearchResult[];
  /** How many grader calls actually answered. Failures don't count. */
  judged: number;
  /** approved-among-judged / judged. `null` when judged === 0 — nothing was judged, so
   *  there is no evidence either way about the query. */
  approvedRatio: number | null;
}

const GRADER_SYSTEM = [
  "Você avalia se um trecho de notícia ajuda a responder uma pergunta sobre futebol brasileiro.",
  "Responda relevant: true se o trecho traz contexto, narrativa ou explicação útil para a pergunta.",
  "Responda relevant: false se ele é sobre outro assunto, outro jogo ou outro time, ou se é só ruído",
  "(nota de bilheteria, tabela de transmissão, chamada para outra matéria).",
  "Julgue RELEVÂNCIA, não correção: um trecho que fala do jogo certo continua sendo relevante mesmo",
  "que os números dele estejam errados — conferir número é trabalho de outra etapa.",
  "reason é uma frase curta dizendo por quê.",
].join("\n");

function buildGraderUser(question: string, result: SearchResult): string {
  return [
    `Pergunta: ${question}`,
    `[${result.payload.passageId}] (${result.payload.type}, ${result.payload.source}) ${result.payload.title}: ${result.payload.text}`,
  ].join("\n");
}

async function gradeOne(question: string, result: SearchResult): Promise<PassageGrade> {
  try {
    const grade = await callStructured({
      config: MODELS.grader,
      system: GRADER_SYSTEM,
      user: buildGraderUser(question, result),
      schema: passageGradeSchema,
      schemaName: "passageGrade",
    });
    return {
      passageId: result.payload.passageId,
      chunkIndex: result.payload.chunkIndex,
      relevant: grade.relevant,
      reason: grade.reason,
    };
  } catch (error) {
    // A failed grader call never drops a passage the search did retrieve — see the
    // PassageGrade.error doc.
    return {
      passageId: result.payload.passageId,
      chunkIndex: result.payload.chunkIndex,
      relevant: true,
      reason: "grader call failed — kept by default",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Judges each retrieved passage against the question, one call per passage, all in parallel.
 * Never rejects: a failed call becomes a kept passage with `error` set.
 */
export async function gradePassages(params: { question: string; results: SearchResult[] }): Promise<GradeOutcome> {
  const grades = await Promise.all(params.results.map((result) => gradeOne(params.question, result)));

  const approved = params.results.filter((_, index) => grades[index]?.relevant ?? false);

  const judgedGrades = grades.filter((grade) => grade.error === undefined);
  const judged = judgedGrades.length;
  const approvedAmongJudged = judgedGrades.filter((grade) => grade.relevant).length;
  const approvedRatio = judged === 0 ? null : approvedAmongJudged / judged;

  return { grades, approved, judged, approvedRatio };
}

/** The rewrite trigger (discovery, item 3). Pure — no LLM, no I/O. */
export function shouldRewriteQuery(outcome: GradeOutcome): boolean {
  if (outcome.grades.length === 0) return true;
  if (outcome.approvedRatio === null) return false;
  return outcome.approvedRatio < GRADER_APPROVAL_THRESHOLD;
}

/** The one-line summary that goes into the rewrite prompt and into the trace. */
export function summarizeRejections(outcome: GradeOutcome): { passageId: string; reason: string }[] {
  return outcome.grades
    .filter((grade) => !grade.relevant)
    .map((grade) => ({ passageId: grade.passageId, reason: grade.reason }));
}
