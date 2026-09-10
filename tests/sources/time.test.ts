import { describe, expect, it } from "vitest";
import { toSaoPauloIso } from "../../src/sources/time.ts";

describe("toSaoPauloIso", () => {
  it("converts a 'Z' ISO date to the -03:00 offset, shifting the calendar day", () => {
    expect(toSaoPauloIso("2026-09-06T00:30:00Z")).toBe("2026-09-05T21:30:00-03:00");
  });

  it("converts a '+00:00' ISO date to the same instant as the 'Z' form", () => {
    expect(toSaoPauloIso("2026-09-06T00:30:00+00:00")).toBe(toSaoPauloIso("2026-09-06T00:30:00Z"));
  });

  it("converts an RFC-822 pubDate to the same instant", () => {
    expect(toSaoPauloIso("Sun, 06 Sep 2026 00:30:00 +0000")).toBe("2026-09-05T21:30:00-03:00");
  });

  it("throws on an unparseable date", () => {
    expect(() => toSaoPauloIso("not a date")).toThrow();
  });
});
