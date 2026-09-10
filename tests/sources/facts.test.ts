import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFacts } from "../../src/sources/facts.ts";
import { listPassages } from "../../src/sources/passages.ts";

const FIXTURES_DIR = path.join(import.meta.dirname, "..", "fixtures", "http");

async function readFixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURES_DIR, name), "utf-8");
}

const fakeEnv = {
  FOOTBALL_DATA_TOKEN: "fake-token",
  API_FOOTBALL_KEY: "fake-api-football-key",
  VOYAGE_API_KEY: "voyage-fake",
  ANTHROPIC_API_KEY: "sk-ant-fake",
  QDRANT_URL: "http://localhost:6333",
};

function jsonResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, { status: init.status ?? 200, ...(init.headers ? { headers: init.headers } : {}) });
}

function hostOf(input: unknown): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  return new URL(url).hostname;
}

describe("getFacts (fetch mocked)", () => {
  const originalEnv = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let competitionJson: string;
  let matchweekJson: string;

  beforeEach(async () => {
    process.env = { ...process.env, ...fakeEnv };
    competitionJson = await readFixture("football-data-competition.json");
    matchweekJson = await readFixture("football-data-matchweek.json");
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  function routeFetch(handlers: {
    footballData?: (url: URL) => Response;
    apiFootball?: (url: URL) => Response;
  }): void {
    fetchSpy.mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
      const realUrl = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );

      if (realUrl.hostname === "api.football-data.org") {
        if (!handlers.footballData) throw new Error("unexpected football-data.org request");
        return handlers.footballData(realUrl);
      }
      if (realUrl.hostname === "v3.football.api-sports.io") {
        if (!handlers.apiFootball) throw new Error("unexpected api-sports.io request");
        return handlers.apiFootball(realUrl);
      }
      throw new Error(`unexpected fetch to ${realUrl.hostname}`);
    });
  }

  function footballDataRouter(matchweekBody: string) {
    return (url: URL): Response =>
      url.pathname.endsWith("/matches") ? jsonResponse(matchweekBody) : jsonResponse(competitionJson);
  }

  it("uses the competition's currentMatchday when matchweek is not given", async () => {
    routeFetch({ footballData: footballDataRouter(matchweekJson) });

    const facts = await getFacts({});

    expect(facts.matchweek).toBe(12);
    expect(facts.matches.length).toBeGreaterThan(0);
  });

  it("filters by team client-side; unknown team returns matches: [] without throwing", async () => {
    routeFetch({ footballData: footballDataRouter(matchweekJson) });

    const withTeam = await getFacts({ team: "palmeiras" });
    expect(withTeam.matches.length).toBeGreaterThan(0);
    expect(
      withTeam.matches.every((match) => match.homeTeam === "palmeiras" || match.awayTeam === "palmeiras"),
    ).toBe(true);

    const unknown = await getFacts({ team: "totally-unknown-team" });
    expect(unknown.matches).toEqual([]);
  });

  it("returns matches: [] for a different competition, without throwing", async () => {
    routeFetch({ footballData: footballDataRouter(matchweekJson) });

    const facts = await getFacts({ competition: "premier-league" });
    expect(facts.matches).toEqual([]);
  });

  it("throws with a message citing the rate limit on a 429 from football-data.org", async () => {
    routeFetch({
      footballData: () => jsonResponse("{}", { status: 429, headers: { "X-RequestCounter-Reset": "42" } }),
    });

    await expect(getFacts({})).rejects.toThrow(/rate limit/i);
  });

  it("never calls api-football when no match is live", async () => {
    const noLiveMatchweek = JSON.stringify({
      competition: { id: 2013, name: "Campeonato Brasileiro Série A", code: "BSA" },
      matches: [
        {
          id: 1,
          utcDate: "2026-09-06T00:30:00Z",
          status: "FINISHED",
          matchday: 12,
          venue: "Allianz Parque",
          homeTeam: { id: 1769, name: "SE Palmeiras" },
          awayTeam: { id: 1765, name: "Fluminense FC" },
          score: { fullTime: { home: 1, away: 3 } },
        },
      ],
    });

    routeFetch({
      footballData: footballDataRouter(noLiveMatchweek),
      apiFootball: () => {
        throw new Error("api-football should not have been called");
      },
    });

    const facts = await getFacts({});
    expect(facts.matches).toHaveLength(1);
  });

  it("resolves with football-data.org's score when api-football returns 500", async () => {
    routeFetch({
      footballData: footballDataRouter(matchweekJson),
      apiFootball: () => jsonResponse("{}", { status: 500 }),
    });

    const facts = await getFacts({});
    const live = facts.matches.find((match) => match.status === "live");

    expect(live).toBeDefined();
    if (live?.status === "live") {
      expect(live.score).toEqual({ home: 0, away: 0 }); // football-data.org's own score, unenriched
    }
  });

  it("only ever requests api.football-data.org and v3.football.api-sports.io — never the RSS host", async () => {
    routeFetch({
      footballData: footballDataRouter(matchweekJson),
      apiFootball: () => jsonResponse(JSON.stringify({ errors: [], response: [] })),
    });

    await getFacts({});

    const hosts = new Set(fetchSpy.mock.calls.map((call: unknown[]) => hostOf(call[0])));
    expect(hosts).toEqual(new Set(["api.football-data.org", "v3.football.api-sports.io"]));
  });
});

describe("listPassages source isolation", () => {
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

  it("only requests the RSS feed host — never the structured APIs", async () => {
    const feedXml = await readFixture("gazeta-feed.xml");
    fetchSpy.mockResolvedValue(new Response(feedXml, { status: 200 }));

    await listPassages();

    const hosts = new Set(fetchSpy.mock.calls.map((call: unknown[]) => hostOf(call[0])));
    expect(hosts).toEqual(new Set(["www.gazetaesportiva.com"]));
  });
});
