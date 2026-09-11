import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { fetchText } from "./http.ts";
import { toSaoPauloIso } from "./time.ts";
import type { Feed } from "./feeds.ts";
import type { Passage } from "./types.ts";

// A channel with a single <item> makes fast-xml-parser return an object, not a
// one-element array — the difference only shows up on a thin feed, in production, on a
// Sunday. `isArray` forces `item` to always be an array.
const parser = new XMLParser({ isArray: (name) => name === "item" });

interface RssItem {
  title?: unknown;
  link?: unknown;
  pubDate?: unknown;
  description?: unknown;
  "content:encoded"?: unknown;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) {
    return textOf((value as Record<string, unknown>)["#text"]);
  }
  return "";
}

/** Removes script/style blocks, tags and HTML entities; collapses whitespace. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pure: raw XML -> passages. Tested against a recorded feed, no network.
 *
 * `teams` always comes back `[]` here — tagging against the curated team list
 * (`tagTeams`, src/sources/teams.ts) needs an async file read, and this function's
 * signature is deliberately synchronous so it stays trivially testable without any
 * async setup. `listPassages` (src/sources/passages.ts) does the tagging as its own
 * step, right after collecting passages from every feed.
 */
export function parseFeed(xml: string, feed: Feed): Passage[] {
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: RssItem[] } } };
  const items = doc.rss?.channel?.item ?? [];

  const passages: Passage[] = [];

  for (const item of items) {
    const title = textOf(item.title).trim();
    const url = textOf(item.link).trim();
    const pubDate = textOf(item.pubDate).trim();
    const rawText = textOf(item["content:encoded"]) || textOf(item.description);
    const text = stripHtml(rawText);

    if (!title || !url || !pubDate || !text) continue;

    // A single unparseable <pubDate> is an item-level problem, not a feed-level one —
    // spec §9/§13 only escalates to an exception when the whole feed is unreachable.
    // Letting toSaoPauloIso's throw propagate here would take fetchFeed's one bad date
    // and turn it into "the only configured feed failed" -> listPassages throws ->
    // npm run index refuses to run.
    let publishedAt: string;
    try {
      publishedAt = toSaoPauloIso(pubDate);
    } catch (error) {
      console.warn(
        `rss.ts: item "${title}" from "${feed.name}" has an unparseable pubDate "${pubDate}" — dropped (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }

    passages.push({
      id: createHash("sha1").update(url).digest("hex").slice(0, 12),
      matchId: null,
      teams: [],
      type: "article",
      title,
      source: feed.name,
      url,
      publishedAt,
      text,
    });
  }

  return passages;
}

/** GET of the feed + parseFeed. Throws on network/HTTP error or invalid XML. */
export async function fetchFeed(feed: Feed): Promise<Passage[]> {
  const xml = await fetchText(feed.url, { timeoutMs: 10_000 });

  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(`invalid XML from feed "${feed.name}" (${feed.url}): ${validation.err.msg}`);
  }

  return parseFeed(xml, feed);
}
