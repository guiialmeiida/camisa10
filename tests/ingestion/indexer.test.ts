import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentHash } from "../../src/ingestion/content-hash.ts";
import { passagePayloadSchema } from "../../src/vectorstore/types.ts";
import type { Facts, Passage } from "../../src/sources/types.ts";

vi.mock("../../src/sources/index.ts", () => ({ getFacts: vi.fn(), listPassages: vi.fn() }));
vi.mock("../../src/ingestion/embed.ts", () => ({ embedAll: vi.fn() }));
vi.mock("../../src/ingestion/classify.ts", () => ({ classifyPassageTypes: vi.fn() }));
vi.mock("../../src/vectorstore/qdrant.ts", () => ({
  ensureCollection: vi.fn(),
  fetchDigests: vi.fn(),
  insertPoints: vi.fn(),
}));
vi.mock("../../src/vectorstore/point-id.ts", () => ({ pointIdFromPassageId: vi.fn() }));
vi.mock("../../src/config/env.ts", () => ({ loadEnv: () => ({ QDRANT_COLLECTION: "camisa10-test" }) }));

const { getFacts, listPassages } = await import("../../src/sources/index.ts");
const { embedAll } = await import("../../src/ingestion/embed.ts");
const { classifyPassageTypes } = await import("../../src/ingestion/classify.ts");
const { ensureCollection, fetchDigests, insertPoints } = await import("../../src/vectorstore/qdrant.ts");
const { pointIdFromPassageId } = await import("../../src/vectorstore/point-id.ts");
const { indexPassages } = await import("../../src/ingestion/indexer.ts");
const actualPointId = await vi.importActual<typeof import("../../src/vectorstore/point-id.ts")>(
  "../../src/vectorstore/point-id.ts",
);

const mockGetFacts = vi.mocked(getFacts);
const mockListPassages = vi.mocked(listPassages);
const mockEmbedAll = vi.mocked(embedAll);
const mockClassifyPassageTypes = vi.mocked(classifyPassageTypes);
const mockEnsureCollection = vi.mocked(ensureCollection);
const mockFetchDigests = vi.mocked(fetchDigests);
const mockInsertPoints = vi.mocked(insertPoints);
const mockPointIdFromPassageId = vi.mocked(pointIdFromPassageId);

const sampleFacts: Facts = {
  competition: { id: "brasileirao-serie-a", name: "Brasileirão Série A", season: 2026 },
  matchweek: 12,
  matches: [],
  teams: [],
  source: "api",
};

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

function vector(fill = 0.1): number[] {
  return Array.from({ length: 8 }, () => fill);
}

// Default double for classifyPassageTypes: identity, no fallback — matches whatever
// passages it's called with, in order.
function identityClassify(passages: Passage[]) {
  return passages.map((passage) => ({ passageId: passage.id, type: passage.type, fallback: false }));
}

describe("indexPassages", () => {
  beforeEach(() => {
    mockGetFacts.mockReset();
    mockListPassages.mockReset();
    mockEmbedAll.mockReset();
    mockClassifyPassageTypes.mockReset();
    mockEnsureCollection.mockReset();
    mockFetchDigests.mockReset();
    mockInsertPoints.mockReset();
    mockPointIdFromPassageId.mockReset();

    mockGetFacts.mockResolvedValue(sampleFacts);
    mockEnsureCollection.mockResolvedValue(undefined);
    mockInsertPoints.mockImplementation(async (points) => points.length);
    mockClassifyPassageTypes.mockImplementation(async (passages) => identityClassify(passages));
    mockPointIdFromPassageId.mockImplementation(actualPointId.pointIdFromPassageId);
  });

  it("throws before calling ensureCollection or fetchDigests when the source returns 0 passages — the index isn't touched", async () => {
    mockListPassages.mockResolvedValue([]);

    await expect(indexPassages()).rejects.toThrow(/0 passages/);
    expect(mockEnsureCollection).not.toHaveBeenCalled();
    expect(mockFetchDigests).not.toHaveBeenCalled();
  });

  it("takes matchweek from facts.matchweek, and matchId: null passes through the payload", async () => {
    mockListPassages.mockResolvedValue([samplePassage()]);
    mockFetchDigests.mockResolvedValue([]);
    mockEmbedAll.mockResolvedValue([vector()]);

    const report = await indexPassages();

    expect(report.passages).toBe(1);
    expect(report.points).toBe(1);
    expect(mockInsertPoints).toHaveBeenCalledTimes(1);

    const [points] = mockInsertPoints.mock.calls[0] ?? [];
    expect(points?.[0]?.payload.matchweek).toBe(12);
    expect(points?.[0]?.payload.matchId).toBeNull();
  });

  it("incremental, all contentHash matching: does not call embedAll, classifyPassageTypes or insertPoints — report is { unchanged: N, points: 0 }", async () => {
    const passages = [samplePassage({ id: "p1", text: "a" }), samplePassage({ id: "p2", text: "b" })];
    mockListPassages.mockResolvedValue(passages);
    mockFetchDigests.mockResolvedValue(
      passages.map((passage) => ({
        pointId: actualPointId.pointIdFromPassageId(passage.id),
        passageId: passage.id,
        contentHash: contentHash(passage),
      })),
    );

    const report = await indexPassages();

    expect(mockEmbedAll).not.toHaveBeenCalled();
    expect(mockClassifyPassageTypes).not.toHaveBeenCalled();
    expect(mockInsertPoints).not.toHaveBeenCalled();
    expect(report.unchanged).toBe(2);
    expect(report.points).toBe(0);
  });

  it("incremental, one passage with changed text: only it is embedded and upserted, with the same point.id as the existing digest", async () => {
    const unchangedPassage = samplePassage({ id: "p1", text: "unchanged" });
    const changedPassage = samplePassage({ id: "p2", text: "new text" });
    mockListPassages.mockResolvedValue([unchangedPassage, changedPassage]);

    mockFetchDigests.mockResolvedValue([
      {
        pointId: actualPointId.pointIdFromPassageId(unchangedPassage.id),
        passageId: unchangedPassage.id,
        contentHash: contentHash(unchangedPassage),
      },
      {
        pointId: actualPointId.pointIdFromPassageId(changedPassage.id),
        passageId: changedPassage.id,
        contentHash: "old-hash-that-no-longer-matches".padEnd(40, "0"),
      },
    ]);
    mockEmbedAll.mockResolvedValue([vector()]);

    const report = await indexPassages();

    expect(report.changed).toBe(1);
    expect(report.unchanged).toBe(1);
    expect(report.points).toBe(1);
    expect(mockEmbedAll).toHaveBeenCalledWith([changedPassage.text], "document");

    const [points] = mockInsertPoints.mock.calls[0] ?? [];
    expect(points).toHaveLength(1);
    expect(points?.[0]?.id).toBe(actualPointId.pointIdFromPassageId(changedPassage.id));
    expect(points?.[0]?.payload.passageId).toBe(changedPassage.id);
  });

  it("incremental, one passage absent from the digest: counted in newPassages and indexed", async () => {
    mockListPassages.mockResolvedValue([samplePassage({ id: "p1" })]);
    mockFetchDigests.mockResolvedValue([]);
    mockEmbedAll.mockResolvedValue([vector()]);

    const report = await indexPassages();

    expect(report.newPassages).toBe(1);
    expect(report.points).toBe(1);
  });

  it("incremental with a non-existent collection (fetchDigests -> []): everything is new", async () => {
    const passages = [samplePassage({ id: "p1" }), samplePassage({ id: "p2" })];
    mockListPassages.mockResolvedValue(passages);
    mockFetchDigests.mockResolvedValue([]);
    mockEmbedAll.mockResolvedValue([vector(), vector()]);

    const report = await indexPassages();

    expect(report.newPassages).toBe(2);
    expect(report.points).toBe(2);
  });

  it("recreate: true does not call fetchDigests, calls ensureCollection with { recreate: true }, and every passage is indexed", async () => {
    const passages = [samplePassage({ id: "p1" }), samplePassage({ id: "p2" })];
    mockListPassages.mockResolvedValue(passages);
    mockEmbedAll.mockResolvedValue([vector(), vector()]);

    const report = await indexPassages({ recreate: true });

    expect(mockFetchDigests).not.toHaveBeenCalled();
    expect(mockEnsureCollection).toHaveBeenCalledWith({ recreate: true });
    expect(report.mode).toBe("recreate");
    expect(report.newPassages).toBe(2);
    expect(report.points).toBe(2);
  });

  it("recreate: true with embedAll rejecting: ensureCollection({ recreate: true }) is never reached — the collection survives the embedding failure", async () => {
    mockListPassages.mockResolvedValue([samplePassage()]);
    mockEmbedAll.mockRejectedValue(new Error("Voyage down"));

    await expect(indexPassages({ recreate: true })).rejects.toThrow(/Voyage down/);

    expect(mockEnsureCollection).not.toHaveBeenCalledWith({ recreate: true });
  });

  it("throws, citing both passageIds, when two passages' pointIdFromPassageId collide", async () => {
    mockPointIdFromPassageId.mockReturnValue(42);
    mockListPassages.mockResolvedValue([samplePassage({ id: "pA" }), samplePassage({ id: "pB" })]);

    await expect(indexPassages()).rejects.toThrow(/pA/);
    await expect(indexPassages()).rejects.toThrow(/pB/);
  });

  it("throws when the digest's passageId differs from the passage that maps to that id", async () => {
    const passage = samplePassage({ id: "p1" });
    mockListPassages.mockResolvedValue([passage]);
    mockFetchDigests.mockResolvedValue([
      {
        pointId: actualPointId.pointIdFromPassageId(passage.id),
        passageId: "some-other-passage",
        contentHash: "x".repeat(40),
      },
    ]);

    await expect(indexPassages()).rejects.toThrow(/collision/);
  });

  it("insertPoints failing on the second batch of 64: the exception propagates, and the test records how many points got in", async () => {
    const passages = Array.from({ length: 70 }, (_, index) => samplePassage({ id: `p${index}`, text: `t${index}` }));
    mockListPassages.mockResolvedValue(passages);
    mockFetchDigests.mockResolvedValue([]);
    mockEmbedAll.mockResolvedValue(passages.map(() => vector()));
    mockInsertPoints
      .mockImplementationOnce(async (points) => points.length)
      .mockImplementationOnce(async () => {
        throw new Error("Qdrant unavailable");
      });

    await expect(indexPassages()).rejects.toThrow(/64/);
  });

  it("classifyPassageTypes returning one fallback: true results in classificationFallbacks: 1 in the report", async () => {
    const passages = [samplePassage({ id: "p1" }), samplePassage({ id: "p2" })];
    mockListPassages.mockResolvedValue(passages);
    mockFetchDigests.mockResolvedValue([]);
    mockEmbedAll.mockResolvedValue([vector(), vector()]);
    mockClassifyPassageTypes.mockResolvedValue([
      { passageId: "p1", type: "article", fallback: false },
      { passageId: "p2", type: "article", fallback: true },
    ]);

    const report = await indexPassages();

    expect(report.classificationFallbacks).toBe(1);
  });

  it("golden rule invariant: every constructed payload parses with passagePayloadSchema and has exactly the schema's keys", async () => {
    mockListPassages.mockResolvedValue([samplePassage({ id: "p1" })]);
    mockFetchDigests.mockResolvedValue([]);
    mockEmbedAll.mockResolvedValue([vector()]);

    await indexPassages();

    const [points] = mockInsertPoints.mock.calls[0] ?? [];
    const payload = points?.[0]?.payload;
    expect(payload).toBeDefined();
    const parsed = passagePayloadSchema.parse(payload);
    expect(Object.keys(payload as object).sort()).toEqual(Object.keys(passagePayloadSchema.shape).sort());
    expect(parsed).toBeDefined();
  });

  it("typeCounts sums exactly to points", async () => {
    const passages = [
      samplePassage({ id: "p1", type: "article" }),
      samplePassage({ id: "p2", type: "chronicle" }),
      samplePassage({ id: "p3", type: "preview" }),
    ];
    mockListPassages.mockResolvedValue(passages);
    mockFetchDigests.mockResolvedValue([]);
    mockEmbedAll.mockResolvedValue([vector(), vector(), vector()]);

    const report = await indexPassages();

    const sum = Object.values(report.typeCounts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(report.points);
  });
});
