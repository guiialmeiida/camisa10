import { RSS_FEEDS } from "./feeds.ts";
import { fetchFeed } from "./rss.ts";
import { tagTeams } from "./teams.ts";
import type { Passage } from "./types.ts";

/**
 * Narrative text, for ingestion only — never called at question time. Only ever talks to
 * the RSS feeds, never to the structured APIs: the golden rule's other half, made literal.
 */
export async function listPassages(): Promise<Passage[]> {
  const settled = await Promise.allSettled(RSS_FEEDS.map((feed) => fetchFeed(feed)));

  const collected: Passage[] = [];
  let failures = 0;

  settled.forEach((result, index) => {
    const feed = RSS_FEEDS[index];
    if (result.status === "fulfilled") {
      collected.push(...result.value);
    } else {
      failures += 1;
      console.warn(`passages.ts: feed "${feed?.name}" failed — ${describeError(result.reason)}`);
    }
  });

  // Deliberate: indexPassages() recreates the collection destructively, so an empty list
  // caused by a network blip would silently wipe the whole index. Better to fail loud here.
  if (failures === settled.length) {
    throw new Error("passages.ts: every RSS feed failed — refusing to return an empty passage list");
  }

  const deduped = new Map<string, Passage>();
  for (const passage of collected) {
    deduped.set(passage.id, passage);
  }

  const tagged = await Promise.all(
    [...deduped.values()].map(async (passage) => ({
      ...passage,
      teams: await tagTeams(`${passage.title} ${passage.text}`),
    })),
  );

  // Approved spec decision (docs/tasks/01-data-sources.md, open point 2): an off-topic
  // item (volleyball, F1, ...) with no recognized team is dropped rather than indexed —
  // an index polluted with unrelated news would hurt npm run ask from this very task.
  const onTopic = tagged.filter((passage) => passage.teams.length > 0);

  return onTopic.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
