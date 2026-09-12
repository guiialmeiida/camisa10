import { describe, expect, it } from "vitest";
import { formatTrace } from "../src/agent/trace.ts";
import type { TraceEntry } from "../src/agent/trace.ts";
import type { FinalState } from "../src/agent/state.ts";
import type { PassagePayload } from "../src/vectorstore/types.ts";

function buildFinalState(trace: TraceEntry[], overrides: Partial<FinalState> = {}): FinalState {
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
    ...overrides,
  };
}

function samplePayload(
  passageId: string,
  type: PassagePayload["type"] = "article",
  chunk: { chunkIndex: number; chunkCount: number } = { chunkIndex: 0, chunkCount: 1 },
): PassagePayload {
  return {
    passageId,
    contentHash: "0".repeat(40),
    chunkIndex: chunk.chunkIndex,
    chunkCount: chunk.chunkCount,
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
        collection: "camisa10",
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
    expect(output).toContain("k=5 over 14 points in collection camisa10");
    expect(output).toMatch(/total:.*LLM calls.*embedding call/);
  });

  it("prints the real collection name instead of a hardcoded one", () => {
    const trace: TraceEntry[] = [
      {
        node: "search_vector_context",
        model: "voyage-3.5",
        ms: 100,
        k: 5,
        collection: "camisa10-dev",
        collectionSize: 14,
        results: [{ id: 1, score: 0.5, payload: samplePayload("p01") }],
      },
    ];

    expect(formatTrace(buildFinalState(trace))).toContain("in collection camisa10-dev");
  });

  it("prints the real facts source instead of a hardcoded 'fixture'", () => {
    const trace: TraceEntry[] = [
      {
        node: "fetch_facts_api",
        model: null,
        ms: 5,
        facts: {
          competition: { id: "brasileirao-serie-a", name: "Brasileirão Série A", season: 2026 },
          matchweek: 12,
          matches: [],
          teams: [],
          source: "api",
        },
      },
    ];

    expect(formatTrace(buildFinalState(trace))).toContain("source: api");
  });

  it("says '1 LLM call' in the singular", () => {
    const trace: TraceEntry[] = [
      { node: "entityExtraction", model: "claude-haiku-4-5", ms: 100, entity: { team: null, competition: null, matchweek: null, confidence: "low" } },
    ];

    expect(formatTrace(buildFinalState(trace))).toContain("1 LLM call ·");
  });

  it("does not double-count the fan-out's parallel time in the total", () => {
    const trace: TraceEntry[] = [
      {
        node: "fetch_facts_api",
        model: null,
        ms: 800,
        facts: {
          competition: { id: "brasileirao-serie-a", name: "Brasileirão Série A", season: 2026 },
          matchweek: 12,
          matches: [],
          teams: [],
          source: "fixture",
        },
      },
      {
        node: "search_vector_context",
        model: "voyage-3.5",
        ms: 300,
        k: 5,
        collection: "camisa10",
        collectionSize: 14,
        results: [],
      },
    ];

    // Sequential ms would be 800 + 300 = 1100ms; the two ran in parallel, so the
    // total must reflect the slower of the two (800ms), not their sum.
    expect(formatTrace(buildFinalState(trace))).toContain("total: 0.80s");
  });

  it("says which condition caused low confidence instead of a fixed wrong message", () => {
    const missingFactsOnly = formatTrace(
      buildFinalState([], {
        facts: null,
        context: [{ id: 1, score: 0.5, payload: samplePayload("p01") }],
        answer: { text: "resposta", citedPassages: [], lowConfidence: true },
      }),
    );
    expect(missingFactsOnly).toContain("no API facts");
    expect(missingFactsOnly).not.toContain("no narrative context, API facts only");

    const missingContextOnly = formatTrace(
      buildFinalState([], {
        facts: {
          competition: { id: "brasileirao-serie-a", name: "Brasileirão Série A", season: 2026 },
          matchweek: 12,
          matches: [],
          teams: [],
          source: "fixture",
        },
        context: [],
        answer: { text: "resposta", citedPassages: [], lowConfidence: true },
      }),
    );
    expect(missingContextOnly).toContain("no narrative context, API facts only");
  });

  it("lists a retrieved passage that was not cited", () => {
    const trace: TraceEntry[] = [
      { node: "writer", model: "claude-opus-5 (effort high)", ms: 100, cited: ["p03"], retrievedNotCited: ["p07"] },
    ];

    const output = formatTrace(buildFinalState(trace));

    expect(output).toContain("retrieved but not cited");
    expect(output).toContain("p07");
  });

  it("does not print 'chunk' for a result whose chunkCount is 1 — the passage wasn't split", () => {
    const trace: TraceEntry[] = [
      {
        node: "search_vector_context",
        model: "voyage-3.5",
        ms: 100,
        k: 5,
        collection: "camisa10",
        collectionSize: 14,
        results: [{ id: 1, score: 0.5, payload: samplePayload("p01") }],
      },
    ];

    expect(formatTrace(buildFinalState(trace))).not.toContain("chunk");
  });

  it("prints 'chunk 2/4' for a result with chunkIndex: 1, chunkCount: 4", () => {
    const trace: TraceEntry[] = [
      {
        node: "search_vector_context",
        model: "voyage-3.5",
        ms: 100,
        k: 5,
        collection: "camisa10",
        collectionSize: 14,
        results: [
          { id: 1, score: 0.612, payload: samplePayload("p03", "matchReport", { chunkIndex: 1, chunkCount: 4 }) },
        ],
      },
    ];

    expect(formatTrace(buildFinalState(trace))).toContain("chunk 2/4");
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
