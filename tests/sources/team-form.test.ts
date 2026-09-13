import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/sources/football-data.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sources/football-data.ts")>();
  return { ...actual, fetchTeamMatches: vi.fn() };
});
vi.mock("../../src/sources/teams.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sources/teams.ts")>();
  return { ...actual, footballDataIdFor: vi.fn() };
});

const { fetchTeamMatches } = await import("../../src/sources/football-data.ts");
const { footballDataIdFor } = await import("../../src/sources/teams.ts");
const { FORM_FETCH_LIMIT, RECENT_FORM_SIZE, getTeamForm, mapTeamForm } = await import(
  "../../src/sources/team-form.ts"
);

const mockFetchTeamMatches = vi.mocked(fetchTeamMatches);
const mockFootballDataIdFor = vi.mocked(footballDataIdFor);

const FIXTURE_PATH = path.join(import.meta.dirname, "..", "fixtures", "http", "football-data-team-matches.json");

async function loadRawTeamMatches(): Promise<unknown> {
  const raw = await readFile(FIXTURE_PATH, "utf-8");
  return JSON.parse(raw);
}

describe("mapTeamForm — against the real body recorded live (task 05, §2)", () => {
  it("splits into BSA-only matches (most recent first, cut to RECENT_FORM_SIZE) and a single otherCompetitionMatch", async () => {
    const raw = await loadRawTeamMatches();
    const form = await mapTeamForm("palmeiras", 1769, raw);

    expect(form.matches).toHaveLength(RECENT_FORM_SIZE);
    expect(form.matches.map((m) => m.id)).toEqual(["554990", "554986", "554977", "554964", "554957"]);
    for (const match of form.matches) {
      expect(match.competition.code).toBe("BSA");
    }

    expect(form.otherCompetitionMatch?.id).toBe("557182");
    expect(form.otherCompetitionMatch?.competition).toEqual({ code: "CLI", name: "Copa Libertadores" });

    // No overlap between the two — the invariant the emendment exists to enforce.
    const matchIds = new Set(form.matches.map((m) => m.id));
    expect(matchIds.has(form.otherCompetitionMatch?.id ?? "")).toBe(false);
  });

  it("sorts by date descending regardless of the API's own order (the live call came back ascending)", async () => {
    const raw = await loadRawTeamMatches();
    const form = await mapTeamForm("palmeiras", 1769, raw);

    const timestamps = form.matches.map((m) => Date.parse(m.date));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });

  it("maps side, opponent, literal score and result for a home match and an away match", async () => {
    const raw = await loadRawTeamMatches();
    const form = await mapTeamForm("palmeiras", 1769, raw);

    const homeWin = form.matches.find((m) => m.id === "554977");
    expect(homeWin).toMatchObject({
      side: "home",
      opponent: "vasco",
      score: { home: 4, away: 1 },
      result: "win",
    });

    const awayLoss = form.matches.find((m) => m.id === "554964");
    expect(awayLoss).toMatchObject({
      side: "away",
      opponent: "fluminense",
      score: { home: 3, away: 2 },
      result: "loss",
    });
  });

  it("converts utcDate to -03:00", async () => {
    const raw = await loadRawTeamMatches();
    const form = await mapTeamForm("palmeiras", 1769, raw);

    const match = form.matches.find((m) => m.id === "554977");
    expect(match?.date).toBe("2026-08-23T16:00:00-03:00");
  });

  it("the golden-rule invariant: wins + draws + losses === matches.length, and otherCompetitionMatch never feeds the record", async () => {
    const raw = await loadRawTeamMatches();
    const form = await mapTeamForm("palmeiras", 1769, raw);

    expect(form.record.wins + form.record.draws + form.record.losses).toBe(form.matches.length);
    expect(form.record).toEqual({ wins: 1, draws: 3, losses: 1 });
    // The CLI match is a win too, but it must not have bumped record.wins to 2.
    expect(form.otherCompetitionMatch?.result).toBe("win");
  });

  it("a match from another competition more recent than every BSA match still doesn't enter matches or shift the cut", async () => {
    const raw = await loadRawTeamMatches();
    const form = await mapTeamForm("palmeiras", 1769, raw);

    // The most recent match overall is CLI (2026-09-09) — if the partition were "first 5
    // of the sorted list" instead of a real per-competition split, it would show up here.
    expect(form.matches.some((m) => m.id === "557182")).toBe(false);
  });

  it("two or more matches outside BSA -> otherCompetitionMatch is the one with the latest date, and only one", async () => {
    const raw = await loadRawTeamMatches();
    const form = await mapTeamForm("palmeiras", 1769, raw);

    // The fixture has three CLI matches (557182, 564466, 564459); only the most recent
    // (557182, 2026-09-09) may end up as otherCompetitionMatch.
    expect(form.otherCompetitionMatch?.id).toBe("557182");
  });

  it("resolves an opponent unknown to teams.json to a synthetic slug, keeping the match", async () => {
    const raw = await loadRawTeamMatches();
    const form = await mapTeamForm("palmeiras", 1769, raw);

    expect(form.otherCompetitionMatch?.opponent).toBe("ldu-de-quito");
  });

  it("drops a match with no final score without dropping the others, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = {
      matches: [
        {
          id: 1,
          utcDate: "2026-09-06T00:30:00Z",
          status: "FINISHED",
          competition: { code: "BSA", name: "Campeonato Brasileiro Série A" },
          homeTeam: { id: 1769, name: "SE Palmeiras" },
          awayTeam: { id: 1765, name: "Fluminense FC" },
          score: { fullTime: { home: null, away: null } },
        },
      ],
    };

    const form = await mapTeamForm("palmeiras", 1769, raw);

    expect(form.matches).toEqual([]);
    expect(form.record).toEqual({ wins: 0, draws: 0, losses: 0 });
    warn.mockRestore();
  });

  it("drops a match whose status isn't final, without dropping the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = {
      matches: [
        {
          id: 1,
          utcDate: "2026-09-06T00:30:00Z",
          status: "SCHEDULED",
          competition: { code: "BSA", name: "Campeonato Brasileiro Série A" },
          homeTeam: { id: 1769, name: "SE Palmeiras" },
          awayTeam: { id: 1765, name: "Fluminense FC" },
          score: { fullTime: { home: null, away: null } },
        },
        {
          id: 2,
          utcDate: "2026-09-05T00:30:00Z",
          status: "FINISHED",
          competition: { code: "BSA", name: "Campeonato Brasileiro Série A" },
          homeTeam: { id: 1769, name: "SE Palmeiras" },
          awayTeam: { id: 1765, name: "Fluminense FC" },
          score: { fullTime: { home: 2, away: 1 } },
        },
      ],
    };

    const form = await mapTeamForm("palmeiras", 1769, raw);

    expect(form.matches.map((m) => m.id)).toEqual(["2"]);
    warn.mockRestore();
  });

  it("drops a match in which the requested team appears on neither side", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = {
      matches: [
        {
          id: 1,
          utcDate: "2026-09-06T00:30:00Z",
          status: "FINISHED",
          competition: { code: "BSA", name: "Campeonato Brasileiro Série A" },
          homeTeam: { id: 1765, name: "Fluminense FC" },
          awayTeam: { id: 1777, name: "EC Bahia" },
          score: { fullTime: { home: 1, away: 1 } },
        },
      ],
    };

    const form = await mapTeamForm("palmeiras", 1769, raw);

    expect(form.matches).toEqual([]);
    warn.mockRestore();
  });

  it("a match with an unusable competition — absent, null, or present without code/name — is dropped from both sides of the partition, even the most recent one, without failing the whole body's validation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = {
      matches: [
        // `competition` field entirely absent.
        {
          id: 1,
          utcDate: "2026-09-06T00:30:00Z",
          status: "FINISHED",
          homeTeam: { id: 1769, name: "SE Palmeiras" },
          awayTeam: { id: 1765, name: "Fluminense FC" },
          score: { fullTime: { home: 2, away: 0 } },
        },
        // `competition: null`.
        {
          id: 2,
          utcDate: "2026-09-05T00:30:00Z",
          status: "FINISHED",
          competition: null,
          homeTeam: { id: 1769, name: "SE Palmeiras" },
          awayTeam: { id: 1765, name: "Fluminense FC" },
          score: { fullTime: { home: 1, away: 1 } },
        },
        // `competition` present but missing both `code` and `name` — the schema must
        // still validate this (achado 1: a stricter schema would fail the entire body's
        // safeParse over this one game instead of letting mapTeamForm drop just it).
        {
          id: 3,
          utcDate: "2026-09-04T00:30:00Z",
          status: "FINISHED",
          competition: { id: 2013 },
          homeTeam: { id: 1769, name: "SE Palmeiras" },
          awayTeam: { id: 1765, name: "Fluminense FC" },
          score: { fullTime: { home: 3, away: 0 } },
        },
        {
          id: 4,
          utcDate: "2026-09-01T00:30:00Z",
          status: "FINISHED",
          competition: { code: "CLI", name: "Copa Libertadores" },
          homeTeam: { id: 1769, name: "SE Palmeiras" },
          awayTeam: { id: 6684, name: "CA River Plate" },
          score: { fullTime: { home: 1, away: 1 } },
        },
      ],
    };

    const form = await mapTeamForm("palmeiras", 1769, raw);

    expect(form.matches).toEqual([]);
    // Every unusable-competition match (ids 1-3) is more recent than the CLI one, yet the
    // CLI match — not one of them — becomes otherCompetitionMatch.
    expect(form.otherCompetitionMatch?.id).toBe("4");
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("no match from the competition among those fetched -> matches: [] and record zeroed, otherCompetitionMatch unaffected", async () => {
    const raw = {
      matches: [
        {
          id: 1,
          utcDate: "2026-09-06T00:30:00Z",
          status: "FINISHED",
          competition: { code: "CLI", name: "Copa Libertadores" },
          homeTeam: { id: 1769, name: "SE Palmeiras" },
          awayTeam: { id: 6684, name: "CA River Plate" },
          score: { fullTime: { home: 2, away: 0 } },
        },
      ],
    };

    const form = await mapTeamForm("palmeiras", 1769, raw);

    expect(form.matches).toEqual([]);
    expect(form.record).toEqual({ wins: 0, draws: 0, losses: 0 });
    expect(form.otherCompetitionMatch?.id).toBe("1");
  });

  it("no match outside the competition -> otherCompetitionMatch: null, matches and record intact", async () => {
    const raw = {
      matches: [
        {
          id: 1,
          utcDate: "2026-09-06T00:30:00Z",
          status: "FINISHED",
          competition: { code: "BSA", name: "Campeonato Brasileiro Série A" },
          homeTeam: { id: 1769, name: "SE Palmeiras" },
          awayTeam: { id: 1765, name: "Fluminense FC" },
          score: { fullTime: { home: 2, away: 0 } },
        },
      ],
    };

    const form = await mapTeamForm("palmeiras", 1769, raw);

    expect(form.otherCompetitionMatch).toBeNull();
    expect(form.matches).toHaveLength(1);
    expect(form.record).toEqual({ wins: 1, draws: 0, losses: 0 });
  });

  it("an empty matches array is a valid response, not an error", async () => {
    const form = await mapTeamForm("palmeiras", 1769, { matches: [] });

    expect(form).toEqual({
      team: "palmeiras",
      matches: [],
      otherCompetitionMatch: null,
      record: { wins: 0, draws: 0, losses: 0 },
      source: "api",
    });
  });

  it("throws with a prettified message when the body fails validation", async () => {
    await expect(mapTeamForm("palmeiras", 1769, { matches: "not an array" })).rejects.toThrow(/validation/);
  });

  it("locks the discovery constants", () => {
    expect(FORM_FETCH_LIMIT).toBe(20);
    expect(RECENT_FORM_SIZE).toBe(5);
  });
});

describe("getTeamForm", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...process.env,
      FOOTBALL_DATA_TOKEN: "fake-token",
      VOYAGE_API_KEY: "voyage-fake",
      ANTHROPIC_API_KEY: "sk-ant-fake",
      QDRANT_URL: "http://localhost:6333",
    };
    mockFetchTeamMatches.mockReset();
    mockFootballDataIdFor.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves the footballDataId and fetches with FORM_FETCH_LIMIT, not RECENT_FORM_SIZE", async () => {
    mockFootballDataIdFor.mockResolvedValue(1769);
    mockFetchTeamMatches.mockResolvedValue({ matches: [] });

    await getTeamForm("palmeiras");

    expect(mockFootballDataIdFor).toHaveBeenCalledWith("palmeiras");
    expect(mockFetchTeamMatches).toHaveBeenCalledWith(1769, FORM_FETCH_LIMIT);
    expect(mockFetchTeamMatches).not.toHaveBeenCalledWith(1769, RECENT_FORM_SIZE);
  });

  it("throws when the team id isn't in teams.json", async () => {
    mockFootballDataIdFor.mockResolvedValue(null);

    await expect(getTeamForm("time-que-nao-existe")).rejects.toThrow(/unknown team id/);
    expect(mockFetchTeamMatches).not.toHaveBeenCalled();
  });
});
