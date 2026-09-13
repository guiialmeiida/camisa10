import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalState } from "../../src/agent/state.ts";
import type { Facts } from "../../src/sources/index.ts";
import type { TeamForm } from "../../src/sources/team-form.ts";

vi.mock("../../src/agent/llm.ts", () => ({ callText: vi.fn() }));

const { callText } = await import("../../src/agent/llm.ts");
const {
  MAX_ANSWER_REWRITES,
  REDACTED_ANSWER_NOTICE,
  REDACTION_NOTICE,
  allowedNumbers,
  critique,
  findOrphanNumbers,
  redactOrphanSentences,
} = await import("../../src/agent/nodes/critic.ts");
const mockCallText = vi.mocked(callText);

// The literal example from spec §7.
function buildFacts(): Facts {
  return {
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
      {
        id: "m2",
        matchweek: 12,
        date: "2026-09-06T16:00:00-03:00",
        status: "live",
        homeTeam: "corinthians",
        awayTeam: "santos",
        score: { home: 0, away: 0 },
        minute: 67,
        venue: null,
      },
    ],
    teams: [],
    source: "api",
  };
}

function buildTeamForm(): TeamForm {
  const competition = { code: "BSA", name: "Campeonato Brasileiro Série A" };
  return {
    team: "palmeiras",
    matches: [
      { id: "1", date: "2026-09-05T21:30:00-03:00", opponent: "fluminense", side: "home", score: { home: 1, away: 3 }, result: "loss", competition },
      { id: "2", date: "2026-08-31T17:00:00-03:00", opponent: "bahia", side: "away", score: { home: 0, away: 2 }, result: "win", competition },
      { id: "3", date: "2026-08-24T17:00:00-03:00", opponent: "gremio", side: "home", score: { home: 2, away: 1 }, result: "win", competition },
      { id: "4", date: "2026-08-17T17:00:00-03:00", opponent: "santos", side: "away", score: { home: 1, away: 1 }, result: "draw", competition },
      { id: "5", date: "2026-08-10T17:00:00-03:00", opponent: "gremio", side: "home", score: { home: 3, away: 0 }, result: "win", competition },
    ],
    otherCompetitionMatch: {
      id: "6",
      date: "2026-09-03T20:30:00-03:00",
      opponent: "ca-river-plate",
      side: "home",
      score: { home: 2, away: 0 },
      result: "win",
      competition: { code: "CLI", name: "Copa Libertadores" },
    },
    // Deliberately independent of the individual match results above — the spec's own
    // literal example (§7) does the same: allowedNumbers reads this field verbatim, it
    // never recomputes it from `matches`.
    record: { wins: 2, draws: 1, losses: 2 },
    source: "api",
  };
}

function buildFinalState(overrides: Partial<FinalState> = {}): FinalState {
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
    facts: buildFacts(),
    context: [],
    recentForm: buildTeamForm(),
    answer: { text: "resposta de teste", citedPassages: [], lowConfidence: false },
    ...overrides,
  };
}

describe("allowedNumbers", () => {
  it("matches the literal example from spec §7, item by item", () => {
    const allowed = allowedNumbers({ facts: buildFacts(), recentForm: buildTeamForm() });

    expect([...allowed].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 5, 6, 8, 9, 10, 12, 17, 24, 31, 67, 2026]);
  });

  it("facts: null and recentForm: null -> empty set", () => {
    expect(allowedNumbers({ facts: null, recentForm: null })).toEqual(new Set());
  });

  it("day/month come from isoDateParts, not from new Date().getDate() — the same state produces the same set regardless of the host timezone", () => {
    const originalTz = process.env["TZ"];
    try {
      process.env["TZ"] = "UTC";
      const underUtc = allowedNumbers({ facts: buildFacts(), recentForm: null });
      process.env["TZ"] = "America/Sao_Paulo";
      const underSaoPaulo = allowedNumbers({ facts: buildFacts(), recentForm: null });
      expect([...underUtc].sort((a, b) => a - b)).toEqual([...underSaoPaulo].sort((a, b) => a - b));
    } finally {
      if (originalTz === undefined) delete process.env["TZ"];
      else process.env["TZ"] = originalTz;
    }
  });

  it("a scheduled/postponed match contributes no score — there isn't one", () => {
    const facts: Facts = {
      ...buildFacts(),
      matches: [
        {
          id: "m3",
          matchweek: 12,
          date: "2026-09-08T20:00:00-03:00",
          status: "scheduled",
          homeTeam: "corinthians",
          awayTeam: "santos",
          score: null,
          venue: null,
        },
      ],
    };

    const allowed = allowedNumbers({ facts, recentForm: null });

    // Only matchweek, season, day and month survive — no score to add.
    expect([...allowed].sort((a, b) => a - b)).toEqual([8, 9, 12, 2026]);
  });

  it("a live match with a minute adds it; a live match with minute: null adds nothing extra", () => {
    const withMinute = allowedNumbers({
      facts: { ...buildFacts(), matches: [buildFacts().matches[1]!] },
      recentForm: null,
    });
    expect(withMinute.has(67)).toBe(true);

    const liveNoMinute = { ...buildFacts().matches[1]!, minute: null } as Facts["matches"][number];
    const withoutMinute = allowedNumbers({ facts: { ...buildFacts(), matches: [liveNoMinute] }, recentForm: null });
    expect(withoutMinute.has(67)).toBe(false);
  });

  it("recentForm alone (no facts) still populates the set — a team_form answer is never treated as hallucination for citing its own retrospecto", () => {
    const allowed = allowedNumbers({ facts: null, recentForm: buildTeamForm() });

    expect(allowed.has(5)).toBe(true); // matches.length
    expect(allowed.has(2)).toBe(true); // record.wins
    expect(allowed.has(1)).toBe(true); // record.draws
    expect(allowed.has(3)).toBe(true); // matches[0].score.away and otherCompetitionMatch.score.home
    expect(allowed.has(0)).toBe(true); // otherCompetitionMatch.score.away
  });
});

describe("findOrphanNumbers", () => {
  it("strips citations before extracting numbers: a response that only cites passages has no orphans, even with an empty allowed set", () => {
    expect(findOrphanNumbers("veja mais em [p07] e [p12]", new Set())).toEqual([]);
  });

  it("does not match a sub-number: allowed has 2026, '12' in the text is still orphan", () => {
    expect(findOrphanNumbers("na rodada 12", new Set([2026]))).toEqual([12]);
  });

  it("does not match a sub-number the other way: allowed has 12, '2026' in the text is still orphan", () => {
    expect(findOrphanNumbers("temporada 2026", new Set([12]))).toEqual([2026]);
  });

  it("preserves order of appearance and drops repeats", () => {
    expect(findOrphanNumbers("4 e 4 e 7", new Set())).toEqual([4, 7]);
  });

  it("matches the literal example from spec §7", () => {
    const allowed = allowedNumbers({ facts: buildFacts(), recentForm: buildTeamForm() });
    const text =
      "O Palmeiras perdeu por 1 x 3 para o Fluminense [p03] e vinha de uma sequência de 4 vitórias seguidas. " +
      "O time soma 2V 1E 2D nos últimos 5 jogos do Brasileirão.";

    expect(findOrphanNumbers(text, allowed)).toEqual([4]);
  });
});

describe("redactOrphanSentences", () => {
  it("matches the literal example from spec §9", () => {
    const text =
      "O Palmeiras perdeu por 1 x 3 para o Fluminense [p03]. O time vinha de 4 vitórias seguidas [p05]. A pressão sobre o técnico aumentou.";

    const result = redactOrphanSentences(text, [4]);

    expect(result.text).toBe(
      `O Palmeiras perdeu por 1 x 3 para o Fluminense [p03]. A pressão sobre o técnico aumentou. ${REDACTION_NOTICE}`,
    );
    expect(result.removedSentences).toEqual(["O time vinha de 4 vitórias seguidas [p05]. "]);
  });

  it("orphans: [] returns the input text unchanged, no sentences removed", () => {
    const text = "Resposta qualquer, sem números órfãos aqui.";

    expect(redactOrphanSentences(text, [])).toEqual({ text, removedSentences: [] });
  });

  it("when every sentence carries an orphan, the whole answer is replaced by REDACTED_ANSWER_NOTICE", () => {
    const text = "O time venceu por 4 a 0. Foram 4 vitórias seguidas.";

    const result = redactOrphanSentences(text, [4]);

    expect(result.text).toBe(REDACTED_ANSWER_NOTICE);
    expect(result.removedSentences).toHaveLength(2);
  });

  it("an orphan in the same sentence as a valid citation removes the whole sentence", () => {
    const text = "O time venceu [p01]. Foram 4 vitórias seguidas [p05]. Segue na liderança.";

    const result = redactOrphanSentences(text, [4]);

    expect(result.removedSentences).toEqual(["Foram 4 vitórias seguidas [p05]. "]);
    expect(result.text).not.toContain("[p05]");
  });

  it("a sentence with no final punctuation is still segmented and handled", () => {
    const text = "O time venceu por 1 a 0. Foram 4 vitórias seguidas";

    const result = redactOrphanSentences(text, [4]);

    expect(result.removedSentences).toEqual(["Foram 4 vitórias seguidas"]);
    expect(result.text).toBe(`O time venceu por 1 a 0. ${REDACTION_NOTICE}`);
  });

  it("segmentation invariant: an orphan that matches no sentence removes nothing and appends no notice", () => {
    const text = "Frase um. Frase dois! Frase três? Frase final sem pontuação";

    // 99 appears in none of the four sentences — the segmentation runs (unlike orphans: []
    // above, which returns early before it), finds nothing to remove, and returns the
    // input untouched rather than warning about a removal that never happened.
    expect(redactOrphanSentences(text, [99])).toEqual({ text, removedSentences: [] });
  });

  it("does not split inside a thousands-separated number: '1.500' survives as one token, not two sentences", () => {
    const text = "O time marcou 1.500 gols na temporada.";

    // 1500 isn't an orphan here — the point is only that segmentation doesn't cut the
    // number in half and produce a truncated, false sentence like "O time marcou 1.".
    const result = redactOrphanSentences(text, [42]);

    expect(result).toEqual({ text, removedSentences: [] });
  });

  it("a real removal alongside a thousands-separated number in a kept sentence: the number survives intact", () => {
    const text = "O time marcou 1.500 gols na temporada. Foram 4 vitórias seguidas.";

    const result = redactOrphanSentences(text, [4]);

    expect(result.removedSentences).toEqual(["Foram 4 vitórias seguidas."]);
    expect(result.text).toBe(`O time marcou 1.500 gols na temporada. ${REDACTION_NOTICE}`);
  });
});

describe("critique", () => {
  beforeEach(() => {
    mockCallText.mockReset();
  });

  it("a clean answer: callText is never called, the state comes back by identity, report.rewritten is false", async () => {
    const state = buildFinalState({ answer: { text: "resposta sem número nenhum além do V-E-D", citedPassages: [], lowConfidence: false } });

    const result = await critique(state);

    expect(mockCallText).not.toHaveBeenCalled();
    expect(result.state).toBe(state);
    expect(result.report).toEqual({
      orphanNumbers: [],
      rewritten: false,
      remainingOrphanNumbers: [],
      redactedSentences: [],
      previousAnswer: null,
    });
  });

  it("an orphan number with a clean rewrite: callText is called once, the answer text is the new one, citedPassages is recalculated, lowConfidence isn't raised on its own", async () => {
    mockCallText.mockResolvedValue("O Palmeiras perdeu por 1 x 3 para o Fluminense [p03].");
    const state = buildFinalState({
      answer: {
        text: "O Palmeiras perdeu por 1 x 3 [p03] e vinha de 4 vitórias seguidas [p05].",
        citedPassages: ["p03", "p05"],
        lowConfidence: false,
      },
      context: [
        {
          id: 3,
          score: 0.5,
          payload: {
            passageId: "p03",
            contentHash: "0".repeat(40),
            chunkIndex: 0,
            chunkCount: 1,
            text: "texto",
            title: "título",
            source: "Fixture Esportivo",
            url: "https://exemplo.invalido/fixture/p03",
            type: "chronicle",
            teams: ["palmeiras"],
            matchId: "m1",
            competition: "brasileirao-serie-a",
            matchweek: 12,
            publishedAt: "2026-09-06T08:00:00-03:00",
          },
        },
      ],
    });

    const result = await critique(state);

    expect(mockCallText).toHaveBeenCalledTimes(1);
    expect(result.state.answer.text).toBe("O Palmeiras perdeu por 1 x 3 para o Fluminense [p03].");
    expect(result.state.answer.citedPassages).toEqual(["p03"]);
    expect(result.state.answer.lowConfidence).toBe(false);
    expect(result.report.rewritten).toBe(true);
    expect(result.report.remainingOrphanNumbers).toEqual([]);
  });

  it("an orphan number that survives the rewrite: redactedSentences is non-empty, lowConfidence becomes true, callText is called exactly once (MAX_ANSWER_REWRITES)", async () => {
    mockCallText.mockResolvedValue("O Palmeiras perdeu por 1 x 3 [p03]. O time vinha de 4 vitórias seguidas [p05].");
    const state = buildFinalState({
      answer: {
        text: "O Palmeiras perdeu por 1 x 3 [p03] e vinha de 4 vitórias seguidas [p05].",
        citedPassages: ["p03", "p05"],
        lowConfidence: false,
      },
    });

    const result = await critique(state);

    expect(mockCallText).toHaveBeenCalledTimes(1);
    expect(result.report.redactedSentences.length).toBeGreaterThan(0);
    expect(result.state.answer.lowConfidence).toBe(true);
    expect(result.state.answer.text).not.toMatch(/\b4\b/);
  });

  it("callText rejecting: treated as the rewrite having spent its one shot without fixing the answer — the orphan number is redacted, not shipped, and lowConfidence is raised", async () => {
    mockCallText.mockRejectedValue(new Error("anthropic 500"));
    const state = buildFinalState({
      answer: { text: "resposta com 4 vitórias seguidas", citedPassages: [], lowConfidence: false },
    });

    const result = await critique(state);

    // The orphan number never reaches the user, call failure or not — the golden rule
    // holds even when the critic itself is unreachable.
    expect(result.state.answer.text).not.toMatch(/\b4\b/);
    expect(result.state.answer.lowConfidence).toBe(true);
    expect(result.report.error).toContain("anthropic 500");
    expect(result.report.rewritten).toBe(false);
    expect(result.report.remainingOrphanNumbers).toEqual([4]);
    expect(result.report.redactedSentences.length).toBeGreaterThan(0);
  });

  it("the critic prompt never contains the vector-index context (spec §12, golden rule)", async () => {
    mockCallText.mockResolvedValue("resposta corrigida");
    const state = buildFinalState({
      answer: { text: "resposta com 4 vitórias seguidas", citedPassages: [], lowConfidence: false },
    });

    await critique(state);

    const call = mockCallText.mock.calls[0]?.[0];
    expect(call?.user).not.toContain('<context source="vector_index">');
  });
});

describe("MAX_ANSWER_REWRITES", () => {
  it("is locked at 1", () => {
    expect(MAX_ANSWER_REWRITES).toBe(1);
  });
});
