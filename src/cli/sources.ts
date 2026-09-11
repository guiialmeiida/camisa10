import "dotenv/config";
import { getFacts, listPassages } from "../sources/index.ts";
import { RSS_FEEDS } from "../sources/feeds.ts";
import { formatMatchDateTime, teamName } from "../generation/match-format.ts";
import type { Match, Team } from "../sources/index.ts";

function formatMatchLine(match: Match, teams: Team[]): string {
  const homeName = teamName(match.homeTeam, teams).padEnd(24);
  const awayName = teamName(match.awayTeam, teams);
  const date = formatMatchDateTime(match.date);

  if (match.status === "scheduled") {
    return `  ${homeName} x ${awayName.padEnd(24)}   scheduled   ${date}   ${match.venue ?? "—"}`;
  }
  if (match.status === "postponed") {
    return `  ${homeName} x ${awayName.padEnd(24)}   postponed   —              —`;
  }

  const minuteSuffix = match.status === "live" && match.minute !== null ? ` (${match.minute}')` : "";
  const score = `${match.score.home} x ${match.score.away}`;
  return `  ${homeName} ${score.padEnd(6)} ${awayName.padEnd(24)}   ${match.status}${minuteSuffix}   ${date}   ${match.venue ?? "—"}`;
}

/**
 * Prints the real sources' output directly — no LLM call, no Qdrant. Useful to see
 * football-data.org/api-football/RSS working on their own, and to tell apart a bad
 * source from a bad agent when an answer looks wrong.
 */
async function main(): Promise<void> {
  const facts = await getFacts({});

  console.log(`competition: ${facts.competition.name} (${facts.competition.id}), season ${facts.competition.season}`);
  console.log(`current matchweek: ${facts.matchweek}   (source: ${facts.source})`);
  console.log("");
  console.log("matches");
  if (facts.matches.length === 0) {
    console.log("  (no matches for this matchweek)");
  }
  for (const match of facts.matches) {
    console.log(formatMatchLine(match, facts.teams));
  }

  const passages = await listPassages();
  console.log("");
  console.log(`passages (${RSS_FEEDS.length} feed${RSS_FEEDS.length === 1 ? "" : "s"}, ${passages.length} items)`);
  for (const passage of passages.slice(0, 20)) {
    const date = formatMatchDateTime(passage.publishedAt);
    const teams = passage.teams.length > 0 ? `[${passage.teams.join(", ")}]` : "[]";
    console.log(`  ${passage.id}  ${date}  ${teams}  ${passage.title}`);
  }
  if (passages.length > 20) {
    console.log(`  … and ${passages.length - 20} more`);
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
