import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { searchContext } from "../../src/retrieval/search-context.ts";
import type { Mode } from "../../src/agent/state.ts";

export const evalQuestionSchema = z.strictObject({
  id: z.string().min(1),
  question: z.string().min(1),
  mode: z.enum(["current_matchweek", "team_form"]),
  expectedPassages: z.array(z.string().min(1)), // [] = control question
  why: z.string().min(1),
});

export type EvalQuestion = z.infer<typeof evalQuestionSchema>;

// Compile-time check: EvalQuestion["mode"] must not diverge from Mode.
const _modeCheck: Mode = "current_matchweek" as EvalQuestion["mode"];
void _modeCheck;

export interface QuestionRecall {
  id: string;
  expected: string[];
  retrieved: string[];
  hits: number;
  recall: number;
}

export interface RecallReport {
  k: number;
  recall: number;
  falsePositives: number;
  perQuestion: QuestionRecall[];
}

const QUESTIONS_PATH = path.join(import.meta.dirname, "questions.json");

async function loadQuestions(): Promise<EvalQuestion[]> {
  const raw = await readFile(QUESTIONS_PATH, "utf-8");
  const parsed = z.array(evalQuestionSchema).safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`invalid eval questions at ${QUESTIONS_PATH}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * recall_da_pergunta = |expected ∩ retrieved@k| / |expected|
 * recall@k           = macro average (per question, not per passage) of recall_da_pergunta
 *
 * Questions with expectedPassages: [] are excluded from that average and instead feed
 * `falsePositives` — the vector search always returns k results, that's the point; the
 * number is a reminder, not a grade.
 */
export async function measureRecall(options?: { k?: number | undefined }): Promise<RecallReport> {
  const k = options?.k ?? 5;
  const questions = await loadQuestions();

  const perQuestion: QuestionRecall[] = [];
  const recallScores: number[] = [];
  let falsePositives = 0;

  for (const question of questions) {
    // The raw question, not passed through the planner — this measures retrieval, not the LLM.
    const results = await searchContext({ query: question.question, k });
    const retrieved = results.map((result) => result.payload.passageId);

    if (question.expectedPassages.length === 0) {
      if (retrieved.length > 0) falsePositives += 1;
      perQuestion.push({ id: question.id, expected: [], retrieved, hits: 0, recall: 0 });
      continue;
    }

    const expected = new Set(question.expectedPassages);
    const hits = retrieved.filter((id) => expected.has(id)).length;
    const recall = hits / question.expectedPassages.length;

    recallScores.push(recall);
    perQuestion.push({ id: question.id, expected: question.expectedPassages, retrieved, hits, recall });
  }

  const recall =
    recallScores.length > 0 ? recallScores.reduce((sum, value) => sum + value, 0) / recallScores.length : 0;

  return { k, recall, falsePositives, perQuestion };
}
