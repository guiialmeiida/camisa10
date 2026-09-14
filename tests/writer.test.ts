import { describe, expect, it } from "vitest";
import { buildPrompt, buildRecentFormSection, computeLowConfidence, extractCitations } from "../src/generation/writer.ts";
import type { StateWithData } from "../src/agent/state.ts";
import type { TeamForm } from "../src/sources/team-form.ts";

function buildState(overrides: Partial<StateWithData> = {}): StateWithData {
  const base: StateWithData = {
    question: "quanto foi Palmeiras x Fluminense na rodada 12?",
    k: 5,
    trace: [],
    entity: { team: "palmeiras", competition: "brasileirao-serie-a", matchweek: 12, confidence: "high" },
    plan: {
      mode: "current_matchweek",
      tools: ["fetch_facts_api", "search_vector_context"],
      searchQuery: "resultado Palmeiras Fluminense rodada 12",
      rationale: "pergunta sobre o resultado da rodada",
    },
    facts: {
      competition: { id: "brasileirao-serie-a", name: "Brasileirão Série A", season: 2026 },
      matchweek: 12,
      matches: [
        {
          id: "m1",
          matchweek: 12,
          date: "2026-09-05T21:30:00-03:00",
          status: "finished",
          homeTeam: "palmeiras",
          awayTeam: "fluminense",
          score: { home: 1, away: 3 },
          venue: "Allianz Parque",
        },
      ],
      teams: [
        { id: "palmeiras", name: "Palmeiras", nicknames: ["Verdão", "alviverde"] },
        { id: "fluminense", name: "Fluminense", nicknames: ["Tricolor das Laranjeiras", "Flu"] },
      ],
      source: "fixture",
    },
    context: [
      {
        id: 7,
        score: 0.5,
        payload: {
          passageId: "p07",
          contentHash: "0".repeat(40),
          chunkIndex: 0,
          chunkCount: 1,
          text: "Em uma tarde movimentada no Allianz Parque, o alviverde venceu por dois a zero em casa...",
          title: "Crônica: um duelo movimentado no Allianz Parque",
          source: "Fixture Esportivo",
          url: "https://exemplo.invalido/fixture/p07",
          type: "chronicle",
          teams: ["palmeiras", "fluminense"],
          matchId: "m1",
          competition: "brasileirao-serie-a",
          matchweek: 12,
          publishedAt: "2026-09-06T10:00:00-03:00",
        },
      },
    ],
    recentForm: null,
  };

  return { ...base, ...overrides };
}

function buildTeamForm(overrides: Partial<TeamForm> = {}): TeamForm {
  return {
    team: "palmeiras",
    matches: [
      {
        id: "545231",
        date: "2026-09-05T21:30:00-03:00",
        opponent: "fluminense",
        side: "home",
        score: { home: 1, away: 3 },
        result: "loss",
        competition: { code: "BSA", name: "Campeonato Brasileiro Série A" },
      },
      {
        id: "545210",
        date: "2026-08-31T17:00:00-03:00",
        opponent: "bahia",
        side: "away",
        score: { home: 0, away: 2 },
        result: "win",
        competition: { code: "BSA", name: "Campeonato Brasileiro Série A" },
      },
    ],
    otherCompetitionMatch: {
      id: "551004",
      date: "2026-09-03T20:30:00-03:00",
      opponent: "ca-river-plate",
      side: "home",
      score: { home: 2, away: 0 },
      result: "win",
      competition: { code: "CLI", name: "Copa Libertadores" },
    },
    record: { wins: 1, draws: 0, losses: 1 },
    source: "api",
    ...overrides,
  };
}

function extractSection(text: string, tag: "facts" | "context" | "recent_form"): string {
  const pattern =
    tag === "facts"
      ? /<facts source="api">([\s\S]*?)<\/facts>/
      : tag === "recent_form"
        ? /<recent_form source="api">([\s\S]*?)<\/recent_form>/
        : /<context source="vector_index">([\s\S]*?)<\/context>/;
  const match = text.match(pattern);
  if (!match?.[1]) throw new Error(`section ${tag} not found in prompt`);
  return match[1];
}

describe("buildPrompt", () => {
  it("includes the API score inside the facts section", () => {
    const prompt = buildPrompt(buildState());

    expect(extractSection(prompt.user, "facts")).toContain("1 x 3");
  });

  it("keeps the trap passage text only inside the context section", () => {
    const prompt = buildPrompt(buildState());

    expect(extractSection(prompt.user, "context")).toContain("dois a zero");
    expect(extractSection(prompt.user, "facts")).not.toContain("dois a zero");
  });

  it("instructs that API facts win over any number in the context", () => {
    const prompt = buildPrompt(buildState());

    expect(prompt.system).toMatch(/facts.*(certos|vencem|prevalecem)/i);
    expect(prompt.system.toLowerCase()).toContain("nunca escreva, na resposta, nenhum número");
  });

  it("instructs the writer not to derive new numbers (spec §10)", () => {
    const prompt = buildPrompt(buildState());

    expect(prompt.system.toLowerCase()).toContain("não calcule nem derive números novos");
  });

  it("asks for low confidence when context is empty", () => {
    const prompt = buildPrompt(buildState({ context: [] }));

    expect(prompt.user.toLowerCase()).toContain("nenhum trecho recuperado");
  });

  it("warns when facts is null", () => {
    const prompt = buildPrompt(buildState({ facts: null }));

    expect(prompt.user).toContain("a chamada à API de fatos falhou");
  });

  it("never renders chunkIndex or chunkCount — they're chunk position, not fact or narrative (spec §13)", () => {
    const prompt = buildPrompt(buildState());

    expect(prompt.user).not.toContain("chunkIndex");
    expect(prompt.user).not.toContain("chunkCount");
  });

  it("current_matchweek: instructs the writer to tell what already happened before what's next, with no fixed sections", () => {
    const prompt = buildPrompt(buildState({ plan: { ...buildState().plan, mode: "current_matchweek" } }));

    expect(prompt.system).toContain("finished ou live");
    expect(prompt.system).toContain("scheduled/\"agendado\"");
    expect(prompt.system).toContain("postponed/\"adiado\"");
    expect(prompt.system).toMatch(/não crie seções/i);
  });

  it("team_form: no current_matchweek instruction, but the retrospecto instruction and the recent_form section are present", () => {
    const prompt = buildPrompt(
      buildState({ plan: { ...buildState().plan, mode: "team_form" }, recentForm: buildTeamForm() }),
    );

    expect(prompt.system).not.toContain("finished ou live");
    expect(prompt.system).not.toMatch(/não crie seções/i);
    expect(prompt.system).toMatch(/comece pelo retrospecto/i);
    expect(prompt.system).toMatch(/nunca a some ao número de vitórias, empates ou derrotas/i);
    expect(prompt.user).toContain('<recent_form source="api">');
    expect(extractSection(prompt.user, "recent_form")).toContain("1V 0E 1D");
  });

  it("team_form: otherCompetitionMatch present adds the 'Fora do campeonato' line with the competition name", () => {
    const prompt = buildPrompt(
      buildState({ plan: { ...buildState().plan, mode: "team_form" }, recentForm: buildTeamForm() }),
    );

    const section = extractSection(prompt.user, "recent_form");
    expect(section).toContain("Fora do campeonato, partida mais recente:");
    expect(section).toContain("Copa Libertadores");
  });

  it("team_form: otherCompetitionMatch null omits the 'Fora do campeonato' line", () => {
    const prompt = buildPrompt(
      buildState({
        plan: { ...buildState().plan, mode: "team_form" },
        recentForm: buildTeamForm({ otherCompetitionMatch: null }),
      }),
    );

    expect(extractSection(prompt.user, "recent_form")).not.toContain("Fora do campeonato");
  });

  it("team_form: matches empty with otherCompetitionMatch present shows both the empty-record phrase and the other-competition line", () => {
    const prompt = buildPrompt(
      buildState({
        plan: { ...buildState().plan, mode: "team_form" },
        recentForm: buildTeamForm({ matches: [], record: { wins: 0, draws: 0, losses: 0 } }),
      }),
    );

    const section = extractSection(prompt.user, "recent_form");
    expect(section).toContain("nenhum jogo encerrado do campeonato");
    expect(section).toContain("Fora do campeonato, partida mais recente:");
  });

  it("team_form: recentForm null shows the unavailability phrase, and the section still appears", () => {
    const prompt = buildPrompt(buildState({ plan: { ...buildState().plan, mode: "team_form" }, recentForm: null }));

    expect(prompt.user).toContain('<recent_form source="api">');
    expect(extractSection(prompt.user, "recent_form")).toContain("não foi possível obter os últimos jogos");
  });

  it("current_matchweek: no <recent_form> section at all", () => {
    const prompt = buildPrompt(buildState({ recentForm: buildTeamForm() }));

    expect(prompt.user).not.toContain("<recent_form");
  });

  it("buildFactsSection keeps the matches in the order facts.matches returns them — no reordering", () => {
    const state = buildState({
      facts: {
        ...buildState().facts!,
        matches: [
          {
            id: "m2",
            matchweek: 12,
            date: "2026-09-08T20:00:00-03:00",
            status: "scheduled",
            homeTeam: "corinthians",
            awayTeam: "santos",
            score: null,
            venue: "Neo Química Arena",
          },
          {
            id: "m1",
            matchweek: 12,
            date: "2026-09-05T21:30:00-03:00",
            status: "finished",
            homeTeam: "palmeiras",
            awayTeam: "fluminense",
            score: { home: 1, away: 3 },
            venue: "Allianz Parque",
          },
        ],
      },
    });

    const factsSection = extractSection(buildPrompt(state).user, "facts");
    const scheduledIndex = factsSection.indexOf("agendado");
    const finishedIndex = factsSection.indexOf("finished");

    expect(scheduledIndex).toBeGreaterThanOrEqual(0);
    expect(finishedIndex).toBeGreaterThanOrEqual(0);
    expect(scheduledIndex).toBeLessThan(finishedIndex);
  });
});

describe("buildRecentFormSection", () => {
  const teams = [
    { id: "palmeiras", name: "Palmeiras", nicknames: [] },
    { id: "fluminense", name: "Fluminense", nicknames: [] },
    { id: "bahia", name: "Bahia", nicknames: [] },
  ];

  it("matches the spec §10 literal example", () => {
    // "CA River Plate" only renders with its full name when it's resolvable via `teams`
    // (teamName degrades to the raw slug otherwise, e.g. "ca-river-plate") — added here
    // to reproduce the spec's literal example faithfully.
    const teamsWithOpponent = [...teams, { id: "ca-river-plate", name: "CA River Plate", nicknames: [] }];
    const section = buildRecentFormSection(buildTeamForm(), teamsWithOpponent);

    expect(section).toContain("Palmeiras — últimos 2 jogos encerrados no Campeonato Brasileiro Série A: 1V 0E 1D");
    expect(section).toContain("05/09 — Palmeiras 1 x 3 Fluminense — casa — derrota");
    expect(section).toContain("31/08 — Bahia 0 x 2 Palmeiras — fora — vitória");
    expect(section).toContain(
      "Fora do campeonato, partida mais recente: 03/09 — Palmeiras 2 x 0 CA River Plate — casa — vitória — Copa Libertadores",
    );
  });

  it("recentForm null: the unavailability phrase", () => {
    expect(buildRecentFormSection(null, teams)).toContain("não foi possível obter os últimos jogos do time");
  });

  it("matches empty, no otherCompetitionMatch: only the empty-record phrase", () => {
    const section = buildRecentFormSection(
      { team: "palmeiras", matches: [], otherCompetitionMatch: null, record: { wins: 0, draws: 0, losses: 0 }, source: "api" },
      teams,
    );

    expect(section).toContain("nenhum jogo encerrado do campeonato encontrado para esse time");
    expect(section).not.toContain("Fora do campeonato");
  });
});

describe("extractCitations", () => {
  it("discards a citation to a passage that wasn't retrieved (spec §6)", () => {
    const retrievedIds = new Set(["p03"]);

    expect(extractCitations("resposta [p03] e também [p99]", retrievedIds)).toEqual(["p03"]);
  });

  it("dedupes repeated citations to the same passage", () => {
    const retrievedIds = new Set(["p03"]);

    expect(extractCitations("[p03] ... de novo [p03]", retrievedIds)).toEqual(["p03"]);
  });

  it("returns an empty list when nothing is cited", () => {
    expect(extractCitations("resposta sem citação nenhuma", new Set(["p03"]))).toEqual([]);
  });
});

describe("computeLowConfidence", () => {
  it("is true when context is empty, even with facts present", () => {
    const state = buildState();
    expect(computeLowConfidence({ context: [], facts: state.facts, plan: state.plan, recentForm: null })).toBe(true);
  });

  it("is true when facts is null, even with context present", () => {
    const state = buildState();
    expect(
      computeLowConfidence({ context: state.context, facts: null, plan: state.plan, recentForm: null }),
    ).toBe(true);
  });

  it("is false when both facts and context are present (current_matchweek, recentForm irrelevant)", () => {
    const state = buildState();
    expect(
      computeLowConfidence({ context: state.context, facts: state.facts, plan: state.plan, recentForm: null }),
    ).toBe(false);
  });

  it("is true in team_form when recentForm is null, even with context and facts present", () => {
    const state = buildState({ plan: { ...buildState().plan, mode: "team_form" } });
    expect(
      computeLowConfidence({ context: state.context, facts: state.facts, plan: state.plan, recentForm: null }),
    ).toBe(true);
  });

  it("is false in team_form when recentForm, context and facts are all present", () => {
    const state = buildState({ plan: { ...buildState().plan, mode: "team_form" } });
    expect(
      computeLowConfidence({
        context: state.context,
        facts: state.facts,
        plan: state.plan,
        recentForm: buildTeamForm(),
      }),
    ).toBe(false);
  });

  it("stays false in current_matchweek with recentForm null (unaffected by the new condition)", () => {
    const state = buildState();
    expect(state.plan.mode).toBe("current_matchweek");
    expect(
      computeLowConfidence({ context: state.context, facts: state.facts, plan: state.plan, recentForm: null }),
    ).toBe(false);
  });
});
