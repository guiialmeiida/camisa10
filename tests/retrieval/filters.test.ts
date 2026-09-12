import { describe, expect, it } from "vitest";
import { CURRENT_MATCHWEEK_LOOKBACK_DAYS, buildCurrentMatchweekFilter } from "../../src/retrieval/filters.ts";
import type { Facts, Match } from "../../src/sources/index.ts";

function buildFacts(matches: Match[]): Facts {
  return {
    competition: { id: "brasileirao-serie-a", name: "Brasileirão Série A", season: 2026 },
    matchweek: 27,
    matches,
    teams: [],
    source: "api",
  };
}

// Same fixture as spec §3's literal example — dates deliberately out of chronological
// order, with the earliest match (m1) in the last position.
function specExampleMatches(): Match[] {
  return [
    {
      id: "m2",
      matchweek: 27,
      date: "2026-09-06T18:30:00-03:00",
      status: "finished",
      homeTeam: "flamengo",
      awayTeam: "santos",
      score: { home: 2, away: 0 },
      venue: "Maracanã",
    },
    {
      id: "m1",
      matchweek: 27,
      date: "2026-09-05T21:30:00-03:00",
      status: "finished",
      homeTeam: "palmeiras",
      awayTeam: "fluminense",
      score: { home: 1, away: 3 },
      venue: "Allianz Parque",
    },
    {
      id: "m3",
      matchweek: 27,
      date: "2026-09-08T20:00:00-03:00",
      status: "scheduled",
      homeTeam: "corinthians",
      awayTeam: "palmeiras",
      score: null,
      venue: "Neo Química Arena",
    },
  ];
}

describe("buildCurrentMatchweekFilter", () => {
  it("derives the window from the minimum date, not the first array element", () => {
    const now = new Date("2026-09-07T15:00:00.000Z");
    const filter = buildCurrentMatchweekFilter({ facts: buildFacts(specExampleMatches()), team: null, now });

    // m1 (05/09 21:30 -03:00 = 06/09 00:30 UTC) is the earliest match, and it sits last
    // in the array — this is exactly the test that traps a matches[0] bug.
    expect(filter).toEqual({
      must: [{ key: "publishedAt", range: { gte: "2026-09-03T00:30:00.000Z", lte: "2026-09-07T15:00:00.000Z" } }],
    });
  });

  it("matches the spec §3 literal example exactly, with both clauses in order", () => {
    const now = new Date("2026-09-07T15:00:00.000Z");
    const filter = buildCurrentMatchweekFilter({ facts: buildFacts(specExampleMatches()), team: "palmeiras", now });

    expect(filter).toEqual({
      must: [
        { key: "publishedAt", range: { gte: "2026-09-03T00:30:00.000Z", lte: "2026-09-07T15:00:00.000Z" } },
        { key: "teams", match: { value: "palmeiras" } },
      ],
    });
  });

  it("sets lte to exactly now.toISOString()", () => {
    const now = new Date("2026-09-07T15:00:00.000Z");
    const filter = buildCurrentMatchweekFilter({ facts: buildFacts(specExampleMatches()), team: null, now });

    expect(filter?.must).toEqual([
      expect.objectContaining({ range: expect.objectContaining({ lte: now.toISOString() }) }),
    ]);
  });

  it("only the publishedAt clause when team is null", () => {
    const now = new Date("2026-09-07T15:00:00.000Z");
    const filter = buildCurrentMatchweekFilter({ facts: buildFacts(specExampleMatches()), team: null, now });

    expect(filter).toEqual({
      must: [{ key: "publishedAt", range: { gte: "2026-09-03T00:30:00.000Z", lte: "2026-09-07T15:00:00.000Z" } }],
    });
  });

  it("only the teams clause when there are no matches", () => {
    const filter = buildCurrentMatchweekFilter({ facts: buildFacts([]), team: "palmeiras" });

    expect(filter).toEqual({ must: [{ key: "teams", match: { value: "palmeiras" } }] });
  });

  it("returns null when facts is null and team is null", () => {
    expect(buildCurrentMatchweekFilter({ facts: null, team: null })).toBeNull();
  });

  it("only the teams clause when facts is null but team is given", () => {
    const filter = buildCurrentMatchweekFilter({ facts: null, team: "palmeiras" });

    expect(filter).toEqual({ must: [{ key: "teams", match: { value: "palmeiras" } }] });
  });

  it("drops the date clause when the window would be empty (from is in the future)", () => {
    // Every match is 5 days ahead of "now" — from (match date - 3 days) lands after now.
    const now = new Date("2026-09-01T00:00:00.000Z");
    const matches: Match[] = [
      {
        id: "m1",
        matchweek: 27,
        date: "2026-09-06T00:00:00.000Z",
        status: "scheduled",
        homeTeam: "palmeiras",
        awayTeam: "santos",
        score: null,
        venue: null,
      },
    ];

    expect(buildCurrentMatchweekFilter({ facts: buildFacts(matches), team: null, now })).toBeNull();
  });

  it("ignores an unparseable date and derives the window from the valid ones", () => {
    const now = new Date("2026-09-07T15:00:00.000Z");
    const matches: Match[] = [
      {
        id: "m1",
        matchweek: 27,
        date: "not a date",
        status: "scheduled",
        homeTeam: "palmeiras",
        awayTeam: "santos",
        score: null,
        venue: null,
      },
      {
        id: "m2",
        matchweek: 27,
        date: "2026-09-05T21:30:00-03:00",
        status: "finished",
        homeTeam: "flamengo",
        awayTeam: "santos",
        score: { home: 1, away: 0 },
        venue: "Maracanã",
      },
    ];

    const filter = buildCurrentMatchweekFilter({ facts: buildFacts(matches), team: null, now });

    expect(filter).toEqual({
      must: [{ key: "publishedAt", range: { gte: "2026-09-03T00:30:00.000Z", lte: "2026-09-07T15:00:00.000Z" } }],
    });
  });

  it("drops the date clause entirely when every date is unparseable", () => {
    const matches: Match[] = [
      {
        id: "m1",
        matchweek: 27,
        date: "not a date",
        status: "scheduled",
        homeTeam: "palmeiras",
        awayTeam: "santos",
        score: null,
        venue: null,
      },
    ];

    expect(buildCurrentMatchweekFilter({ facts: buildFacts(matches), team: null })).toBeNull();
  });

  it("treats a whitespace-only team as absent", () => {
    const filter = buildCurrentMatchweekFilter({ facts: buildFacts([]), team: "  " });

    expect(filter).toBeNull();
  });

  it("uses a 3-day lookback, counted as whole days from the same time of day", () => {
    expect(CURRENT_MATCHWEEK_LOOKBACK_DAYS).toBe(3);

    const now = new Date("2026-09-08T21:30:00-03:00");
    const matches: Match[] = [
      {
        id: "m1",
        matchweek: 27,
        date: "2026-09-08T21:30:00-03:00",
        status: "scheduled",
        homeTeam: "palmeiras",
        awayTeam: "santos",
        score: null,
        venue: null,
      },
    ];

    const filter = buildCurrentMatchweekFilter({ facts: buildFacts(matches), team: null, now });

    // now is 2026-09-08T21:30:00-03:00 = 2026-09-09T00:30:00.000Z; three whole days
    // earlier, at the same clock time, is 2026-09-06T00:30:00.000Z.
    expect(filter).toEqual({
      must: [{ key: "publishedAt", range: { gte: "2026-09-06T00:30:00.000Z", lte: now.toISOString() } }],
    });
  });
});
