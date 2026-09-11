import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mapMatches } from "../../src/sources/football-data.ts";

const FIXTURE_PATH = path.join(import.meta.dirname, "..", "fixtures", "http", "football-data-matchweek.json");

async function loadRawMatchweek(): Promise<unknown> {
  const raw = await readFile(FIXTURE_PATH, "utf-8");
  return JSON.parse(raw);
}

describe("mapMatches", () => {
  it("maps the recorded payload to Match[] with the right slug, status and score", async () => {
    const raw = await loadRawMatchweek();
    const { matches } = await mapMatches(raw);

    const palmeirasVsFluminense = matches.find((match) => match.id === "545231");
    expect(palmeirasVsFluminense).toMatchObject({
      status: "finished",
      homeTeam: "palmeiras",
      awayTeam: "fluminense",
      score: { home: 1, away: 3 },
      venue: "Allianz Parque",
    });
  });

  it("converts utcDate to -03:00, shifting the calendar day", async () => {
    const raw = await loadRawMatchweek();
    const { matches } = await mapMatches(raw);

    const match = matches.find((m) => m.id === "545231");
    expect(match?.date).toBe("2026-09-05T21:30:00-03:00");
  });

  it("maps POSTPONED to { status: 'postponed', score: null }", async () => {
    const raw = await loadRawMatchweek();
    const { matches } = await mapMatches(raw);

    const postponed = matches.find((match) => match.id === "545234");
    expect(postponed).toMatchObject({ status: "postponed", score: null });
  });

  it("maps IN_PLAY to { status: 'live', minute: null } before enrichment", async () => {
    const raw = await loadRawMatchweek();
    const { matches } = await mapMatches(raw);

    const live = matches.find((match) => match.id === "545232");
    expect(live).toMatchObject({ status: "live", minute: null, score: { home: 0, away: 0 } });
  });

  it("drops a FINISHED match with a null score instead of fabricating 0x0", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = await loadRawMatchweek();
    const { matches } = await mapMatches(raw);

    const dropped = matches.find((match) => match.id === "545235");
    expect(dropped).toBeUndefined();
    warn.mockRestore();
  });

  it("drops a match with an unknown status without dropping the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = await loadRawMatchweek();
    const { matches } = await mapMatches(raw);

    expect(matches.find((match) => match.id === "545236")).toBeUndefined();
    expect(matches.length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it("collects a synthetic Team for a footballDataId the curated list doesn't know about", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = JSON.stringify({
      competition: { id: 2013, name: "Campeonato Brasileiro Série A", code: "BSA" },
      matches: [
        {
          id: 9001,
          utcDate: "2026-09-06T00:30:00Z",
          status: "FINISHED",
          matchday: 12,
          venue: "Estádio X",
          homeTeam: { id: 1769, name: "SE Palmeiras" },
          awayTeam: { id: 999999, name: "Novo Time FC" },
          score: { fullTime: { home: 2, away: 0 } },
        },
      ],
    });

    const { matches, syntheticTeams } = await mapMatches(JSON.parse(raw));

    expect(matches[0]).toMatchObject({ homeTeam: "palmeiras", awayTeam: "novo-time-fc" });
    expect(syntheticTeams).toEqual([{ id: "novo-time-fc", name: "Novo Time FC", nicknames: [] }]);
    warn.mockRestore();
  });

  it("throws when every match in a non-empty response fails to map (corrupted upstream response, not an empty matchweek)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = JSON.stringify({
      competition: { id: 2013, name: "Campeonato Brasileiro Série A", code: "BSA" },
      matches: [
        {
          id: 9002,
          utcDate: "2026-09-06T00:30:00Z",
          status: "2026-09-11 23:00:00Z", // the corrupted-status shape observed live
          matchday: 27,
          venue: null,
          homeTeam: { id: 1769, name: "SE Palmeiras" },
          awayTeam: { id: 1765, name: "Fluminense FC" },
          score: { fullTime: { home: null, away: null } },
        },
      ],
    });

    await expect(mapMatches(JSON.parse(raw))).rejects.toThrow(/corrupted upstream/);
    warn.mockRestore();
  });

  it("does not throw when the response legitimately has zero matches", async () => {
    const raw = JSON.stringify({
      competition: { id: 2013, name: "Campeonato Brasileiro Série A", code: "BSA" },
      matches: [],
    });

    const { matches, syntheticTeams } = await mapMatches(JSON.parse(raw));
    expect(matches).toEqual([]);
    expect(syntheticTeams).toEqual([]);
  });
});
