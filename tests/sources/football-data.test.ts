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
    const matches = await mapMatches(raw);

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
    const matches = await mapMatches(raw);

    const match = matches.find((m) => m.id === "545231");
    expect(match?.date).toBe("2026-09-05T21:30:00-03:00");
  });

  it("maps POSTPONED to { status: 'postponed', score: null }", async () => {
    const raw = await loadRawMatchweek();
    const matches = await mapMatches(raw);

    const postponed = matches.find((match) => match.id === "545234");
    expect(postponed).toMatchObject({ status: "postponed", score: null });
  });

  it("maps IN_PLAY to { status: 'live', minute: null } before enrichment", async () => {
    const raw = await loadRawMatchweek();
    const matches = await mapMatches(raw);

    const live = matches.find((match) => match.id === "545232");
    expect(live).toMatchObject({ status: "live", minute: null, score: { home: 0, away: 0 } });
  });

  it("drops a FINISHED match with a null score instead of fabricating 0x0", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = await loadRawMatchweek();
    const matches = await mapMatches(raw);

    const dropped = matches.find((match) => match.id === "545235");
    expect(dropped).toBeUndefined();
    warn.mockRestore();
  });

  it("drops a match with an unknown status without dropping the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = await loadRawMatchweek();
    const matches = await mapMatches(raw);

    expect(matches.find((match) => match.id === "545236")).toBeUndefined();
    expect(matches.length).toBeGreaterThan(0);
    warn.mockRestore();
  });
});
