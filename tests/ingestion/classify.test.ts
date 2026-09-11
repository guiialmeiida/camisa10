import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODELS } from "../../src/config/models.ts";
import type { Passage } from "../../src/sources/types.ts";

vi.mock("../../src/agent/llm.ts", () => ({ callStructured: vi.fn() }));

const { callStructured } = await import("../../src/agent/llm.ts");
const { classifyPassageType, classifyPassageTypes } = await import("../../src/ingestion/classify.ts");

const mockCallStructured = vi.mocked(callStructured);

function samplePassage(overrides: Partial<Passage> = {}): Passage {
  return {
    id: "p1",
    matchId: null,
    teams: ["palmeiras"],
    type: "article",
    title: "título",
    source: "Gazeta Esportiva",
    url: "https://exemplo.invalido/p1",
    publishedAt: "2026-09-06T08:00:00-03:00",
    text: "texto de teste",
    ...overrides,
  };
}

describe("classifyPassageType", () => {
  beforeEach(() => {
    mockCallStructured.mockReset();
  });

  it("returns the type the LLM produced, with fallback: false", async () => {
    mockCallStructured.mockResolvedValue({ type: "chronicle" });

    const result = await classifyPassageType(samplePassage({ id: "p07" }));

    expect(result).toEqual({ passageId: "p07", type: "chronicle", fallback: false });
  });

  it("falls back to article without rejecting when callStructured rejects, and warns with the passageId", async () => {
    mockCallStructured.mockRejectedValue(new Error("timeout"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await classifyPassageType(samplePassage({ id: "p09" }));

    expect(result).toEqual({ passageId: "p09", type: "article", fallback: true });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("p09"));
    warnSpy.mockRestore();
  });

  it("uses MODELS.passageClassification, not a loose literal", async () => {
    mockCallStructured.mockResolvedValue({ type: "article" });

    await classifyPassageType(samplePassage());

    expect(mockCallStructured).toHaveBeenCalledWith(
      expect.objectContaining({ config: MODELS.passageClassification, schemaName: "passageType" }),
    );
  });

  it("sends a user prompt containing the title, and never more than 1500 chars of text", async () => {
    mockCallStructured.mockResolvedValue({ type: "article" });
    const longText = "x".repeat(3000);

    await classifyPassageType(samplePassage({ title: "manchete única", text: longText }));

    const call = mockCallStructured.mock.calls[0]?.[0];
    expect(call?.user).toContain("manchete única");
    const textSection = call?.user.split("texto:\n")[1] ?? "";
    expect(textSection.length).toBeLessThanOrEqual(1500);
  });
});

describe("classifyPassageTypes", () => {
  beforeEach(() => {
    mockCallStructured.mockReset();
  });

  it("keeps the LLM's type for the other two when the middle one of three fails", async () => {
    mockCallStructured
      .mockResolvedValueOnce({ type: "preview" })
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce({ type: "matchReport" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const results = await classifyPassageTypes([
      samplePassage({ id: "p01" }),
      samplePassage({ id: "p02" }),
      samplePassage({ id: "p03" }),
    ]);

    expect(results).toEqual([
      { passageId: "p01", type: "preview", fallback: false },
      { passageId: "p02", type: "article", fallback: true },
      { passageId: "p03", type: "matchReport", fallback: false },
    ]);
    warnSpy.mockRestore();
  });

  it("returns results in input order, with passageId matching position by position", async () => {
    mockCallStructured
      .mockResolvedValueOnce({ type: "article" })
      .mockResolvedValueOnce({ type: "chronicle" });

    const results = await classifyPassageTypes([samplePassage({ id: "a" }), samplePassage({ id: "b" })]);

    expect(results.map((r) => r.passageId)).toEqual(["a", "b"]);
  });
});
