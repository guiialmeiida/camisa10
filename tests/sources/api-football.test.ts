import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyLiveScores, fetchLiveMatches } from "../../src/sources/api-football.ts";
import type { Match } from "../../src/sources/types.ts";

const FIXTURE_PATH = path.join(import.meta.dirname, "..", "fixtures", "http", "api-football-live.json");

async function loadRawResponse(): Promise<string> {
  return readFile(FIXTURE_PATH, "utf-8");
}

const fakeEnv = {
  FOOTBALL_DATA_TOKEN: "fake-token",
  API_FOOTBALL_KEY: "fake-api-football-key",
  VOYAGE_API_KEY: "voyage-fake",
  ANTHROPIC_API_KEY: "sk-ant-fake",
  QDRANT_URL: "http://localhost:6333",
};

describe("fetchLiveMatches", () => {
  const originalEnv = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { ...process.env, ...fakeEnv };
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fetchSpy.mockRestore();
  });

  it("maps the recorded payload, ignoring fixtures whose league.id isn't 71", async () => {
    const body = await loadRawResponse();
    fetchSpy.mockResolvedValue(new Response(body, { status: 200 }));

    const liveMatches = await fetchLiveMatches();

    expect(liveMatches).toHaveLength(1);
    expect(liveMatches[0]).toMatchObject({
      homeTeam: "palmeiras",
      awayTeam: "fluminense",
      score: { home: 1, away: 0 },
      minute: 67,
    });
  });

  it("returns [] without throwing when the API reports errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ errors: { token: "invalid" }, response: [] }), { status: 200 }),
    );

    await expect(fetchLiveMatches()).resolves.toEqual([]);
    warn.mockRestore();
  });

  it("returns [] without throwing when API_FOOTBALL_KEY is missing", async () => {
    delete process.env["API_FOOTBALL_KEY"];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(fetchLiveMatches()).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("applyLiveScores", () => {
  function sampleLiveMatch(): Match {
    return {
      id: "m1",
      matchweek: 12,
      date: "2026-09-10T19:00:00-03:00",
      homeTeam: "palmeiras",
      awayTeam: "fluminense",
      venue: "Allianz Parque",
      status: "live",
      score: { home: 0, away: 0 },
      minute: 10,
    };
  }

  it("overwrites score/minute of the matched live match", () => {
    const result = applyLiveScores([sampleLiveMatch()], [
      { homeTeam: "palmeiras", awayTeam: "fluminense", score: { home: 1, away: 0 }, minute: 67 },
    ]);

    expect(result[0]).toMatchObject({ score: { home: 1, away: 0 }, minute: 67 });
  });

  it("does not touch finished or scheduled matches", () => {
    const finished: Match = {
      id: "m2",
      matchweek: 12,
      date: "2026-09-10T19:00:00-03:00",
      homeTeam: "corinthians",
      awayTeam: "bahia",
      venue: "Neo Química Arena",
      status: "finished",
      score: { home: 2, away: 1 },
    };
    const result = applyLiveScores([finished], [
      { homeTeam: "corinthians", awayTeam: "bahia", score: { home: 5, away: 5 }, minute: 90 },
    ]);

    expect(result[0]).toEqual(finished);
  });

  it("leaves a live match unchanged when no team pair matches", () => {
    const match = sampleLiveMatch();
    const result = applyLiveScores([match], [
      { homeTeam: "cruzeiro", awayTeam: "gremio", score: { home: 3, away: 3 }, minute: 80 },
    ]);

    expect(result[0]).toEqual(match);
  });
});
