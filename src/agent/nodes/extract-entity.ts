import { z } from "zod";
import { MODELS } from "../../config/models.ts";
import { COMPETITION, listTeams } from "../../sources/index.ts";
import { callStructured } from "../llm.ts";
import type { Entity, InitialState, StateWithEntity } from "../state.ts";

export const entitySchema = z.strictObject({
  team: z.string().nullable(),
  competition: z.string().nullable(),
  matchweek: z.number().int().positive().nullable(),
  confidence: z.enum(["high", "low"]),
});

// Compile-time check: z.infer<typeof entitySchema> must not diverge from Entity.
// If someone edits one without the other, this line stops compiling.
type EntityFromSchema = z.infer<typeof entitySchema>;
({} as EntityFromSchema) satisfies Entity;

export async function extractEntity(state: InitialState): Promise<StateWithEntity> {
  // listTeams()/COMPETITION are local and static (src/sources/teams.json,
  // src/sources/competition.ts) — calling getFacts({}) here just to build this prompt
  // would cost a real network round-trip to football-data.org per question, for a list
  // of ~20 teams that never changes mid-process.
  const teams = await listTeams();

  const teamsList = teams
    .map((team) => `- id: ${team.id}, name: ${team.name}, nicknames: ${team.nicknames.join(", ")}`)
    .join("\n");

  const system = [
    "Você extrai entidades de perguntas sobre futebol brasileiro.",
    "Identifique o time perguntado, a competição e a rodada, quando mencionados.",
    "O campo `team` deve ser o id de um time conhecido — nunca o apelido nem o nome completo.",
    "Times conhecidos (id, nome, apelidos):",
    teamsList,
    'Se não reconhecer o time com segurança, devolva team: null e confidence: "low".',
    `A única competição conhecida é "${COMPETITION.id}" (${COMPETITION.name}). Use esse id quando a pergunta for sobre ela; devolva competition: null se a pergunta não mencionar competição nenhuma ou mencionar outra.`,
  ].join("\n");

  const entity = await callStructured({
    config: MODELS.entityExtraction,
    system,
    user: state.question,
    schema: entitySchema,
    schemaName: "entity",
  });

  return { ...state, entity };
}
