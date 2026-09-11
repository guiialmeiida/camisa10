import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/ingestion/content-hash.ts";

describe("contentHash", () => {
  it("returns the same hash for the same { title, chunks }, 40 lowercase hex chars", () => {
    const a = contentHash({ title: "título", chunks: ["texto"] });
    const b = contentHash({ title: "título", chunks: ["texto"] });

    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns a different hash for different chunk text", () => {
    const a = contentHash({ title: "título", chunks: ["texto A"] });
    const b = contentHash({ title: "título", chunks: ["texto B"] });

    expect(a).not.toBe(b);
  });

  it("returns a different hash for a different title with the same chunks", () => {
    const a = contentHash({ title: "título A", chunks: ["texto"] });
    const b = contentHash({ title: "título B", chunks: ["texto"] });

    expect(a).not.toBe(b);
  });

  it("does not collide across the title/chunks boundary — the separator is doing work", () => {
    const a = contentHash({ title: "a", chunks: ["bc"] });
    const b = contentHash({ title: "a\nb", chunks: ["c"] });

    expect(a).not.toBe(b);
  });

  it("gives a different hash for the same total text split differently — the point of covering chunks, not raw text", () => {
    const a = contentHash({ title: "a", chunks: ["bc"] });
    const b = contentHash({ title: "a", chunks: ["b", "c"] });

    expect(a).not.toBe(b);
  });

  it("throws on an empty chunk list", () => {
    expect(() => contentHash({ title: "título", chunks: [] })).toThrow(/empty chunk list/);
  });
});
