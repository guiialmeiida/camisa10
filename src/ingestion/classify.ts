import { z } from "zod";
import { callStructured } from "../agent/llm.ts";
import { MODELS } from "../config/models.ts";
import type { Passage, PassageType } from "../sources/types.ts";

export const passageTypeClassificationSchema = z.strictObject({
  type: z.enum(["article", "chronicle", "matchReport", "preview"]),
});

// Compile-time check: z.infer<typeof passageTypeClassificationSchema>["type"] must not
// diverge from PassageType. If someone edits one without the other, this stops compiling.
type ClassificationTypeFromSchema = z.infer<typeof passageTypeClassificationSchema>["type"];
({} as ClassificationTypeFromSchema) satisfies PassageType;

export interface Classification {
  passageId: string;
  type: PassageType;
  /** true when the LLM call failed and "article" was used as the safe default. */
  fallback: boolean;
}

// 40 simultaneous calls against the Anthropic API is the easiest way to turn
// "ingestion" into "rate limit" — chunks of 5 sequential Promise.all instead.
const CLASSIFY_CONCURRENCY = 5;

// Genre is decided in the lead; the RSS text is already a summary, so truncating here
// caps cost without losing signal.
const TEXT_TRUNCATE_LENGTH = 1500;

const SYSTEM_PROMPT = [
  "Você classifica o gênero de uma matéria de futebol brasileiro em exatamente uma categoria.",
  "",
  '- "preview": publicado ANTES da partida — provável escalação, desfalques, expectativa, onde assistir.',
  '- "matchReport": relato FACTUAL de uma partida já disputada, sem opinião do autor — lances,',
  "  escalação, substituições, cartões. É quase uma súmula em prosa.",
  '- "chronicle": texto com ÂNGULO AUTORAL ou interpretativo, mesmo que seja sobre um jogo só —',
  '  crítica, análise, coluna assinada, "o técnico perdeu o vestiário", leitura sobre o momento do',
  '  time. O que separa de "matchReport" é o tom (opinativo vs. factual), não o assunto.',
  '- "article": qualquer outra notícia — contratação, lesão, bastidor, declaração, arbitragem, situação institucional. É a categoria padrão.',
  "",
  'Na dúvida entre duas categorias, responda "article".',
  "Não escreva placares, números nem trechos do texto: sua resposta é só a categoria.",
].join("\n");

function buildUserPrompt(passage: Passage): string {
  const text = passage.text.slice(0, TEXT_TRUNCATE_LENGTH);
  return [
    `título: ${passage.title}`,
    `fonte: ${passage.source}`,
    `publicado em: ${passage.publishedAt}`,
    "texto:",
    text,
  ].join("\n");
}

/** Never throws: an LLM failure becomes { type: "article", fallback: true } + a warn. */
export async function classifyPassageType(passage: Passage): Promise<Classification> {
  try {
    const result = await callStructured({
      config: MODELS.passageClassification,
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(passage),
      schema: passageTypeClassificationSchema,
      schemaName: "passageType",
    });

    return { passageId: passage.id, type: result.type, fallback: false };
  } catch (error) {
    console.warn(
      `classify.ts: classification failed for passage ${passage.id}, falling back to "article" — ${describeError(error)}`,
    );
    return { passageId: passage.id, type: "article", fallback: true };
  }
}

/** Same order as the input. Runs in chunks of CLASSIFY_CONCURRENCY. Never throws. */
export async function classifyPassageTypes(passages: Passage[]): Promise<Classification[]> {
  const results: Classification[] = [];

  for (let start = 0; start < passages.length; start += CLASSIFY_CONCURRENCY) {
    const chunk = passages.slice(start, start + CLASSIFY_CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map((passage) => classifyPassageType(passage)));
    results.push(...chunkResults);
  }

  return results;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
