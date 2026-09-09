import { describe, expect, it } from "vitest";
import { formatTrace } from "../src/agent/trace.ts";
import type { TraceEntry } from "../src/agent/trace.ts";
import type { FinalState } from "../src/agent/state.ts";
import type { PassagePayload } from "../src/vectorstore/types.ts";

function buildFinalState(trace: TraceEntry[]): FinalState {
  return {
    question: "o Palmeiras está numa fase ruim?",
    k: 5,
    trace,
    entity: { team: "palmeiras", competition: "brasileirao-serie-a", matchweek: 12, confidence: "high" },
    plan: {
      mode: "team_form",
      tools: ["fetch_facts_api", "search_vector_context"],
      searchQuery: "sequência recente do Palmeiras",
      rationale: "pergunta é sobre fase do time",
    },
    facts: null,
    context: [],
    answer: { text: "resposta de teste [p03]", citedPassages: ["p03"], lowConfidence: false },
  };
}

function samplePayload(passageId: string, type: PassagePayload["type"] = "article"): PassagePayload {
  return {
    passageId,
    text: `texto de ${passageId}`,
    title: `título de ${passageId}`,
    source: "Fixture Esportivo",
    url: `https://exemplo.invalido/fixture/${passageId}`,
    type,
    teams: ["palmeiras"],
    matchId: "m1",
    competition: "brasileirao-serie-a",
    matchweek: 12,
    publishedAt: "2026-09-06T08:00:00-03:00",
  };
}

describe("formatTrace", () => {
  it("prints the 4 nodes in order, the retrieved passages with score, and the total line", () => {
    const trace: TraceEntry[] = [
      {
        node: "entityExtraction",
        model: "claude-haiku-4-5",
        ms: 410,
        entity: { team: "palmeiras", competition: "brasileirao-serie-a", matchweek: 12, confidence: "high" },
      },
      {
        node: "planner",
        model: "claude-opus-5 (effort medium)",
        ms: 1920,
        plan: {
          mode: "team_form",
          tools: ["fetch_facts_api", "search_vector_context"],
          searchQuery: "sequência recente do Palmeiras",
          rationale: "pergunta é sobre fase do time",
        },
      },
      {
        node: "fetch_facts_api",
        model: null,
        ms: 5,
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
      },
      {
        node: "search_vector_context",
        model: "voyage-3.5",
        ms: 290,
        k: 5,
        collectionSize: 14,
        results: [
          { id: 3, score: 0.612, payload: samplePayload("p03") },
          { id: 14, score: 0.571, payload: samplePayload("p14") },
          { id: 6, score: 0.554, payload: samplePayload("p06") },
          { id: 7, score: 0.508, payload: samplePayload("p07", "chronicle") },
          { id: 2, score: 0.463, payload: samplePayload("p02") },
        ],
      },
      {
        node: "writer",
        model: "claude-opus-5 (effort high)",
        ms: 4080,
        cited: ["p03", "p06"],
        retrievedNotCited: ["p14", "p07", "p02"],
      },
    ];

    const output = formatTrace(buildFinalState(trace));

    expect(output).toContain("[1] entityExtraction");
    expect(output).toContain("[2] planner");
    expect(output).toContain("fan-out");
    expect(output).toContain("[4] writer");
    for (const id of ["p03", "p14", "p06", "p07", "p02"]) {
      expect(output).toContain(id);
    }
    expect(output).toContain("0.612");
    expect(output).toMatch(/total:.*LLM calls.*embedding call/);
  });

  it("lists a retrieved passage that was not cited", () => {
    const trace: TraceEntry[] = [
      { node: "writer", model: "claude-opus-5 (effort high)", ms: 100, cited: ["p03"], retrievedNotCited: ["p07"] },
    ];

    const output = formatTrace(buildFinalState(trace));

    expect(output).toContain("retrieved but not cited");
    expect(output).toContain("p07");
  });

  it("prints the failure instead of the matches when fetch_facts_api has an error", () => {
    const trace: TraceEntry[] = [
      { node: "fetch_facts_api", model: null, ms: 12, facts: null, error: "network timeout" },
    ];

    const output = formatTrace(buildFinalState(trace));

    expect(output).toContain("ERROR");
    expect(output).toContain("network timeout");
  });
});
