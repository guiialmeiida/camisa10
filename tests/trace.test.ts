import { describe, expect, it } from "vitest";
import { formatTrace } from "../src/agent/trace.ts";
import type { TraceEntry } from "../src/agent/trace.ts";
import type { FinalState } from "../src/agent/state.ts";
import type { TeamForm } from "../src/sources/team-form.ts";
import type { DecayedResult } from "../src/retrieval/time-decay.ts";
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
    recentForm: null,
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
        recentForm: null,
      },
      {
        node: "search_vector_context",
        model: "voyage-3.5",
        ms: 290,
        k: 5,
        collection: "camisa10",
        collectionSize: 14,
        filter: null,
        waitedForFactsMs: 0,
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
        filter: null,
        waitedForFactsMs: 0,
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
        recentForm: null,
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
        recentForm: null,
      },
      {
        node: "search_vector_context",
        model: "voyage-3.5",
        ms: 300,
        k: 5,
        collection: "camisa10",
        collectionSize: 14,
        filter: null,
        waitedForFactsMs: 0,
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
        filter: null,
        waitedForFactsMs: 0,
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
        filter: null,
        waitedForFactsMs: 0,
        results: [
          { id: 1, score: 0.612, payload: samplePayload("p03", "matchReport", { chunkIndex: 1, chunkCount: 4 }) },
        ],
      },
    ];

    expect(formatTrace(buildFinalState(trace))).toContain("chunk 2/4");
  });

  it("prints the failure instead of the matches when fetch_facts_api has an error", () => {
    const trace: TraceEntry[] = [
      { node: "fetch_facts_api", model: null, ms: 12, facts: null, recentForm: null, error: "network timeout" },
    ];

    const output = formatTrace(buildFinalState(trace));

    expect(output).toContain("ERROR");
    expect(output).toContain("network timeout");
  });

  it("prints 'filter: none' and no wait suffix when the search ran unfiltered", () => {
    const trace: TraceEntry[] = [
      {
        node: "search_vector_context",
        model: "voyage-3.5",
        ms: 330,
        k: 5,
        collection: "camisa10",
        collectionSize: 14,
        filter: null,
        waitedForFactsMs: 0,
        results: [],
      },
    ];

    const output = formatTrace(buildFinalState(trace));

    expect(output).toContain("filter: none");
    expect(output).not.toContain("waited");
  });

  it("prints the filter JSON and the wait suffix when the search waited on fetch_facts_api", () => {
    const trace: TraceEntry[] = [
      {
        node: "search_vector_context",
        model: "voyage-3.5",
        ms: 940,
        k: 5,
        collection: "camisa10",
        collectionSize: 97,
        filter: {
          must: [
            { key: "publishedAt", range: { gte: "2026-09-03T00:30:00.000Z", lte: "2026-09-07T15:00:00.000Z" } },
            { key: "teams", match: { value: "palmeiras" } },
          ],
        },
        waitedForFactsMs: 610,
        results: [{ id: 1, score: 0.612, payload: samplePayload("p03") }],
      },
    ];

    const output = formatTrace(buildFinalState(trace));

    expect(output).toContain(
      '{"must":[{"key":"publishedAt","range":{"gte":"2026-09-03T00:30:00.000Z","lte":"2026-09-07T15:00:00.000Z"}},{"key":"teams","match":{"value":"palmeiras"}}]}',
    );
    expect(output).toContain("(waited 0.61s for fetch_facts_api)");
  });

  it("still prints the filter line when results is empty — the case where it matters most", () => {
    const trace: TraceEntry[] = [
      {
        node: "search_vector_context",
        model: "voyage-3.5",
        ms: 330,
        k: 5,
        collection: "camisa10",
        collectionSize: 14,
        filter: { must: [{ key: "teams", match: { value: "palmeiras" } }] },
        waitedForFactsMs: 0,
        results: [],
      },
    ];

    const output = formatTrace(buildFinalState(trace));

    expect(output).toContain('filter: {"must":[{"key":"teams","match":{"value":"palmeiras"}}]}');
    expect(output).toContain("no passages retrieved");
  });

  // teamName() resolves display names from facts.teams — for these three tests that's
  // where "Palmeiras"/"Fluminense"/"Bahia" come from (see writer.ts/trace.ts docs on the
  // caveat: an opponent teams.json doesn't know, like "ca-river-plate", degrades to slug).
  function factsWithTeams() {
    return {
      competition: { id: "brasileirao-serie-a", name: "Brasileirão Série A", season: 2026 },
      matchweek: 12,
      matches: [],
      teams: [
        { id: "palmeiras", name: "Palmeiras", nicknames: [] },
        { id: "fluminense", name: "Fluminense", nicknames: [] },
        { id: "bahia", name: "Bahia", nicknames: [] },
      ],
      source: "api" as const,
    };
  }

  it("recentForm present: prints the record header and one line per match", () => {
    const trace: TraceEntry[] = [
      { node: "fetch_facts_api", model: null, ms: 5, facts: factsWithTeams(), recentForm: buildTeamForm() },
    ];

    const output = formatTrace(buildFinalState(trace));

    expect(output).toContain("recent form (Palmeiras), BSA only: 1W 0D 1L in the last 2");
    expect(output).toContain("05/09  Palmeiras 1 x 3 Fluminense   home   loss");
    expect(output).toContain("31/08  Bahia 0 x 2 Palmeiras   away   win");
  });

  it("otherCompetitionMatch present: prints the 'outside BSA' line with the competition name, not its code", () => {
    const trace: TraceEntry[] = [
      { node: "fetch_facts_api", model: null, ms: 5, facts: factsWithTeams(), recentForm: buildTeamForm() },
    ];

    const output = formatTrace(buildFinalState(trace));

    expect(output).toContain("outside BSA:");
    expect(output).toContain("Copa Libertadores");
    expect(output).not.toContain("outside BSA: none");
  });

  it("otherCompetitionMatch: null prints 'outside BSA: none'", () => {
    const trace: TraceEntry[] = [
      {
        node: "fetch_facts_api",
        model: null,
        ms: 5,
        facts: factsWithTeams(),
        recentForm: buildTeamForm({ otherCompetitionMatch: null }),
      },
    ];

    expect(formatTrace(buildFinalState(trace))).toContain("outside BSA: none");
  });

  it("formError present: prints RECENT FORM ERROR and not the retrospecto line", () => {
    const trace: TraceEntry[] = [
      {
        node: "fetch_facts_api",
        model: null,
        ms: 5,
        facts: null,
        recentForm: null,
        formError: "football-data.org rate limit reached (10 req/min)",
      },
    ];

    const output = formatTrace(buildFinalState(trace));

    expect(output).toContain("RECENT FORM ERROR: football-data.org rate limit reached (10 req/min)");
    expect(output).not.toContain("recent form (");
  });

  it("a decayed result prints the pool/half-life suffix and the sim x decay suffix; a plain result doesn't", () => {
    const decayedResult: DecayedResult = {
      id: 1,
      score: 0.5569,
      payload: samplePayload("p01"),
      similarity: 0.62,
      timeDecay: 0.898,
    };
    const decayedTrace: TraceEntry[] = [
      {
        node: "search_vector_context",
        model: "voyage-3.5",
        ms: 940,
        k: 5,
        collection: "camisa10",
        collectionSize: 97,
        filter: { must: [{ key: "teams", match: { value: "palmeiras" } }] },
        waitedForFactsMs: 0,
        results: [decayedResult],
      },
    ];

    const decayedOutput = formatTrace(buildFinalState(decayedTrace));
    expect(decayedOutput).toContain("(pool of 20, time decay: half-life 14d)");
    expect(decayedOutput).toContain("(sim 0.620 × decay 0.898)");

    const plainTrace: TraceEntry[] = [
      {
        node: "search_vector_context",
        model: "voyage-3.5",
        ms: 940,
        k: 5,
        collection: "camisa10",
        collectionSize: 97,
        filter: null,
        waitedForFactsMs: 0,
        results: [{ id: 1, score: 0.5, payload: samplePayload("p01") }],
      },
    ];

    const plainOutput = formatTrace(buildFinalState(plainTrace));
    expect(plainOutput).not.toContain("time decay");
    expect(plainOutput).not.toContain("sim ");
  });

  it("describeLowConfidence: team_form with recentForm null mentions the retrospecto; with no team identified, mentions that", () => {
    const noForm = formatTrace(
      buildFinalState([], {
        facts: { competition: { id: "brasileirao-serie-a", name: "Brasileirão Série A", season: 2026 }, matchweek: 12, matches: [], teams: [], source: "api" },
        context: [{ id: 1, score: 0.5, payload: samplePayload("p01") }],
        recentForm: null,
        answer: { text: "resposta", citedPassages: [], lowConfidence: true },
      }),
    );
    expect(noForm).toContain("no recent form for the team");

    const noTeam = formatTrace(
      buildFinalState([], {
        entity: { team: null, competition: null, matchweek: null, confidence: "low" },
        facts: { competition: { id: "brasileirao-serie-a", name: "Brasileirão Série A", season: 2026 }, matchweek: 12, matches: [], teams: [], source: "api" },
        context: [{ id: 1, score: 0.5, payload: samplePayload("p01") }],
        recentForm: null,
        answer: { text: "resposta", citedPassages: [], lowConfidence: true },
      }),
    );
    expect(noTeam).toContain("no team identified in the question, so no recent form and no team filter");
  });

  it("describeLowConfidence: the three original phrases stay identical for cases with recentForm present", () => {
    const missingFactsOnly = formatTrace(
      buildFinalState([], {
        facts: null,
        context: [{ id: 1, score: 0.5, payload: samplePayload("p01") }],
        recentForm: buildTeamForm(),
        answer: { text: "resposta", citedPassages: [], lowConfidence: true },
      }),
    );
    expect(missingFactsOnly).toContain("no API facts (narrative context only, unverifiable against real numbers)");

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
        recentForm: buildTeamForm(),
        answer: { text: "resposta", citedPassages: [], lowConfidence: true },
      }),
    );
    expect(missingContextOnly).toContain("no narrative context, API facts only");

    const both = formatTrace(
      buildFinalState([], {
        facts: null,
        context: [],
        recentForm: buildTeamForm(),
        answer: { text: "resposta", citedPassages: [], lowConfidence: true },
      }),
    );
    expect(both).toContain("no narrative context, no API facts");
  });
});
