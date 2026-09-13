import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PassagePayload, SearchResult } from "../../src/vectorstore/types.ts";

vi.mock("../../src/agent/llm.ts", () => ({ callStructured: vi.fn() }));

const { callStructured } = await import("../../src/agent/llm.ts");
const {
  GRADER_APPROVAL_THRESHOLD,
  MAX_QUERY_REWRITES,
  gradePassages,
  shouldRewriteQuery,
  summarizeRejections,
} = await import("../../src/agent/nodes/grade.ts");
const mockCallStructured = vi.mocked(callStructured);

function samplePayload(passageId: string): PassagePayload {
  return {
    passageId,
    contentHash: "0".repeat(40),
    chunkIndex: 0,
    chunkCount: 1,
    text: `texto de ${passageId}`,
    title: `título de ${passageId}`,
    source: "Fixture Esportivo",
    url: `https://exemplo.invalido/fixture/${passageId}`,
    type: "article",
    teams: ["palmeiras"],
    matchId: "m1",
    competition: "brasileirao-serie-a",
    matchweek: 12,
    publishedAt: "2026-09-06T08:00:00-03:00",
  };
}

function sampleResult(passageId: string, id = 1): SearchResult {
  return { id, score: 0.5, payload: samplePayload(passageId) };
}

describe("gradePassages", () => {
  beforeEach(() => {
    mockCallStructured.mockReset();
  });

  it("N results -> N calls, and GradeOutcome has grades.length === N in the same order", async () => {
    mockCallStructured.mockResolvedValue({ relevant: true, reason: "ok" });
    const results = [sampleResult("p1", 1), sampleResult("p2", 2), sampleResult("p3", 3)];

    const outcome = await gradePassages({ question: "pergunta", results });

    expect(mockCallStructured).toHaveBeenCalledTimes(3);
    expect(outcome.grades).toHaveLength(3);
    expect(outcome.grades.map((grade) => grade.passageId)).toEqual(["p1", "p2", "p3"]);
  });

  it("approved carries only relevant: true, preserving relative order", async () => {
    mockCallStructured
      .mockResolvedValueOnce({ relevant: true, reason: "fala do assunto" })
      .mockResolvedValueOnce({ relevant: false, reason: "irrelevante" })
      .mockResolvedValueOnce({ relevant: true, reason: "também relevante" });
    const results = [sampleResult("p1", 1), sampleResult("p2", 2), sampleResult("p3", 3)];

    const outcome = await gradePassages({ question: "pergunta", results });

    expect(outcome.approved.map((result) => result.payload.passageId)).toEqual(["p1", "p3"]);
  });

  it("a rejecting call keeps the passage in approved with error set; judged excludes it, approvedRatio is over judged only", async () => {
    mockCallStructured
      .mockResolvedValueOnce({ relevant: false, reason: "não ajuda" })
      .mockRejectedValueOnce(new Error("grader timeout"));
    const results = [sampleResult("p1", 1), sampleResult("p2", 2)];

    const outcome = await gradePassages({ question: "pergunta", results });

    expect(outcome.grades[0]?.error).toBeUndefined();
    expect(outcome.grades[1]?.error).toContain("grader timeout");
    expect(outcome.grades[1]?.relevant).toBe(true); // kept by default on failure
    expect(outcome.approved.map((result) => result.payload.passageId)).toEqual(["p2"]);
    expect(outcome.judged).toBe(1);
    expect(outcome.approvedRatio).toBe(0);
  });

  it("all calls rejecting: judged === 0, approvedRatio === null, shouldRewriteQuery === false", async () => {
    mockCallStructured.mockRejectedValue(new Error("API futebol 503"));
    const results = [sampleResult("p1", 1), sampleResult("p2", 2)];

    const outcome = await gradePassages({ question: "pergunta", results });

    expect(outcome.judged).toBe(0);
    expect(outcome.approvedRatio).toBeNull();
    expect(shouldRewriteQuery(outcome)).toBe(false);
  });

  it("the system prompt tells the grader to judge relevance, not correctness", async () => {
    mockCallStructured.mockResolvedValue({ relevant: true, reason: "ok" });

    await gradePassages({ question: "pergunta", results: [sampleResult("p1")] });

    const call = mockCallStructured.mock.calls[0]?.[0];
    expect(call?.system.toLowerCase()).toContain("julgue relevância, não correção");
  });
});

describe("shouldRewriteQuery", () => {
  it("grades: [] (nothing retrieved) -> true", () => {
    expect(shouldRewriteQuery({ grades: [], approved: [], judged: 0, approvedRatio: null })).toBe(true);
  });

  it("boundary: 2/5 = 0.4 -> false (exactly at the threshold)", () => {
    expect(
      shouldRewriteQuery({
        grades: [{ passageId: "p", chunkIndex: 0, relevant: true, reason: "x" }],
        approved: [],
        judged: 5,
        approvedRatio: 2 / 5,
      }),
    ).toBe(false);
  });

  it("boundary: 1/5 = 0.2 -> true", () => {
    expect(
      shouldRewriteQuery({
        grades: [{ passageId: "p", chunkIndex: 0, relevant: true, reason: "x" }],
        approved: [],
        judged: 5,
        approvedRatio: 1 / 5,
      }),
    ).toBe(true);
  });

  it("boundary: 1/2 = 0.5 -> false (the case that motivates ratio over raw count)", () => {
    expect(
      shouldRewriteQuery({
        grades: [{ passageId: "p", chunkIndex: 0, relevant: true, reason: "x" }],
        approved: [],
        judged: 2,
        approvedRatio: 1 / 2,
      }),
    ).toBe(false);
  });
});

describe("summarizeRejections", () => {
  it("keeps only the rejected passages, with their reason", () => {
    const outcome = {
      grades: [
        { passageId: "p1", chunkIndex: 0, relevant: true, reason: "ok" },
        { passageId: "p2", chunkIndex: 0, relevant: false, reason: "fora do assunto" },
      ],
      approved: [],
      judged: 2,
      approvedRatio: 0.5,
    };

    expect(summarizeRejections(outcome)).toEqual([{ passageId: "p2", reason: "fora do assunto" }]);
  });
});

describe("locked constants", () => {
  it("GRADER_APPROVAL_THRESHOLD === 0.4", () => {
    expect(GRADER_APPROVAL_THRESHOLD).toBe(0.4);
  });

  it("MAX_QUERY_REWRITES === 2", () => {
    expect(MAX_QUERY_REWRITES).toBe(2);
  });
});
