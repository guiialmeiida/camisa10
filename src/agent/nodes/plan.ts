import { z } from "zod";
import { MODELS } from "../../config/models.ts";
import { callStructured } from "../llm.ts";
import type { Plan, StateWithEntity, StateWithPlan } from "../state.ts";

export const planSchema = z.strictObject({
  mode: z.enum(["current_matchweek", "team_form"]),
  tools: z.array(z.enum(["fetch_facts_api", "search_vector_context"])),
  searchQuery: z.string().min(1),
  rationale: z.string().min(1), // one sentence, shows up in the trace
});

// Compile-time check: z.infer<typeof planSchema> must not diverge from Plan.
type PlanFromSchema = z.infer<typeof planSchema>;
({} as PlanFromSchema) satisfies Plan;

/**
 * In this task `tools` almost always brings both — and that's fine: this node's value
 * is `searchQuery` (the question rewritten for semantic search) and `mode`, which
 * tasks 04/05 use to pick filter and weights. If the planner returns an empty list,
 * `answer` (in graph.ts) forces `["fetch_facts_api"]` and records that in the trace.
 */
export async function plan(state: StateWithEntity): Promise<StateWithPlan> {
  const system = [
    "Você planeja como responder uma pergunta sobre futebol brasileiro.",
    "Modos possíveis:",
    "- current_matchweek: a pergunta é sobre a rodada em andamento (o que aconteceu, o que vai acontecer).",
    "- team_form: a pergunta é sobre a fase recente de um time específico.",
    "Ferramentas disponíveis: fetch_facts_api (placar e dados exatos, sem LLM) e search_vector_context (busca semântica em notícias).",
    "searchQuery é uma reescrita da pergunta, otimizada para busca semântica — não a pergunta literal.",
    "rationale é uma frase curta explicando a escolha do modo.",
  ].join("\n");

  const user = [
    `Pergunta: ${state.question}`,
    `Entidade extraída: team=${state.entity.team ?? "null"}, competition=${state.entity.competition ?? "null"}, matchweek=${state.entity.matchweek ?? "null"}, confidence=${state.entity.confidence}`,
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
