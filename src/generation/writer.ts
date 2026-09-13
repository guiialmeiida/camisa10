import { MODELS } from "../config/models.ts";
import { callText } from "../agent/llm.ts";
import type { FinalState, StateWithData } from "../agent/state.ts";
import { COMPETITION } from "../sources/competition.ts";
import type { Match, Team } from "../sources/index.ts";
import type { MatchResult, TeamForm, TeamFormMatch } from "../sources/team-form.ts";
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
    '- <facts source="api">: números vindos de chamada direta à API (placar, rodada, data).',
    '- <context source="vector_index">: trechos de notícia, só para narrativa e explicação. Se um número aparecer aqui e contradisser os facts, os facts estão certos.',
    ...(state.plan.mode === "team_form"
      ? [
          '- <recent_form source="api">: o retrospecto recente do time no campeonato, mais a última partida dele fora desse campeonato, também de chamada direta à API (placar, data, vitória/empate/derrota).',
        ]
      : []),
    'Só os números que aparecem nas seções com source="api" podem entrar na resposta.',
    "Nunca escreva, na resposta, nenhum número (placar, gols, data) que venha do context — nem mesmo para apontar que ele diverge dos facts. Se um trecho do context contradisser os facts, mencione que existe essa divergência sem repetir o número errado (ex.: \"uma das fontes traz um placar diferente do oficial\"), e cite a fonte só se necessário.",
    "Toda afirmação que vier do context deve citar a fonte no formato [passageId].",
    "Se não houver context relevante, diga isso explicitamente e responda só com os facts.",
    ...(state.plan.mode === "current_matchweek"
      ? [
          "A pergunta é sobre a rodada em andamento: em texto corrido, fale primeiro do que já aconteceu (jogos com status finished ou live) e só depois do que ainda vai acontecer (scheduled/\"agendado\" ou postponed/\"adiado\"). Não crie seções, títulos nem listas do tipo \"Resultados\" e \"Próximos jogos\" — é um texto só.",
        ]
      : []),
    ...(state.plan.mode === "team_form"
      ? [
          "A pergunta é sobre a fase recente de um time: comece pelo retrospecto de <recent_form> (quantas vitórias, empates e derrotas, e os jogos que sustentam isso) e só depois explique o que está por trás dessa fase, usando o <context>. Em texto corrido, sem seções, títulos nem listas.",
          "O retrospecto de <recent_form> é só do campeonato. Se houver uma partida de outra competição listada, ela é informação extra: mencione-a, se ajudar, deixando claro que é de outra competição, e nunca a some ao número de vitórias, empates ou derrotas.",
        ]
      : []),
    "Responda em português, de forma direta.",
  ].join("\n");

  const user = [
    `Pergunta: ${state.question}`,
    "",
    buildFactsSection(state.facts),
    "",
    ...(state.plan.mode === "team_form"
      ? [buildRecentFormSection(state.recentForm, state.facts?.teams ?? []), ""]
      : []),
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

  if (match.status === "postponed") {
    return `${homeName} x ${awayName} — adiado — ${formattedDate}`;
  }

  const minuteSuffix = match.status === "live" && match.minute !== null ? ` (${match.minute}')` : "";
  return `${homeName} ${match.score.home} x ${match.score.away} ${awayName} — ${match.status}${minuteSuffix} — ${formattedDate}`;
}

const RESULT_PT: Record<MatchResult, string> = { win: "vitória", draw: "empate", loss: "derrota" };
const SIDE_PT: Record<TeamFormMatch["side"], string> = { home: "casa", away: "fora" };

/** Exported separately so it's testable without spending on the API. */
export function buildRecentFormSection(recentForm: TeamForm | null, teams: Team[]): string {
  if (recentForm === null) {
    return '<recent_form source="api">\n(não foi possível obter os últimos jogos do time — nenhum número de retrospecto disponível.)\n</recent_form>';
  }

  const teamLabel = teamName(recentForm.team, teams);
  const lines: string[] = [];

  if (recentForm.matches.length === 0) {
    lines.push("(nenhum jogo encerrado do campeonato encontrado para esse time.)");
  } else {
    const { wins, draws, losses } = recentForm.record;
    lines.push(
      `${teamLabel} — últimos ${recentForm.matches.length} jogos encerrados no ${COMPETITION.name}: ${wins}V ${draws}E ${losses}D`,
    );
    for (const match of recentForm.matches) {
      lines.push(formatTeamFormMatchLine(match, teamLabel, teams));
    }
  }

  // Independent of `matches`/`record` — a team can have one, both, or neither (spec §5).
  if (recentForm.otherCompetitionMatch !== null) {
    lines.push(
      `Fora do campeonato, partida mais recente: ${formatTeamFormMatchLine(recentForm.otherCompetitionMatch, teamLabel, teams)} — ${recentForm.otherCompetitionMatch.competition.name}`,
    );
  }

  return `<recent_form source="api">\n${lines.join("\n")}\n</recent_form>`;
}

function formatTeamFormMatchLine(match: TeamFormMatch, teamLabel: string, teams: Team[]): string {
  const opponentLabel = teamName(match.opponent, teams);
  const homeLabel = match.side === "home" ? teamLabel : opponentLabel;
  const awayLabel = match.side === "home" ? opponentLabel : teamLabel;
  const formattedDate = formatMatchDate(match.date);
  return `${formattedDate} — ${homeLabel} ${match.score.home} x ${match.score.away} ${awayLabel} — ${SIDE_PT[match.side]} — ${RESULT_PT[match.result]}`;
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

/** Exported separately so every condition (spec §6, §10) is testable without spending on the API. */
export function computeLowConfidence(state: Pick<StateWithData, "context" | "facts" | "plan" | "recentForm">): boolean {
  return (
    state.context.length === 0 ||
    state.facts === null ||
    (state.plan.mode === "team_form" && state.recentForm === null)
  );
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
