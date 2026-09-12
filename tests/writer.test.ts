import { describe, expect, it } from "vitest";
import { buildPrompt, computeLowConfidence, extractCitations } from "../src/generation/writer.ts";
import type { StateWithData } from "../src/agent/state.ts";

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
  };

  return { ...base, ...overrides };
}

function extractSection(text: string, tag: "facts" | "context"): string {
  const pattern =
    tag === "facts"
      ? /<facts source="api">([\s\S]*?)<\/facts>/
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
    expect(computeLowConfidence({ context: [], facts: buildState().facts })).toBe(true);
  });

  it("is true when facts is null, even with context present", () => {
    expect(computeLowConfidence({ context: buildState().context, facts: null })).toBe(true);
  });

  it("is false when both facts and context are present", () => {
    const state = buildState();
    expect(computeLowConfidence({ context: state.context, facts: state.facts })).toBe(false);
  });
});
