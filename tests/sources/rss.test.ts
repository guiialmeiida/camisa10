import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFeed, stripHtml } from "../../src/sources/rss.ts";
import type { Passage } from "../../src/sources/types.ts";

const FEED_PATH = path.join(import.meta.dirname, "..", "fixtures", "http", "gazeta-feed.xml");
const FEED = { name: "Gazeta Esportiva", url: "https://www.gazetaesportiva.com/feed/" };

const PASSAGE_KEYS: (keyof Passage)[] = [
  "id",
  "matchId",
  "teams",
  "type",
  "title",
  "source",
  "url",
  "publishedAt",
  "text",
];

async function loadRecordedFeed(): Promise<string> {
  return readFile(FEED_PATH, "utf-8");
}

function buildRssDocument(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Feed de teste</title>
  <link>https://exemplo.invalido/</link>
  <description>teste</description>
  ${items}
</channel>
</rss>`;
}

describe("parseFeed", () => {
  it("produces N passages with title, url, text with no HTML tags and publishedAt in -03:00", async () => {
    const xml = await loadRecordedFeed();
    const passages = parseFeed(xml, FEED);

    expect(passages.length).toBeGreaterThan(0);
    for (const passage of passages) {
      expect(passage.title.length).toBeGreaterThan(0);
      expect(passage.url).toMatch(/^https?:\/\//);
      expect(passage.text).not.toMatch(/<[^>]+>/);
      expect(passage.publishedAt.endsWith("-03:00")).toBe(true);
      expect(passage.source).toBe("Gazeta Esportiva");
    }
  });

  it("does not break on a feed with a single <item> — fast-xml-parser would otherwise return an object, not an array", () => {
    const xml = buildRssDocument(`
      <item>
        <title>Título único</title>
        <link>https://exemplo.invalido/unico</link>
        <pubDate>Sat, 05 Sep 2026 23:47:00 +0000</pubDate>
        <description>Texto de teste com conteúdo suficiente.</description>
      </item>
    `);

    const passages = parseFeed(xml, FEED);

    expect(passages).toHaveLength(1);
    expect(passages[0]?.title).toBe("Título único");
  });

  it("prefers content:encoded over description", () => {
    const xml = buildRssDocument(`
      <item>
        <title>Título</title>
        <link>https://exemplo.invalido/precedencia</link>
        <pubDate>Sat, 05 Sep 2026 23:47:00 +0000</pubDate>
        <description>Texto curto da description.</description>
        <content:encoded><![CDATA[<p>Texto completo do content:encoded.</p>]]></content:encoded>
      </item>
    `);

    const passages = parseFeed(xml, FEED);

    expect(passages[0]?.text).toContain("Texto completo do content:encoded");
    expect(passages[0]?.text).not.toContain("Texto curto da description");
  });

  it("discards an item whose text is empty after stripHtml", () => {
    const xml = buildRssDocument(`
      <item>
        <title>Sem texto</title>
        <link>https://exemplo.invalido/vazio</link>
        <pubDate>Sat, 05 Sep 2026 23:47:00 +0000</pubDate>
        <description><![CDATA[<img src="x.png"/>]]></description>
      </item>
    `);

    expect(parseFeed(xml, FEED)).toHaveLength(0);
  });

  it("id matches /^[a-zA-Z0-9]+$/ and is stable for the same URL across runs — the citation invariant", () => {
    const xml = buildRssDocument(`
      <item>
        <title>Título</title>
        <link>https://exemplo.invalido/estavel</link>
        <pubDate>Sat, 05 Sep 2026 23:47:00 +0000</pubDate>
        <description>Texto de teste.</description>
      </item>
    `);

    const first = parseFeed(xml, FEED)[0];
    const second = parseFeed(xml, FEED)[0];

    expect(first?.id).toMatch(/^[a-zA-Z0-9]+$/);
    expect(first?.id).toBe(second?.id);
  });

  it("Object.keys(passage) is exactly the Passage key set — no numeric score field, the golden rule on the text side", () => {
    const xml = buildRssDocument(`
      <item>
        <title>Título</title>
        <link>https://exemplo.invalido/chaves</link>
        <pubDate>Sat, 05 Sep 2026 23:47:00 +0000</pubDate>
        <description>Texto de teste.</description>
      </item>
    `);

    const passage = parseFeed(xml, FEED)[0];
    expect(passage).toBeDefined();
    if (!passage) return;

    expect(Object.keys(passage).sort()).toEqual([...PASSAGE_KEYS].sort());
  });
});

describe("stripHtml", () => {
  it("removes script/style blocks, tags and entities, and collapses whitespace", () => {
    const html = '<div>Olá  <script>evil()</script><b>mundo</b>&nbsp;&amp;&nbsp;tudo</div>';
    expect(stripHtml(html)).toBe("Olá mundo & tudo");
  });
});
