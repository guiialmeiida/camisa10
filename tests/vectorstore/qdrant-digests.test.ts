import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fetchDigests' three degradation paths (spec §9) were only verified by hand against a
// real Qdrant during review — this locks them in as automated tests, mocking the client
// so no Docker/network is needed. deleteOrphanChunks' cases (task 03 §7) join it here for
// the same reason: the client mock, not the filter shape, is what needs Docker to be real
// — tests/integration/vectorstore.test.ts covers the filter shape against a real server.
const { mockCollectionExists, mockRetrieve, mockCount, mockDelete } = vi.hoisted(() => ({
  mockCollectionExists: vi.fn(),
  mockRetrieve: vi.fn(),
  mockCount: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("@qdrant/js-client-rest", () => ({
  // A regular function, not an arrow: `new QdrantClient(...)` requires something
  // constructable, and arrow functions can never be called with `new`.
  QdrantClient: vi.fn().mockImplementation(function QdrantClientStub() {
    return {
      collectionExists: mockCollectionExists,
      retrieve: mockRetrieve,
      count: mockCount,
      delete: mockDelete,
    };
  }),
}));

const { deleteOrphanChunks, fetchDigests } = await import("../../src/vectorstore/qdrant.ts");

const fakeEnv = {
  FOOTBALL_DATA_TOKEN: "fake-token",
  API_FOOTBALL_KEY: "fake-api-football-key",
  VOYAGE_API_KEY: "voyage-fake",
  ANTHROPIC_API_KEY: "sk-ant-fake",
  QDRANT_URL: "http://localhost:6333",
};

describe("fetchDigests", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...process.env, ...fakeEnv };
    mockCollectionExists.mockReset();
    mockRetrieve.mockReset();
    mockCount.mockReset();
    mockDelete.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("omits a point whose payload has no usable contentHash, with a warning — it gets reindexed instead of breaking", async () => {
    mockCollectionExists.mockResolvedValue({ exists: true });
    mockRetrieve.mockResolvedValue([
      { id: 1, payload: { passageId: "p1", contentHash: "abc123" } },
      { id: 2, payload: { passageId: "p2" } }, // indexed before task 02, no contentHash field
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const digests = await fetchDigests([1, 2]);

    expect(digests).toEqual([{ pointId: 1, passageId: "p1", contentHash: "abc123" }]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns [] without calling retrieve() when the collection doesn't exist yet", async () => {
    mockCollectionExists.mockResolvedValue({ exists: false });

    const digests = await fetchDigests([1, 2]);

    expect(digests).toEqual([]);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("throws instead of returning [] when Qdrant is unreachable — [] would be read as 'empty index' and reindex everything", async () => {
    mockCollectionExists.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(fetchDigests([1])).rejects.toThrow(/could not reach Qdrant/);
  });

  it("throws when retrieve() itself fails after the collection was confirmed to exist", async () => {
    mockCollectionExists.mockResolvedValue({ exists: true });
    mockRetrieve.mockRejectedValue(new Error("timeout"));

    await expect(fetchDigests([1])).rejects.toThrow(/could not reach Qdrant/);
  });
});

describe("deleteOrphanChunks", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...process.env, ...fakeEnv };
    mockCollectionExists.mockReset();
    mockRetrieve.mockReset();
    mockCount.mockReset();
    mockDelete.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns 0 without any request for an empty sweep list", async () => {
    const deleted = await deleteOrphanChunks([]);

    expect(deleted).toBe(0);
    expect(mockCount).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("does not call delete when count returns 0", async () => {
    mockCount.mockResolvedValue({ count: 0 });

    const deleted = await deleteOrphanChunks([{ passageId: "p1", chunkCount: 2 }]);

    expect(deleted).toBe(0);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("calls delete with the same filter as count when count returns > 0, and returns that count", async () => {
    mockCount.mockResolvedValue({ count: 3 });
    mockDelete.mockResolvedValue({ status: "completed" });

    const deleted = await deleteOrphanChunks([{ passageId: "p1", chunkCount: 2 }]);

    expect(deleted).toBe(3);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    const [, countArgs] = mockCount.mock.calls[0] ?? [];
    const [, deleteArgs] = mockDelete.mock.calls[0] ?? [];
    expect(deleteArgs.filter).toEqual(countArgs.filter);
  });

  it("builds one `should` clause per sweep, each a `must` of passageId match + chunkIndex range", async () => {
    mockCount.mockResolvedValue({ count: 1 });
    mockDelete.mockResolvedValue({ status: "completed" });

    await deleteOrphanChunks([
      { passageId: "p1", chunkCount: 2 },
      { passageId: "p2", chunkCount: 5 },
    ]);

    const [, countArgs] = mockCount.mock.calls[0] ?? [];
    expect(countArgs.filter).toEqual({
      should: [
        { must: [{ key: "passageId", match: { value: "p1" } }, { key: "chunkIndex", range: { gte: 2 } }] },
        { must: [{ key: "passageId", match: { value: "p2" } }, { key: "chunkIndex", range: { gte: 5 } }] },
      ],
    });
  });

  it("splits 70 sweeps into 2 batches (64 + 6)", async () => {
    mockCount.mockResolvedValue({ count: 0 });

    const sweeps = Array.from({ length: 70 }, (_, index) => ({ passageId: `p${index}`, chunkCount: 1 }));
    await deleteOrphanChunks(sweeps);

    expect(mockCount).toHaveBeenCalledTimes(2);
    const [, firstArgs] = mockCount.mock.calls[0] ?? [];
    const [, secondArgs] = mockCount.mock.calls[1] ?? [];
    expect(firstArgs.filter.should).toHaveLength(64);
    expect(secondArgs.filter.should).toHaveLength(6);
  });

  it("throws with 'could not reach Qdrant', never returning 0, when count fails", async () => {
    mockCount.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(deleteOrphanChunks([{ passageId: "p1", chunkCount: 1 }])).rejects.toThrow(/could not reach Qdrant/);
  });

  it("throws with 'could not reach Qdrant', never returning 0, when delete fails", async () => {
    mockCount.mockResolvedValue({ count: 2 });
    mockDelete.mockRejectedValue(new Error("timeout"));

    await expect(deleteOrphanChunks([{ passageId: "p1", chunkCount: 1 }])).rejects.toThrow(/could not reach Qdrant/);
  });
});
