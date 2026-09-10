import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateWithPlan } from "../src/agent/state.ts";
import type { TraceEntry } from "../src/agent/trace.ts";
import type { PassagePayload } from "../src/vectorstore/types.ts";

vi.mock("../src/sources/index.ts", () => ({ getFacts: vi.fn() }));
vi.mock("../src/retrieval/search-context.ts", () => ({ searchContext: vi.fn() }));
vi.mock("../src/vectorstore/qdrant.ts", () => ({ countPoints: vi.fn() }));

const { getFacts } = await import("../src/sources/index.ts");
const { searchContext } = await import("../src/retrieval/search-context.ts");
const { countPoints } = await import("../src/vectorstore/qdrant.ts");
const { runFanOut } = await import("../src/agent/graph.ts");

const mockGetFacts = vi.mocked(getFacts);
const mockSearchContext = vi.mocked(searchContext);
const mockCountPoints = vi.mocked(countPoints);

const fakeEnv = {
  API_FUTEBOL_TOKEN: "fake-token",
  VOYAGE_API_KEY: "voyage-fake",
  ANTHROPIC_API_KEY: "sk-ant-fake",
  QDRANT_URL: "http://localhost:6333",
  QDRANT_COLLECTION: "camisa10-test",
};

function buildStateWithPlan(): StateWithPlan {
  return {
    question: "o Palmeiras está numa fase ruim?",
    k: 5,
    trace: [],
    entity: { team: "palmeiras", competition: "brasileirao-serie-a", matchweek: 12, confidence: "high" },
    plan: {
      mode: "team_form",
      tools: ["fetch_facts_api", "search_vector_context"],
      searchQuery: "sequência recente do Palmeiras",
      rationale: "pergunta é sobre fase do time",
    },
  };
}

function samplePayload(passageId: string): PassagePayload {
  return {
    passageId,
    text: `texto de ${passageId}`,
    title: `título de ${passageId}`,
    source: "Fixture Esportivo",
    url: `https://exemplo.invalido/fixture/${passageId}`,
    type: "article",
    teams: ["palmeiras"],
    matchId: "m1",
    competition: "brasileirao-serie-a",
    matchweek: 12,
    publishedAt: "2026-09-06T08:00:00-03:00",
  };
}

describe("runFanOut — spec §6: Promise.allSettled never aborts the graph", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...process.env, ...fakeEnv };
    mockGetFacts.mockReset();
    mockSearchContext.mockReset();
    mockCountPoints.mockReset();
    mockCountPoints.mockResolvedValue(14);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("keeps context and records the error when fetch_facts_api rejects", async () => {
    mockGetFacts.mockRejectedValue(new Error("API futebol 503"));
    const contextResult = [{ id: 1, score: 0.6, payload: samplePayload("p03") }];
    mockSearchContext.mockResolvedValue(contextResult);

    const trace: TraceEntry[] = [];
    const result = await runFanOut(buildStateWithPlan(), trace);

    expect(result.facts).toBeNull();
    expect(result.context).toBe(contextResult);

    const factsEntry = trace.find((entry) => entry.node === "fetch_facts_api");
    const contextEntry = trace.find((entry) => entry.node === "search_vector_context");
    expect(factsEntry?.error).toContain("API futebol 503");
    expect(contextEntry?.error).toBeUndefined();
  });

  it("keeps facts and records the error when search_vector_context rejects", async () => {
    const factsResult = {
      competition: { id: "brasileirao-serie-a", name: "Brasileirão Série A", season: 2026 },
      matchweek: 12,
      matches: [],
      teams: [],
      source: "fixture" as const,
    };
    mockGetFacts.mockResolvedValue(factsResult);
    mockSearchContext.mockRejectedValue(new Error("Voyage embeddings request failed: 429"));

    const trace: TraceEntry[] = [];
    const result = await runFanOut(buildStateWithPlan(), trace);

    expect(result.facts).toBe(factsResult);
    expect(result.context).toEqual([]);

    const factsEntry = trace.find((entry) => entry.node === "fetch_facts_api");
    const contextEntry = trace.find((entry) => entry.node === "search_vector_context");
    expect(factsEntry?.error).toBeUndefined();
    expect(contextEntry?.error).toContain("429");
  });

  it("records the real QDRANT_COLLECTION in the trace, not a hardcoded name", async () => {
    mockGetFacts.mockResolvedValue({
      competition: { id: "brasileirao-serie-a", name: "Brasileirão Série A", season: 2026 },
      matchweek: 12,
      matches: [],
      teams: [],
      source: "fixture",
    });
    mockSearchContext.mockResolvedValue([]);

    const trace: TraceEntry[] = [];
    await runFanOut(buildStateWithPlan(), trace);

    const contextEntry = trace.find((entry) => entry.node === "search_vector_context");
    expect(contextEntry?.collection).toBe("camisa10-test");
  });
});
