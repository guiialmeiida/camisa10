import { z } from "zod";
import type { Match as DomainMatch, Passage as DomainPassage } from "../../src/sources/types.ts";

export const teamSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  nicknames: z.array(z.string().min(1)),
});

export const scoreSchema = z.strictObject({
  home: z.number().int().min(0),
  away: z.number().int().min(0),
});

const matchBase = {
  id: z.string().min(1),
  matchweek: z.number().int().positive(),
  date: z.iso.datetime({ offset: true }),
  homeTeam: z.string().min(1),
  awayTeam: z.string().min(1),
  venue: z.string().min(1),
};

// Discriminated union: "a scheduled match has no score" becomes a type invariant,
// not a sentence in the spec someone can forget.
export const matchSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...matchBase, status: z.literal("finished"), score: scoreSchema }),
  z.strictObject({
    ...matchBase,
    status: z.literal("live"),
    score: scoreSchema,
    minute: z.number().int().nullable(),
  }),
  z.strictObject({ ...matchBase, status: z.literal("scheduled"), score: z.null() }),
]);

export const passageSchema = z.strictObject({
  id: z.string().min(1),
  matchId: z.string().min(1),
  teams: z.array(z.string().min(1)).min(1),
  type: z.enum(["article", "chronicle", "matchReport", "preview"]),
  title: z.string().min(1),
  source: z.string().min(1),
  url: z.url(),
  publishedAt: z.iso.datetime({ offset: true }),
  text: z.string().min(1),
});

export const fixtureSchema = z
  .strictObject({
    _warning: z.string(),
    competition: z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1),
      season: z.number().int(),
    }),
    matchweek: z.number().int().positive(),
    teams: z.array(teamSchema).min(1),
    matches: z.array(matchSchema).min(1),
    passages: z.array(passageSchema).min(1),
  })
  .superRefine((fixture, ctx) => {
    // Referential integrity: every homeTeam/awayTeam/passage.teams exists in `teams`,
    // and every passage.matchId exists in `matches`. Catches a typo in the fixture
    // before it turns into unexplainable bad recall.
    const teamIds = new Set(fixture.teams.map((team) => team.id));
    const matchIds = new Set(fixture.matches.map((match) => match.id));

    fixture.matches.forEach((match, index) => {
      if (!teamIds.has(match.homeTeam)) {
        ctx.addIssue({
          code: "custom",
          message: `match "${match.id}": homeTeam "${match.homeTeam}" is not a known team`,
          path: ["matches", index, "homeTeam"],
        });
      }
      if (!teamIds.has(match.awayTeam)) {
        ctx.addIssue({
          code: "custom",
          message: `match "${match.id}": awayTeam "${match.awayTeam}" is not a known team`,
          path: ["matches", index, "awayTeam"],
        });
      }
    });

    fixture.passages.forEach((passage, index) => {
      if (!matchIds.has(passage.matchId)) {
        ctx.addIssue({
          code: "custom",
          message: `passage "${passage.id}": matchId "${passage.matchId}" is not a known match`,
          path: ["passages", index, "matchId"],
        });
      }
      passage.teams.forEach((team, teamIndex) => {
        if (!teamIds.has(team)) {
          ctx.addIssue({
            code: "custom",
            message: `passage "${passage.id}": team "${team}" is not a known team`,
            path: ["passages", index, "teams", teamIndex],
          });
        }
      });
    });
  });

export type Fixture = z.infer<typeof fixtureSchema>;
export type Team = z.infer<typeof teamSchema>;
export type Match = z.infer<typeof matchSchema>;
export type Passage = z.infer<typeof passageSchema>;
export type MatchStatus = Match["status"]; // "finished" | "live" | "scheduled"
export type PassageType = Passage["type"];

// Compile-time check (spec §12): if the fixture's dummy shape and the real domain type
// (src/sources/types.ts) ever diverge, `tsc` refuses to compile instead of a test quietly
// passing against a shape production doesn't use anymore.
({} as Match) satisfies DomainMatch;
({} as Passage) satisfies DomainPassage;
