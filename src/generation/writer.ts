import { MODELS } from "../config/models.ts";
import { callText } from "../agent/llm.ts";
import type { FinalState, StateWithData } from "../agent/state.ts";
import type { Match, Team } from "../sources/index.ts";
import type { SearchResult } from "../vectorstore/types.ts";
import { formatMatchDate, teamName } from "./match-format.ts";

export interface Prompt {
  system: string;
  user: string;
}

/** Exported separately so it's testable without spending on the API. */
export function buildPrompt(state: StateWithData): Prompt {
  const system = [
    "Você é um redator de respostas sobre futebol brasileiro.",
    "Duas seções de dados aparecem na mensagem do usuário:",
    '- <facts source="api">: os únicos números que você pode escrever na resposta (placar, rodada, data). Vieram de chamada direta à API.',
    '- <context source="vector_index">: trechos de notícia, só para narrativa e explicação. Se um número aparecer aqui e contradisser os facts, os facts estão certos.',
    "Nunca escreva, na resposta, nenhum número (placar, gols, data) que venha do context — nem mesmo para apontar que ele diverge dos facts. Se um trecho do context contradisser os facts, mencione que existe essa divergência sem repetir o número errado (ex.: \"uma das fontes traz um placar diferente do oficial\"), e cite a fonte só se necessário.",
    "Toda afirmação que vier do context deve citar a fonte no formato [passageId].",
    "Se não houver context relevante, diga isso explicitamente e responda só com os facts.",
    "Responda em português, de forma direta.",
  ].join("\n");

  const user = [
    `Pergunta: ${state.question}`,
    "",
    buildFactsSection(state.facts),
    "",
    buildContextSection(state.context),
  ].join("\n");

  return { system, user };
}

function buildFactsSection(facts: StateWithData["facts"]): string {
  if (!facts) {
    return '<facts source="api">\n(a chamada à API de fatos falhou — nenhum número disponível.)\n</facts>';
  }

  if (facts.matches.length === 0) {
    return `<facts source="api">\n(nenhum jogo encontrado para essa consulta na competição ${facts.competition.name}, rodada ${facts.matchweek}.)\n</facts>`;
  }

  const lines = facts.matches.map((match) => formatMatchLine(match, facts.teams));
  return `<facts source="api">\n${lines.join("\n")}\n</facts>`;
}

function formatMatchLine(match: Match, teams: Team[]): string {
  const homeName = teamName(match.homeTeam, teams);
  const awayName = teamName(match.awayTeam, teams);
  const formattedDate = formatMatchDate(match.date);

  if (match.status === "scheduled") {
    return `${homeName} x ${awayName} — agendado — ${formattedDate}`;
  }

  return `${homeName} ${match.score.home} x ${match.score.away} ${awayName} — ${match.status} — ${formattedDate}`;
}

function buildContextSection(context: SearchResult[]): string {
  if (context.length === 0) {
    return '<context source="vector_index">\n(nenhum trecho recuperado.)\n</context>';
  }

  const lines = context.map(
    (result) =>
      `[${result.payload.passageId}] (${result.payload.type}, ${result.payload.source}) ${result.payload.title}: ${result.payload.text}`,
  );

  return `<context source="vector_index">\n${lines.join("\n\n")}\n</context>`;
}

export async function write(state: StateWithData): Promise<FinalState> {
  const prompt = buildPrompt(state);
  const text = await callText({ config: MODELS.writer, system: prompt.system, user: prompt.user });

  const retrievedIds = new Set(state.context.map((result) => result.payload.passageId));
  const citedPassages = extractCitations(text, retrievedIds);
  const lowConfidence = computeLowConfidence(state);

  return { ...state, answer: { text, citedPassages, lowConfidence } };
}

/** Exported separately so both conditions (spec §6) are testable without spending on the API. */
export function computeLowConfidence(state: Pick<StateWithData, "context" | "facts">): boolean {
  return state.context.length === 0 || state.facts === null;
}

/** Exported separately so the discard-invalid-citation behavior (spec §6) is testable without spending on the API. */
export function extractCitations(text: string, retrievedIds: Set<string>): string[] {
  const cited = new Set<string>();
  for (const match of text.matchAll(/\[([a-zA-Z0-9]+)\]/g)) {
    const id = match[1];
    // A citation to a passage that wasn't retrieved is discarded rather than trusted —
    // the model doesn't get to invent a source.
    if (id !== undefined && retrievedIds.has(id)) {
      cited.add(id);
    }
  }
  return [...cited];
}
