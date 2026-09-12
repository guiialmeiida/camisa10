import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentHash } from "../../src/ingestion/content-hash.ts";
import { passagePayloadSchema } from "../../src/vectorstore/types.ts";
import type { Facts, Passage } from "../../src/sources/types.ts";

vi.mock("../../src/sources/index.ts", () => ({ getFacts: vi.fn(), listPassages: vi.fn() }));
vi.mock("../../src/ingestion/embed.ts", () => ({ embedAll: vi.fn() }));
vi.mock("../../src/ingestion/classify.ts", () => ({ classifyPassageTypes: vi.fn() }));
vi.mock("../../src/ingestion/chunk.ts", () => ({ chunkText: vi.fn() }));
vi.mock("../../src/vectorstore/qdrant.ts", () => ({
  ensureCollection: vi.fn(),
  fetchDigests: vi.fn(),
  insertPoints: vi.fn(),
  deleteOrphanChunks: vi.fn(),
}));
vi.mock("../../src/vectorstore/point-id.ts", () => ({ pointIdFromChunk: vi.fn() }));
vi.mock("../../src/config/env.ts", () => ({ loadEnv: () => ({ QDRANT_COLLECTION: "camisa10-test" }) }));

const { getFacts, listPassages } = await import("../../src/sources/index.ts");
const { embedAll } = await import("../../src/ingestion/embed.ts");
const { classifyPassageTypes } = await import("../../src/ingestion/classify.ts");
const { chunkText } = await import("../../src/ingestion/chunk.ts");
const { deleteOrphanChunks, ensureCollection, fetchDigests, insertPoints } = await import("../../src/vectorstore/qdrant.ts");
const { pointIdFromChunk } = await import("../../src/vectorstore/point-id.ts");
const { indexPassages } = await import("../../src/ingestion/indexer.ts");
const actualPointId = await vi.importActual<typeof import("../../src/vectorstore/point-id.ts")>(
  "../../src/vectorstore/point-id.ts",
);

const mockGetFacts = vi.mocked(getFacts);
const mockListPassages = vi.mocked(listPassages);
const mockEmbedAll = vi.mocked(embedAll);
const mockClassifyPassageTypes = vi.mocked(classifyPassageTypes);
const mockChunkText = vi.mocked(chunkText);
const mockEnsureCollection = vi.mocked(ensureCollection);
const mockFetchDigests = vi.mocked(fetchDigests);
const mockInsertPoints = vi.mocked(insertPoints);
const mockDeleteOrphanChunks = vi.mocked(deleteOrphanChunks);
const mockPointIdFromChunk = vi.mocked(pointIdFromChunk);

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
    mockChunkText.mockReset();
    mockEnsureCollection.mockReset();
    mockFetchDigests.mockReset();
    mockInsertPoints.mockReset();
    mockDeleteOrphanChunks.mockReset();
    mockPointIdFromChunk.mockReset();

    mockGetFacts.mockResolvedValue(sampleFacts);
    mockEnsureCollection.mockResolvedValue(undefined);
    mockInsertPoints.mockImplementation(async (points) => points.length);
    mockDeleteOrphanChunks.mockResolvedValue(0);
    mockClassifyPassageTypes.mockImplementation(async (passages) => identityClassify(passages));
    // Default: one chunk per passage, identical to its text — matches the fixture's
    // shape (every passage fits in CHUNK_SIZE) and keeps most tests unaware of chunking.
    mockChunkText.mockImplementation((text: string) => [text]);
    mockPointIdFromChunk.mockImplementation(actualPointId.pointIdFromChunk);
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

  it("a passage that produces 3 chunks becomes 3 points, with the right ids, chunkIndex/chunkCount, shared fields and ordered text", async () => {
    const passage = samplePassage({ id: "p1", title: "manchete", text: "texto original" });
    mockListPassages.mockResolvedValue([passage]);
    mockFetchDigests.mockResolvedValue([]);
    mockChunkText.mockImplementation((text: string) => (text === passage.text ? ["chunk A", "chunk B", "chunk C"] : [text]));
    mockEmbedAll.mockResolvedValue([vector(0.1), vector(0.2), vector(0.3)]);

    const report = await indexPassages();

    expect(report.points).toBe(3);
    const [points] = mockInsertPoints.mock.calls[0] ?? [];
    expect(points).toHaveLength(3);

    ["chunk A", "chunk B", "chunk C"].forEach((chunk, chunkIndex) => {
      const point = points?.[chunkIndex];
      expect(point?.id).toBe(actualPointId.pointIdFromChunk(passage.id, chunkIndex));
      expect(point?.payload.chunkIndex).toBe(chunkIndex);
      expect(point?.payload.chunkCount).toBe(3);
      expect(point?.payload.text).toBe(chunk);
      expect(point?.payload.passageId).toBe(passage.id);
      expect(point?.payload.title).toBe(passage.title);
      expect(point?.payload.teams).toEqual(passage.teams);
      expect(point?.payload.type).toBe(passage.type);
      expect(point?.payload.competition).toBe(sampleFacts.competition.id);
      expect(point?.payload.matchweek).toBe(sampleFacts.matchweek);
    });

    const contentHashes = new Set(points?.map((point) => point.payload.contentHash));
    expect(contentHashes.size).toBe(1);
  });

  it("report: chunks counts everything the source produces, points counts what was upserted, typeCounts sums newPassages + changed (not points)", async () => {
    const grower = samplePassage({ id: "p1", text: "cresce" });
    const single = samplePassage({ id: "p2", text: "single", type: "chronicle" });
    mockListPassages.mockResolvedValue([grower, single]);
    mockFetchDigests.mockResolvedValue([]);
    mockChunkText.mockImplementation((text: string) => (text === grower.text ? ["a", "b", "c"] : [text]));
    mockEmbedAll.mockResolvedValue([vector(0.1), vector(0.2), vector(0.3), vector(0.4)]);

    const report = await indexPassages();

    expect(report.chunks).toBe(4); // 3 (grower) + 1 (single)
    expect(report.points).toBe(4);
    expect(report.newPassages + report.changed).toBe(2);
    const typeCountSum = Object.values(report.typeCounts).reduce((a, b) => a + b, 0);
    expect(typeCountSum).toBe(report.newPassages + report.changed);
    expect(typeCountSum).not.toBe(report.points);
  });

  it("incremental, every chunk digest present with the matching hash: does not call embedAll, classifyPassageTypes, insertPoints or deleteOrphanChunks — report is { unchanged: N, points: 0, orphanPointsDeleted: 0 }", async () => {
    const passages = [samplePassage({ id: "p1", text: "a" }), samplePassage({ id: "p2", text: "b" })];
    mockListPassages.mockResolvedValue(passages);
    mockFetchDigests.mockResolvedValue(
      passages.map((passage) => ({
        pointId: actualPointId.pointIdFromChunk(passage.id, 0),
        passageId: passage.id,
        contentHash: contentHash({ title: passage.title, chunks: [passage.text] }),
      })),
    );

    const report = await indexPassages();

    expect(mockEmbedAll).not.toHaveBeenCalled();
    expect(mockClassifyPassageTypes).not.toHaveBeenCalled();
    expect(mockInsertPoints).not.toHaveBeenCalled();
    expect(mockDeleteOrphanChunks).not.toHaveBeenCalled();
    expect(report.unchanged).toBe(2);
    expect(report.points).toBe(0);
    expect(report.orphanPointsDeleted).toBe(0);
  });

  it("incremental, one passage with changed text: only it is embedded and upserted, with the same point.id as the existing digest", async () => {
    const unchangedPassage = samplePassage({ id: "p1", text: "unchanged" });
    const changedPassage = samplePassage({ id: "p2", text: "new text" });
    mockListPassages.mockResolvedValue([unchangedPassage, changedPassage]);

    mockFetchDigests.mockResolvedValue([
      {
        pointId: actualPointId.pointIdFromChunk(unchangedPassage.id, 0),
        passageId: unchangedPassage.id,
        contentHash: contentHash({ title: unchangedPassage.title, chunks: [unchangedPassage.text] }),
      },
      {
        pointId: actualPointId.pointIdFromChunk(changedPassage.id, 0),
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
    expect(points?.[0]?.id).toBe(actualPointId.pointIdFromChunk(changedPassage.id, 0));
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

  it("partial write: a 3-chunk passage with only 2 digests present (same hash): counted as changed, and all 3 chunks are re-embedded and rewritten", async () => {
    const passage = samplePassage({ id: "p1", text: "conteúdo" });
    mockListPassages.mockResolvedValue([passage]);
    mockChunkText.mockImplementation((text: string) => (text === passage.text ? ["c0", "c1", "c2"] : [text]));
    const hash = contentHash({ title: passage.title, chunks: ["c0", "c1", "c2"] });
    mockFetchDigests.mockResolvedValue([
      { pointId: actualPointId.pointIdFromChunk(passage.id, 0), passageId: passage.id, contentHash: hash },
      { pointId: actualPointId.pointIdFromChunk(passage.id, 1), passageId: passage.id, contentHash: hash },
      // chunk 2's digest is missing — a run that died mid-write.
    ]);
    mockEmbedAll.mockResolvedValue([vector(0.1), vector(0.2), vector(0.3)]);

    const report = await indexPassages();

    expect(report.changed).toBe(1);
    expect(report.newPassages).toBe(0);
    expect(report.points).toBe(3);
    expect(mockEmbedAll).toHaveBeenCalledWith(["c0", "c1", "c2"], "document");
  });

  it("a passage that shrank (4 chunks indexed, 2 now): deleteOrphanChunks is called with chunkCount: 2, before insertPoints, and 2 points are upserted", async () => {
    const passage = samplePassage({ id: "p1", text: "texto encurtado" });
    mockListPassages.mockResolvedValue([passage]);
    mockChunkText.mockImplementation((text: string) => (text === passage.text ? ["c0", "c1"] : [text]));
    // The 2 point ids this run computes (chunkIndex 0 and 1) come back with an old hash —
    // the passage is `changed`, which is what drives both the re-embed and the sweep.
    mockFetchDigests.mockResolvedValue([
      { pointId: actualPointId.pointIdFromChunk(passage.id, 0), passageId: passage.id, contentHash: "old".padEnd(40, "0") },
      { pointId: actualPointId.pointIdFromChunk(passage.id, 1), passageId: passage.id, contentHash: "old".padEnd(40, "0") },
    ]);
    mockEmbedAll.mockResolvedValue([vector(0.1), vector(0.2)]);
    mockDeleteOrphanChunks.mockResolvedValue(2);

    const callOrder: string[] = [];
    mockDeleteOrphanChunks.mockImplementation(async () => {
      callOrder.push("sweep");
      return 2;
    });
    mockInsertPoints.mockImplementation(async (points) => {
      callOrder.push("upsert");
      return points.length;
    });

    const report = await indexPassages();

    expect(mockDeleteOrphanChunks).toHaveBeenCalledWith([{ passageId: passage.id, chunkCount: 2 }]);
    expect(callOrder).toEqual(["sweep", "upsert"]);
    expect(report.points).toBe(2);
    expect(report.orphanPointsDeleted).toBe(2);
  });

  it("a passage that grew (2 -> 4 chunks): 4 points upserted, sweep called with chunkCount: 4 (deletes nothing)", async () => {
    const passage = samplePassage({ id: "p1", text: "texto expandido" });
    mockListPassages.mockResolvedValue([passage]);
    mockChunkText.mockImplementation((text: string) => (text === passage.text ? ["c0", "c1", "c2", "c3"] : [text]));
    // Only 2 of the 4 current point ids have any digest at all — a partial/previous write.
    mockFetchDigests.mockResolvedValue([
      { pointId: actualPointId.pointIdFromChunk(passage.id, 0), passageId: passage.id, contentHash: "old".padEnd(40, "0") },
      { pointId: actualPointId.pointIdFromChunk(passage.id, 1), passageId: passage.id, contentHash: "old".padEnd(40, "0") },
    ]);
    mockEmbedAll.mockResolvedValue([vector(0.1), vector(0.2), vector(0.3), vector(0.4)]);
    mockDeleteOrphanChunks.mockResolvedValue(0);

    const report = await indexPassages();

    expect(mockDeleteOrphanChunks).toHaveBeenCalledWith([{ passageId: passage.id, chunkCount: 4 }]);
    expect(report.points).toBe(4);
    expect(report.orphanPointsDeleted).toBe(0);
  });

  it("recreate: true does not call fetchDigests or deleteOrphanChunks, calls ensureCollection with { recreate: true }, and every passage is indexed", async () => {
    const passages = [samplePassage({ id: "p1" }), samplePassage({ id: "p2" })];
    mockListPassages.mockResolvedValue(passages);
    mockEmbedAll.mockResolvedValue([vector(), vector()]);

    const report = await indexPassages({ recreate: true });

    expect(mockFetchDigests).not.toHaveBeenCalled();
    expect(mockDeleteOrphanChunks).not.toHaveBeenCalled();
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

  it("throws, citing both passageId#chunkIndex labels, when two chunks' pointIdFromChunk collide", async () => {
    mockPointIdFromChunk.mockReturnValue(42);
    mockListPassages.mockResolvedValue([samplePassage({ id: "pA" }), samplePassage({ id: "pB" })]);

    await expect(indexPassages()).rejects.toThrow(/pA#0/);
    await expect(indexPassages()).rejects.toThrow(/pB#0/);
  });

  it("throws when the digest's passageId differs from the passage that maps to that id", async () => {
    const passage = samplePassage({ id: "p1" });
    mockListPassages.mockResolvedValue([passage]);
    mockFetchDigests.mockResolvedValue([
      {
        pointId: actualPointId.pointIdFromChunk(passage.id, 0),
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

  it("orphanPointsDeleted in the report is exactly what deleteOrphanChunks returned", async () => {
    const passage = samplePassage({ id: "p1", text: "mudou" });
    mockListPassages.mockResolvedValue([passage]);
    mockFetchDigests.mockResolvedValue([
      {
        pointId: actualPointId.pointIdFromChunk(passage.id, 0),
        passageId: passage.id,
        contentHash: "old".padEnd(40, "0"),
      },
    ]);
    mockEmbedAll.mockResolvedValue([vector()]);
    mockDeleteOrphanChunks.mockResolvedValue(5);

    const report = await indexPassages();

    expect(report.orphanPointsDeleted).toBe(5);
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

  it("typeCounts sums exactly to newPassages + changed", async () => {
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
    expect(sum).toBe(report.newPassages + report.changed);
  });
});
