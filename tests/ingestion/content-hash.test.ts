import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/ingestion/content-hash.ts";

describe("contentHash", () => {
  it("returns the same hash for the same { title, text }, 40 lowercase hex chars", () => {
    const a = contentHash({ title: "título", text: "texto" });
    const b = contentHash({ title: "título", text: "texto" });

    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns a different hash for different text", () => {
    const a = contentHash({ title: "título", text: "texto A" });
    const b = contentHash({ title: "título", text: "texto B" });

    expect(a).not.toBe(b);
  });

  it("returns a different hash for a different title with the same text", () => {
    const a = contentHash({ title: "título A", text: "texto" });
    const b = contentHash({ title: "título B", text: "texto" });

    expect(a).not.toBe(b);
  });

  it("does not collide across the title/text boundary — the separator is doing work", () => {
    const a = contentHash({ title: "a", text: "bc" });
    const b = contentHash({ title: "a\nb", text: "c" });

    expect(a).not.toBe(b);
  });
});
