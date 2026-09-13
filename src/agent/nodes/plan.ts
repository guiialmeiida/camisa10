import { z } from "zod";
import { MODELS } from "../../config/models.ts";
import { callStructured } from "../llm.ts";
import type { Plan, StateWithEntity, StateWithPlan } from "../state.ts";
import { MAX_QUERY_REWRITES } from "./grade.ts";

export const planSchema = z.strictObject({
  mode: z.enum(["current_matchweek", "team_form"]),
  tools: z.array(z.enum(["fetch_facts_api", "search_vector_context"])),
  searchQuery: z.string().min(1),
  rationale: z.string().min(1), // one sentence, shows up in the trace
});

// Compile-time check: z.infer<typeof planSchema> must not diverge from Plan.
type PlanFromSchema = z.infer<typeof planSchema>;
({} as PlanFromSchema) satisfies Plan;

export interface QueryRewriteContext {
  /** The searchQuery that produced the rejected passages. */
  previousQuery: string;
  /** Which passages the grader rejected, and why — this is what makes the rewrite
   *  *corrective* instead of a second guess at the same question. Empty when the search
   *  returned nothing at all. */
  rejected: { passageId: string; reason: string }[];
  /** 1-based; MAX_QUERY_REWRITES is the ceiling. Goes in the prompt so the model knows it
   *  is already on a retry. */
  attempt: number;
}

/**
 * In this task `tools` almost always brings both — and that's fine: this node's value
 * is `searchQuery` (the question rewritten for semantic search) and `mode`, which
 * tasks 04/05 use to pick filter and weights. If the planner returns an empty list,
 * `answer` (in graph.ts) forces `["fetch_facts_api"]` and records that in the trace.
 *
 * `rewrite`, when present, is the grading loop asking for a corrected searchQuery
 * (task 06, spec §5) — the graph only ever reuses the new searchQuery, never `mode` or
 * `tools`, so those two params don't change this node's behavior on their own.
 */
export async function plan(state: StateWithEntity, rewrite?: QueryRewriteContext): Promise<StateWithPlan> {
  const system = [
    "Você planeja como responder uma pergunta sobre futebol brasileiro.",
    "Modos possíveis:",
    "- current_matchweek: a pergunta é sobre a rodada em andamento (o que aconteceu, o que vai acontecer).",
    "- team_form: a pergunta é sobre a fase recente de um time específico.",
    "Ferramentas disponíveis: fetch_facts_api (placar e dados exatos, sem LLM) e search_vector_context (busca semântica em notícias).",
    "searchQuery é uma reescrita da pergunta, otimizada para busca semântica — não a pergunta literal.",
    "rationale é uma frase curta explicando a escolha do modo.",
    ...(rewrite !== undefined
      ? [
          "Esta é uma REESCRITA: a busca anterior trouxe trechos que um avaliador considerou irrelevantes.",
          "Mantenha o mesmo mode e as mesmas tools — mude apenas o searchQuery.",
          "O novo searchQuery tem de ser realmente diferente do anterior: troque os termos, generalize ou",
          "especifique. Reordenar as mesmas palavras não muda a busca vetorial.",
        ]
      : []),
  ].join("\n");

  const user = [
    `Pergunta: ${state.question}`,
    `Entidade extraída: team=${state.entity.team ?? "null"}, competition=${state.entity.competition ?? "null"}, matchweek=${state.entity.matchweek ?? "null"}, confidence=${state.entity.confidence}`,
    ...(rewrite !== undefined
      ? [
          "",
          `Busca anterior: "${rewrite.previousQuery}"`,
          rewrite.rejected.length > 0
            ? [
                "Trechos reprovados pelo avaliador:",
                ...rewrite.rejected.map((r) => `- [${r.passageId}] ${r.reason}`),
              ].join("\n")
            : "A busca anterior não recuperou nenhum trecho.",
          `Tentativa de reescrita: ${rewrite.attempt} de ${MAX_QUERY_REWRITES}`,
        ]
      : []),
  ].join("\n");

  const rawPlan = await callStructured({
    config: MODELS.planner,
    system,
    user,
    schema: planSchema,
    schemaName: "plan",
  });

  return { ...state, plan: rawPlan };
}
