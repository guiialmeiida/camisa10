import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateWithPlan } from "../src/agent/state.ts";
import type { TraceEntry } from "../src/agent/trace.ts";
import type { Facts } from "../src/sources/index.ts";
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
  FOOTBALL_DATA_TOKEN: "fake-token",
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

function buildCurrentMatchweekStateWithPlan(): StateWithPlan {
  return {
    ...buildStateWithPlan(),
    question: "como está a rodada do Brasileirão?",
    plan: {
      mode: "current_matchweek",
      tools: ["fetch_facts_api", "search_vector_context"],
      searchQuery: "rodada atual do Brasileirão",
      rationale: "pergunta é sobre a rodada em andamento",
    },
  };
}

// Two days in the past, real wall clock — the window's gte only needs to be strictly
// derived from this, never from "now" (which the filter also reads, for lte).
function pastMatchDate(): Date {
  return new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
}

function buildFactsWithMatch(date: Date): Facts {
  return {
    competition: { id: "brasileirao-serie-a", name: "Brasileirão Série A", season: 2026 },
    matchweek: 12,
    matches: [
      {
        id: "m1",
        matchweek: 12,
        date: date.toISOString(),
        status: "finished",
        homeTeam: "palmeiras",
        awayTeam: "fluminense",
        score: { home: 1, away: 3 },
        venue: "Allianz Parque",
      },
    ],
    teams: [],
    source: "api",
  };
}

function samplePayload(passageId: string): PassagePayload {
  return {
    passageId,
    contentHash: "0".repeat(40),
    chunkIndex: 0,
    chunkCount: 1,
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
    expect(contextEntry?.filter).toBeNull();
    expect(contextEntry?.waitedForFactsMs).toBe(0);
  });
});

describe("runFanOut — spec §5: the current_matchweek filter depends on facts, without losing resilience", () => {
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

  it("current_matchweek: searchContext is called with the date window (from the minimum match date) and the team clause", async () => {
    const matchDate = pastMatchDate();
    const facts = buildFactsWithMatch(matchDate);
    mockGetFacts.mockResolvedValue(facts);
    mockSearchContext.mockResolvedValue([]);

    const expectedGte = new Date(matchDate.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();

    const trace: TraceEntry[] = [];
    await runFanOut(buildCurrentMatchweekStateWithPlan(), trace);

    expect(mockSearchContext).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: {
          must: [
            { key: "publishedAt", range: { gte: expectedGte, lte: expect.any(String) } },
            { key: "teams", match: { value: "palmeiras" } },
          ],
        },
      }),
    );

    const contextEntry = trace.find((entry) => entry.node === "search_vector_context");
    expect(contextEntry?.filter).toEqual({
      must: [
        { key: "publishedAt", range: { gte: expectedGte, lte: expect.any(String) } },
        { key: "teams", match: { value: "palmeiras" } },
      ],
    });
  });

  it("team_form: searchContext is called with no filter property at all", async () => {
    mockGetFacts.mockResolvedValue(buildFactsWithMatch(pastMatchDate()));
    mockSearchContext.mockResolvedValue([]);

    await runFanOut(buildStateWithPlan(), []);

    expect(mockSearchContext).toHaveBeenCalledWith(
      expect.not.objectContaining({ filter: expect.anything() }),
    );
    const [callArgs] = mockSearchContext.mock.calls[0] ?? [];
    expect(callArgs && "filter" in callArgs).toBe(false);
  });

  it("team_form: does not wait for fetch_facts_api — searchContext already ran before it resolves", () => {
    mockGetFacts.mockReturnValue(new Promise<Facts>(() => {})); // never resolves within the test
    mockSearchContext.mockResolvedValue([]);

    void runFanOut(buildStateWithPlan(), []);

    expect(mockSearchContext).toHaveBeenCalled();
  });

  it("current_matchweek: waits for fetch_facts_api before calling searchContext", async () => {
    let resolveFacts!: (value: Facts) => void;
    const pendingFacts = new Promise<Facts>((resolve) => {
      resolveFacts = resolve;
    });
    mockGetFacts.mockReturnValue(pendingFacts);
    mockSearchContext.mockResolvedValue([]);

    const runPromise = runFanOut(buildCurrentMatchweekStateWithPlan(), []);

    // Give any synchronous/microtask work a chance to run — searchContext must still
    // not have been called, because the branch is awaiting factsCall.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSearchContext).not.toHaveBeenCalled();

    resolveFacts(buildFactsWithMatch(pastMatchDate()));
    await runPromise;

    expect(mockSearchContext).toHaveBeenCalledWith(expect.objectContaining({ filter: expect.anything() }));
  });

  it("current_matchweek: a rejected fetch_facts_api still lets searchContext run, with a team-only filter", async () => {
    mockGetFacts.mockRejectedValue(new Error("API futebol 503"));
    const contextResult = [{ id: 1, score: 0.6, payload: samplePayload("p03") }];
    mockSearchContext.mockResolvedValue(contextResult);

    const trace: TraceEntry[] = [];
    const result = await runFanOut(buildCurrentMatchweekStateWithPlan(), trace);

    expect(result.facts).toBeNull();
    expect(result.context).toBe(contextResult);
    expect(mockSearchContext).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { must: [{ key: "teams", match: { value: "palmeiras" } }] } }),
    );

    const factsEntry = trace.find((entry) => entry.node === "fetch_facts_api");
    const contextEntry = trace.find((entry) => entry.node === "search_vector_context");
    expect(factsEntry?.error).toContain("API futebol 503");
    expect(contextEntry?.error).toBeUndefined();
    expect(contextEntry?.filter).toEqual({ must: [{ key: "teams", match: { value: "palmeiras" } }] });
  });

  it("current_matchweek: no filter at all when fetch_facts_api rejects and the question names no team", async () => {
    mockGetFacts.mockRejectedValue(new Error("API futebol 503"));
    mockSearchContext.mockResolvedValue([]);

    const state = buildCurrentMatchweekStateWithPlan();
    state.entity = { ...state.entity, team: null };

    const trace: TraceEntry[] = [];
    await runFanOut(state, trace);

    expect(mockSearchContext).toHaveBeenCalledWith(
      expect.not.objectContaining({ filter: expect.anything() }),
    );
    const contextEntry = trace.find((entry) => entry.node === "search_vector_context");
    expect(contextEntry?.filter).toBeNull();
  });
});
