import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHUNK_OVERLAP, CHUNK_SIZE, chunkText } from "../../src/ingestion/chunk.ts";

const FIXTURE_PATH = path.join(import.meta.dirname, "..", "fixtures", "brasileirao-2026-matchweek-12.json");

/** Numbered, fixed-width words ("w000", "w001", ...) so overlap/boundary math is exact. */
function wordsText(count: number): string {
  return Array.from({ length: count }, (_, index) => `w${String(index).padStart(3, "0")}`).join(" ");
}

/** Slices `text` down to (at most) `target` chars, landing on a clean word boundary. */
function sliceAtWordBoundary(text: string, target: number): string {
  const sliced = text.slice(0, target);
  const lastSpace = sliced.lastIndexOf(" ");
  return lastSpace === -1 ? sliced : sliced.slice(0, lastSpace);
}

describe("chunkText", () => {
  it("returns exactly one chunk, equal to the trimmed text, when the text fits in size", () => {
    expect(chunkText("  hello world  ", { size: 900, overlap: 150 })).toEqual(["hello world"]);
  });

  it("returns one chunk for a text of exactly `size` length", () => {
    const text = "a".repeat(900);
    expect(chunkText(text)).toEqual([text]);
  });

  it("splits a ~2.5x size text into 3 chunks, all with length <= size", () => {
    const text = wordsText(50); // 249 chars, ~2.5x size=100
    const chunks = chunkText(text, { size: 100, overlap: 20 });

    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it("covers every word of the input exactly once, in order, with no gap or reorder", () => {
    const words = Array.from({ length: 120 }, (_, index) => `w${String(index).padStart(3, "0")}`);
    const text = words.join(" ");

    const chunks = chunkText(text, { size: 60, overlap: 12 });
    const seenWords = chunks.flatMap((chunk) => chunk.split(/\s+/));
    const uniqueInOrder = [...new Set(seenWords)];

    expect(uniqueInOrder).toEqual(words);
  });

  it("never starts or ends a chunk mid-word", () => {
    const words = Array.from({ length: 120 }, (_, index) => `w${String(index).padStart(3, "0")}`);
    const wordSet = new Set(words);
    const text = words.join(" ");

    const chunks = chunkText(text, { size: 60, overlap: 12 });

    for (const chunk of chunks) {
      const chunkWords = chunk.split(/\s+/);
      expect(wordSet.has(chunkWords[0] as string)).toBe(true);
      expect(wordSet.has(chunkWords[chunkWords.length - 1] as string)).toBe(true);
    }
  });

  it("consecutive chunks share at least one word, and the shared part never exceeds overlap + one word", () => {
    const size = 50;
    const overlap = 10;
    const text = wordsText(120);
    const chunks = chunkText(text, { size, overlap });

    expect(chunks.length).toBeGreaterThan(1);

    for (let index = 0; index < chunks.length - 1; index += 1) {
      const first = chunks[index] as string;
      const second = chunks[index + 1] as string;
      const firstWords = first.split(/\s+/);
      const secondWords = second.split(/\s+/);
      const shared = firstWords.filter((word) => secondWords.includes(word));

      expect(shared.length).toBeGreaterThanOrEqual(1);

      const longestSharedWord = Math.max(...shared.map((word) => word.length));
      const sharedLength = shared.reduce((sum, word) => sum + word.length, 0) + (shared.length - 1);
      expect(sharedLength).toBeLessThanOrEqual(overlap + longestSharedWord);
    }
  });

  it("has no stub last chunk: for a size*2+30 text, the last chunk has at least `overlap` characters", () => {
    const size = 50;
    const overlap = 10;
    const text = sliceAtWordBoundary(wordsText(200), size * 2 + 30);

    const chunks = chunkText(text, { size, overlap });
    const lastChunk = chunks[chunks.length - 1] as string;

    expect(lastChunk.length).toBeGreaterThanOrEqual(overlap);
  });

  it("terminates on a word bigger than the window, cutting at the hard end without losing coverage", () => {
    const text = "x".repeat(2000); // no whitespace anywhere

    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_SIZE);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("does not split a numeric token, even when the hard cut would otherwise land inside it", () => {
    const size = 54;
    const overlap = 10;
    // The window for the first chunk ends exactly a few characters into "3.500" if cut
    // were purely by size — the whitespace-boundary rule must push the cut back before it.
    const text = `${"z".repeat(50)} 3.500 ${"y".repeat(300)}`;

    const chunks = chunkText(text, { size, overlap });

    expect(chunks.some((chunk) => chunk === "3.500")).toBe(true);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/3\.5$/);
      expect(chunk).not.toMatch(/^\.?\d+$/); // no lone digit fragment of the token anywhere
    }
  });

  it("is deterministic: the same input produces the same array across two calls", () => {
    const text = wordsText(80);
    expect(chunkText(text, { size: 60, overlap: 12 })).toEqual(chunkText(text, { size: 60, overlap: 12 }));
  });

  it("throws on empty or whitespace-only text", () => {
    expect(() => chunkText("")).toThrow(/empty text/);
    expect(() => chunkText("   \n\t  ")).toThrow(/empty text/);
  });

  it("throws when overlap >= size", () => {
    expect(() => chunkText("some text", { size: 10, overlap: 10 })).toThrow(/overlap \(10\) must be smaller than size \(10\)/);
    expect(() => chunkText("some text", { size: 10, overlap: 20 })).toThrow(/smaller than size/);
  });

  it("throws when size < 1", () => {
    expect(() => chunkText("some text", { size: 0, overlap: 0 })).toThrow(/size \(0\)/);
    expect(() => chunkText("some text", { size: -5, overlap: 0 })).toThrow(/size/);
  });

  it("throws when overlap < 0", () => {
    expect(() => chunkText("some text", { size: 10, overlap: -1 })).toThrow(/overlap \(-1\)/);
  });

  it("produces exactly one chunk per passage of the fixture, with default parameters — the invariant recall@5 (0.929) depends on", async () => {
    const raw = await readFile(FIXTURE_PATH, "utf-8");
    const fixture = JSON.parse(raw) as { passages: { id: string; text: string }[] };

    expect(fixture.passages.length).toBeGreaterThan(0);
    for (const passage of fixture.passages) {
      expect(chunkText(passage.text)).toHaveLength(1);
    }
  });

  it("exports CHUNK_SIZE and CHUNK_OVERLAP as the spec's default values", () => {
    expect(CHUNK_SIZE).toBe(900);
    expect(CHUNK_OVERLAP).toBe(150);
  });
});
