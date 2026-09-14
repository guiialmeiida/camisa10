import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateWithData, StateWithPlan } from "../src/agent/state.ts";
import type { TraceEntry } from "../src/agent/trace.ts";
import type { Facts } from "../src/sources/index.ts";
import type { TeamForm } from "../src/sources/team-form.ts";
import type { GradeOutcome, PassageGrade } from "../src/agent/nodes/grade.ts";
import type { SearchResult } from "../src/vectorstore/types.ts";
import type { PassagePayload } from "../src/vectorstore/types.ts";

vi.mock("../src/sources/index.ts", () => ({ getFacts: vi.fn() }));
vi.mock("../src/sources/team-form.ts", () => ({ getTeamForm: vi.fn() }));
vi.mock("../src/retrieval/search-context.ts", () => ({ searchContext: vi.fn() }));
vi.mock("../src/vectorstore/qdrant.ts", () => ({ countPoints: vi.fn() }));
// gradePassages is the only piece of grade.ts under test control here — shouldRewriteQuery,
// summarizeRejections and the two constants stay real, so the loop's own decisions (not a
// second mock) are what these tests exercise.
vi.mock("../src/agent/nodes/grade.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/nodes/grade.ts")>();
  return { ...actual, gradePassages: vi.fn() };
});
vi.mock("../src/agent/nodes/plan.ts", () => ({ plan: vi.fn() }));

const { getFacts } = await import("../src/sources/index.ts");
const { getTeamForm } = await import("../src/sources/team-form.ts");
const { searchContext } = await import("../src/retrieval/search-context.ts");
const { countPoints } = await import("../src/vectorstore/qdrant.ts");
const { gradePassages } = await import("../src/agent/nodes/grade.ts");
const { plan: planNode } = await import("../src/agent/nodes/plan.ts");
const { runFanOut, runGradingLoop } = await import("../src/agent/graph.ts");

const mockGetFacts = vi.mocked(getFacts);
const mockGetTeamForm = vi.mocked(getTeamForm);
const mockSearchContext = vi.mocked(searchContext);
const mockCountPoints = vi.mocked(countPoints);
const mockGradePassages = vi.mocked(gradePassages);
const mockPlanNode = vi.mocked(planNode);

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

function samplePayload(passageId: string, publishedAt = "2026-09-06T08:00:00-03:00"): PassagePayload {
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
    publishedAt,
  };
}

function buildTeamForm(): TeamForm {
  return {
    team: "palmeiras",
    matches: [],
    otherCompetitionMatch: null,
    record: { wins: 0, draws: 0, losses: 0 },
    source: "api",
  };
}

describe("runFanOut — spec §6: Promise.allSettled never aborts the graph", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...process.env, ...fakeEnv };
    mockGetFacts.mockReset();
    mockGetTeamForm.mockReset();
    mockGetTeamForm.mockResolvedValue(buildTeamForm());
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
    // team_form now reranks the pool (spec §7), so the returned objects are no longer
    // the same references mockSearchContext handed back — check content, not identity.
    expect(result.context).toHaveLength(1);
    expect(result.context[0]?.payload.passageId).toBe("p03");

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
    // buildStateWithPlan() is team_form with a team — the filter is mandatory in this mode.
    expect(contextEntry?.filter).toEqual({ must: [{ key: "teams", match: { value: "palmeiras" } }] });
    expect(contextEntry?.waitedForFactsMs).toBe(0);
  });
});

describe("runFanOut — spec §5: the current_matchweek filter depends on facts, without losing resilience", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...process.env, ...fakeEnv };
    mockGetFacts.mockReset();
    mockGetTeamForm.mockReset();
    mockGetTeamForm.mockResolvedValue(buildTeamForm());
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

  it("team_form: searchContext is called with the team filter and a pool of k * CANDIDATE_POOL_FACTOR", async () => {
    mockGetFacts.mockResolvedValue(buildFactsWithMatch(pastMatchDate()));
    mockSearchContext.mockResolvedValue([]);

    const state = buildStateWithPlan();
    await runFanOut(state, []);

    expect(mockSearchContext).toHaveBeenCalledWith({
      query: state.plan.searchQuery,
      k: state.k * 4,
      filter: { must: [{ key: "teams", match: { value: "palmeiras" } }] },
    });
  });

  it("team_form without a team: searchContext is called with no filter property at all, and getTeamForm doesn't run", async () => {
    mockGetFacts.mockResolvedValue(buildFactsWithMatch(pastMatchDate()));
    mockSearchContext.mockResolvedValue([]);

    const state = buildStateWithPlan();
    state.entity = { ...state.entity, team: null };
    await runFanOut(state, []);

    expect(mockGetTeamForm).not.toHaveBeenCalled();
    expect(mockSearchContext).toHaveBeenCalledWith(
      expect.not.objectContaining({ filter: expect.anything() }),
    );
    const [callArgs] = mockSearchContext.mock.calls[0] ?? [];
    expect(callArgs && "filter" in callArgs).toBe(false);
    expect(callArgs?.k).toBe(state.k);
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

describe("runFanOut — spec §8: getTeamForm joins the facts branch, independently of getFacts", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...process.env, ...fakeEnv };
    mockGetFacts.mockReset();
    mockGetTeamForm.mockReset();
    mockSearchContext.mockReset();
    mockCountPoints.mockReset();
    mockCountPoints.mockResolvedValue(14);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("team_form with a team: getFacts and getTeamForm both run, context is <= k and ordered by score descending, and recentForm is what getTeamForm returned", async () => {
    const facts = buildFactsWithMatch(pastMatchDate());
    const form = { ...buildTeamForm(), record: { wins: 2, draws: 1, losses: 2 } };
    mockGetFacts.mockResolvedValue(facts);
    mockGetTeamForm.mockResolvedValue(form);
    // Three candidates of varying freshness — rankByTimeDecay must reorder and cut to k.
    const pool = [
      { id: 1, score: 0.5, payload: samplePayload("stale", "2026-01-01T00:00:00-03:00") },
      { id: 2, score: 0.6, payload: samplePayload("fresh", new Date().toISOString()) },
      { id: 3, score: 0.4, payload: samplePayload("mid", "2026-06-01T00:00:00-03:00") },
    ];
    mockSearchContext.mockResolvedValue(pool);

    const state = { ...buildStateWithPlan(), k: 2 };
    const trace: TraceEntry[] = [];
    const result = await runFanOut(state, trace);

    expect(mockGetFacts).toHaveBeenCalled();
    expect(mockGetTeamForm).toHaveBeenCalledWith("palmeiras");
    expect(mockSearchContext).toHaveBeenCalledWith(
      expect.objectContaining({ k: state.k * 4, filter: { must: [{ key: "teams", match: { value: "palmeiras" } }] } }),
    );
    expect(result.context.length).toBeLessThanOrEqual(state.k);
    const scores = result.context.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(result.recentForm).toBe(form);
  });

  it("team_form without a team: getTeamForm doesn't run and recentForm is null", async () => {
    mockGetFacts.mockResolvedValue(buildFactsWithMatch(pastMatchDate()));
    mockSearchContext.mockResolvedValue([]);

    const state = buildStateWithPlan();
    state.entity = { ...state.entity, team: null };

    const result = await runFanOut(state, []);

    expect(mockGetTeamForm).not.toHaveBeenCalled();
    expect(result.recentForm).toBeNull();
  });

  it("current_matchweek: getTeamForm doesn't run and recentForm is null", async () => {
    mockGetFacts.mockResolvedValue(buildFactsWithMatch(pastMatchDate()));
    mockSearchContext.mockResolvedValue([]);

    const result = await runFanOut(buildCurrentMatchweekStateWithPlan(), []);

    expect(mockGetTeamForm).not.toHaveBeenCalled();
    expect(result.recentForm).toBeNull();
  });

  it("getTeamForm rejecting doesn't cost facts: recentForm is null with a formError, facts is preserved", async () => {
    const facts = buildFactsWithMatch(pastMatchDate());
    mockGetFacts.mockResolvedValue(facts);
    mockGetTeamForm.mockRejectedValue(new Error("football-data.org rate limit reached"));
    mockSearchContext.mockResolvedValue([]);

    const trace: TraceEntry[] = [];
    const result = await runFanOut(buildStateWithPlan(), trace);

    expect(result.facts).toBe(facts);
    expect(result.recentForm).toBeNull();

    const factsEntry = trace.find((entry) => entry.node === "fetch_facts_api");
    expect(factsEntry?.formError).toContain("rate limit");
    expect(factsEntry?.error).toBeUndefined();
  });

  it("getFacts rejecting doesn't cost recentForm: facts is null with an error, recentForm is preserved", async () => {
    const form = buildTeamForm();
    mockGetFacts.mockRejectedValue(new Error("API futebol 503"));
    mockGetTeamForm.mockResolvedValue(form);
    mockSearchContext.mockResolvedValue([]);

    const trace: TraceEntry[] = [];
    const result = await runFanOut(buildStateWithPlan(), trace);

    expect(result.facts).toBeNull();
    expect(result.recentForm).toBe(form);

    const factsEntry = trace.find((entry) => entry.node === "fetch_facts_api");
    expect(factsEntry?.error).toContain("API futebol 503");
    expect(factsEntry?.formError).toBeUndefined();
  });

  it("the fetch_facts_api trace entry always carries recentForm, in every mode", async () => {
    mockGetFacts.mockResolvedValue(buildFactsWithMatch(pastMatchDate()));
    mockGetTeamForm.mockResolvedValue(buildTeamForm());
    mockSearchContext.mockResolvedValue([]);

    const trace: TraceEntry[] = [];
    await runFanOut(buildCurrentMatchweekStateWithPlan(), trace);

    const factsEntry = trace.find((entry) => entry.node === "fetch_facts_api");
    expect(factsEntry).toHaveProperty("recentForm");
    expect(factsEntry?.recentForm).toBeNull();
  });
});

function sampleResult(passageId: string, score = 0.5): SearchResult {
  return { id: passageId.charCodeAt(0), score, payload: samplePayload(passageId) };
}

function grade(passageId: string, relevant: boolean, reason = "motivo qualquer"): PassageGrade {
  return { passageId, chunkIndex: 0, relevant, reason };
}

function gradeOutcome(passageIds: string[], approvedCount: number): GradeOutcome {
  const grades = passageIds.map((id, index) => grade(id, index < approvedCount));
  const approved = passageIds.slice(0, approvedCount).map((id) => sampleResult(id));
  const judged = passageIds.length;
  return { grades, approved, judged, approvedRatio: judged === 0 ? null : approvedCount / judged };
}

function buildStateWithData(context: SearchResult[]): StateWithData {
  return {
    ...buildStateWithPlan(),
    facts: buildFactsWithMatch(pastMatchDate()),
    context,
    recentForm: buildTeamForm(),
  };
}

describe("runGradingLoop — spec §6: Corrective RAG, best attempt wins", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...process.env, ...fakeEnv };
    mockGradePassages.mockReset();
    mockPlanNode.mockReset();
    mockSearchContext.mockReset();
    mockCountPoints.mockReset();
    mockCountPoints.mockResolvedValue(14);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("happy path: grading approves enough -> no rewrite, plan isn't called again, no second search, context is what was approved", async () => {
    const outcome = gradeOutcome(["p01", "p02", "p03"], 3); // 3/3 = 1.0 >= 0.4
    mockGradePassages.mockResolvedValueOnce(outcome);

    const trace: TraceEntry[] = [];
    const state = buildStateWithData([sampleResult("p01"), sampleResult("p02"), sampleResult("p03")]);
    const result = await runGradingLoop(state, trace);

    expect(mockGradePassages).toHaveBeenCalledTimes(1);
    expect(mockPlanNode).not.toHaveBeenCalled();
    expect(mockSearchContext).not.toHaveBeenCalled();
    expect(result.context).toEqual(outcome.approved);
    expect(trace.filter((entry) => entry.node === "grader")).toHaveLength(1);
    expect(trace.filter((entry) => entry.node === "queryRewrite")).toHaveLength(0);
  });

  it("one rewrite: the first round is below the threshold -> plan is called with previousQuery and rejected, searchContext runs a second time with the new query, and the final mode/tools are the original ones even when the planner returns different ones", async () => {
    const belowThreshold = gradeOutcome(["p01", "p02", "p03", "p04", "p05"], 1); // 1/5 = 0.2 < 0.4
    const enoughApproved = gradeOutcome(["p09", "p12"], 2); // 2/2 = 1.0 >= 0.4
    mockGradePassages.mockResolvedValueOnce(belowThreshold).mockResolvedValueOnce(enoughApproved);

    const state = buildStateWithData([
      sampleResult("p01"),
      sampleResult("p02"),
      sampleResult("p03"),
      sampleResult("p04"),
      sampleResult("p05"),
    ]);

    mockPlanNode.mockResolvedValueOnce({
      ...state,
      // The planner tries to switch mode/tools too — the graph must ignore both.
      plan: {
        mode: "current_matchweek",
        tools: ["fetch_facts_api"],
        searchQuery: "fase do Palmeiras: desempenho recente",
        rationale: "nova racional",
      },
    });
    mockSearchContext.mockResolvedValueOnce([sampleResult("p09"), sampleResult("p12")]);

    const trace: TraceEntry[] = [];
    const result = await runGradingLoop(state, trace);

    expect(mockPlanNode).toHaveBeenCalledTimes(1);
    const [, rewriteContext] = mockPlanNode.mock.calls[0] ?? [];
    expect(rewriteContext?.previousQuery).toBe(state.plan.searchQuery);
    expect(rewriteContext?.rejected).toEqual([
      { passageId: "p02", reason: "motivo qualquer" },
      { passageId: "p03", reason: "motivo qualquer" },
      { passageId: "p04", reason: "motivo qualquer" },
      { passageId: "p05", reason: "motivo qualquer" },
    ]);
    expect(rewriteContext?.attempt).toBe(1);

    expect(mockSearchContext).toHaveBeenCalledTimes(1);
    expect(mockSearchContext).toHaveBeenCalledWith(
      expect.objectContaining({ query: "fase do Palmeiras: desempenho recente" }),
    );

    // mode and tools stay the original team_form ones — only searchQuery moves.
    expect(result.plan.mode).toBe("team_form");
    expect(result.plan.tools).toEqual(["fetch_facts_api", "search_vector_context"]);
    expect(result.plan.searchQuery).toBe("fase do Palmeiras: desempenho recente");
    expect(result.context).toEqual(enoughApproved.approved);
  });

  it("ceiling: every round stays below the threshold -> exactly 2 queryRewrite entries, 3 grader entries, 3 search_vector_context entries, and the loop still answers", async () => {
    const round1 = gradeOutcome(["p01", "p02", "p03", "p04", "p05"], 0);
    const round2 = gradeOutcome(["p06", "p07"], 0);
    const round3 = gradeOutcome(["p08", "p09"], 0);
    mockGradePassages.mockResolvedValueOnce(round1).mockResolvedValueOnce(round2).mockResolvedValueOnce(round3);
    mockPlanNode
      .mockResolvedValueOnce({
        ...buildStateWithPlan(),
        plan: { ...buildStateWithPlan().plan, searchQuery: "reescrita 1" },
      })
      .mockResolvedValueOnce({
        ...buildStateWithPlan(),
        plan: { ...buildStateWithPlan().plan, searchQuery: "reescrita 2" },
      });
    mockSearchContext
      .mockResolvedValueOnce([sampleResult("p06"), sampleResult("p07")])
      .mockResolvedValueOnce([sampleResult("p08"), sampleResult("p09")]);

    const state = buildStateWithData([
      sampleResult("p01"),
      sampleResult("p02"),
      sampleResult("p03"),
      sampleResult("p04"),
      sampleResult("p05"),
    ]);
    const trace: TraceEntry[] = [];
    const result = await runGradingLoop(state, trace);

    expect(mockGradePassages).toHaveBeenCalledTimes(3);
    expect(trace.filter((entry) => entry.node === "grader")).toHaveLength(3);
    expect(trace.filter((entry) => entry.node === "queryRewrite")).toHaveLength(2);
    expect(trace.filter((entry) => entry.node === "search_vector_context")).toHaveLength(2);
    expect(result.context).toBeDefined(); // never throws — responds at the ceiling
  });

  it("best attempt wins: attempt 1 approves 2, attempt 2 approves 0, attempt 3 approves 1 -> context is attempt 1's", async () => {
    const round1 = gradeOutcome(["p01", "p02", "p03", "p04", "p05"], 2); // 2/5 = 0.4 -> not below threshold... use < to force rewrite
    // Force every round below the threshold so all 3 rounds run, regardless of how many
    // each approves — 2/6, 0/6 and 1/6 are all < 0.4.
    const round1Forced: GradeOutcome = { ...round1, judged: 6, approvedRatio: 2 / 6 };
    const round2 = gradeOutcome(["p06", "p07"], 0);
    const round3Base = gradeOutcome(["p08", "p09", "p10", "p11", "p12", "p13"], 1);
    const round3Forced: GradeOutcome = { ...round3Base, approvedRatio: 1 / 6 };
    mockGradePassages
      .mockResolvedValueOnce(round1Forced)
      .mockResolvedValueOnce(round2)
      .mockResolvedValueOnce(round3Forced);
    mockPlanNode
      .mockResolvedValueOnce({
        ...buildStateWithPlan(),
        plan: { ...buildStateWithPlan().plan, searchQuery: "reescrita 1" },
      })
      .mockResolvedValueOnce({
        ...buildStateWithPlan(),
        plan: { ...buildStateWithPlan().plan, searchQuery: "reescrita 2" },
      });
    mockSearchContext
      .mockResolvedValueOnce([sampleResult("p06"), sampleResult("p07")])
      .mockResolvedValueOnce([sampleResult("p08"), sampleResult("p09")]);

    const state = buildStateWithData([
      sampleResult("p01"),
      sampleResult("p02"),
      sampleResult("p03"),
      sampleResult("p04"),
      sampleResult("p05"),
    ]);
    const trace: TraceEntry[] = [];
    const result = await runGradingLoop(state, trace);

    expect(result.context).toEqual(round1Forced.approved);
    const graderEntries = trace.filter((entry) => entry.node === "grader");
    expect(graderEntries.map((entry) => entry.approved)).toEqual([2, 0, 1]);
  });

  it("tie: two attempts approve the same count -> the oldest keeps the win", async () => {
    const round1 = gradeOutcome(["p01", "p02", "p03", "p04", "p05"], 2);
    const round1Forced: GradeOutcome = { ...round1, judged: 6, approvedRatio: 2 / 6 };
    const round2 = gradeOutcome(["p06", "p07"], 2); // same count as round 1
    mockGradePassages.mockResolvedValueOnce(round1Forced).mockResolvedValueOnce(round2);
    mockPlanNode.mockResolvedValueOnce({
      ...buildStateWithPlan(),
      plan: { ...buildStateWithPlan().plan, searchQuery: "reescrita 1" },
    });
    mockSearchContext.mockResolvedValueOnce([sampleResult("p06"), sampleResult("p07")]);

    const state = buildStateWithData([
      sampleResult("p01"),
      sampleResult("p02"),
      sampleResult("p03"),
      sampleResult("p04"),
      sampleResult("p05"),
    ]);
    const result = await runGradingLoop(state, []);

    expect(result.context).toEqual(round1Forced.approved);
  });

  it("identical rewritten query: the loop stops there, with no second search", async () => {
    const belowThreshold = gradeOutcome(["p01", "p02", "p03", "p04", "p05"], 1);
    mockGradePassages.mockResolvedValueOnce(belowThreshold);
    const state = buildStateWithData([
      sampleResult("p01"),
      sampleResult("p02"),
      sampleResult("p03"),
      sampleResult("p04"),
      sampleResult("p05"),
    ]);
    mockPlanNode.mockResolvedValueOnce({
      ...state,
      plan: { ...state.plan, searchQuery: state.plan.searchQuery.toUpperCase() },
    });

    const trace: TraceEntry[] = [];
    const result = await runGradingLoop(state, trace);

    expect(mockSearchContext).not.toHaveBeenCalled();
    expect(trace.filter((entry) => entry.node === "search_vector_context")).toHaveLength(0);
    expect(result.context).toEqual(belowThreshold.approved);
  });

  it("plan() rejecting on the rewrite: the queryRewrite entry carries the error, the loop stops with the best context it had", async () => {
    const belowThreshold = gradeOutcome(["p01", "p02", "p03", "p04", "p05"], 1);
    mockGradePassages.mockResolvedValueOnce(belowThreshold);
    mockPlanNode.mockRejectedValueOnce(new Error("planner call failed: 500"));

    const state = buildStateWithData([
      sampleResult("p01"),
      sampleResult("p02"),
      sampleResult("p03"),
      sampleResult("p04"),
      sampleResult("p05"),
    ]);
    const trace: TraceEntry[] = [];
    const result = await runGradingLoop(state, trace);

    const rewriteEntry = trace.find((entry) => entry.node === "queryRewrite");
    expect(rewriteEntry?.error).toContain("planner call failed: 500");
    expect(result.context).toEqual(belowThreshold.approved);
    expect(mockSearchContext).not.toHaveBeenCalled();
  });

  it("runSearch rejecting on the retry: the entry carries an error and results: [], the loop stops with the previous best context", async () => {
    const belowThreshold = gradeOutcome(["p01", "p02", "p03", "p04", "p05"], 1);
    mockGradePassages.mockResolvedValueOnce(belowThreshold);
    mockPlanNode.mockResolvedValueOnce({
      ...buildStateWithPlan(),
      plan: { ...buildStateWithPlan().plan, searchQuery: "reescrita 1" },
    });
    mockSearchContext.mockRejectedValueOnce(new Error("Voyage embeddings request failed: 429"));

    const state = buildStateWithData([
      sampleResult("p01"),
      sampleResult("p02"),
      sampleResult("p03"),
      sampleResult("p04"),
      sampleResult("p05"),
    ]);
    const trace: TraceEntry[] = [];
    const result = await runGradingLoop(state, trace);

    const searchEntry = trace.find(
      (entry): entry is Extract<TraceEntry, { node: "search_vector_context" }> =>
        entry.node === "search_vector_context" && entry.attempt === 2,
    );
    expect(searchEntry?.error).toContain("429");
    expect(searchEntry?.results).toEqual([]);
    expect(result.context).toEqual(belowThreshold.approved);
  });

  it("a rewrite retry never re-fetches facts/recentForm — getFacts and getTeamForm aren't imported by grade/plan and are never called here", async () => {
    const belowThreshold = gradeOutcome(["p01", "p02", "p03", "p04", "p05"], 1);
    const enoughApproved = gradeOutcome(["p09"], 1);
    mockGradePassages.mockResolvedValueOnce(belowThreshold).mockResolvedValueOnce(enoughApproved);
    mockPlanNode.mockResolvedValueOnce({
      ...buildStateWithPlan(),
      plan: { ...buildStateWithPlan().plan, searchQuery: "reescrita 1" },
    });
    mockGetFacts.mockReset();
    mockGetTeamForm.mockReset();
    mockSearchContext.mockResolvedValueOnce([sampleResult("p09")]);

    const state = buildStateWithData([
      sampleResult("p01"),
      sampleResult("p02"),
      sampleResult("p03"),
      sampleResult("p04"),
      sampleResult("p05"),
    ]);
    await runGradingLoop(state, []);

    expect(mockGetFacts).not.toHaveBeenCalled();
    expect(mockGetTeamForm).not.toHaveBeenCalled();
  });

  it("every search_vector_context entry carries attempt and query, and the first search from the fan-out has attempt 1", async () => {
    mockGetFacts.mockResolvedValue(buildFactsWithMatch(pastMatchDate()));
    mockGetTeamForm.mockResolvedValue(buildTeamForm());
    mockSearchContext.mockResolvedValueOnce([sampleResult("p01")]);
    mockCountPoints.mockResolvedValue(14);

    const trace: TraceEntry[] = [];
    const state = buildStateWithPlan();
    await runFanOut(state, trace);

    const entry = trace.find((e) => e.node === "search_vector_context");
    expect(entry?.attempt).toBe(1);
    expect(entry?.query).toBe(state.plan.searchQuery);
  });
});
