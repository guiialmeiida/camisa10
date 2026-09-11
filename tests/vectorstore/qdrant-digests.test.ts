import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fetchDigests' three degradation paths (spec §9) were only verified by hand against a
// real Qdrant during review — this locks them in as automated tests, mocking the client
// so no Docker/network is needed.
const { mockCollectionExists, mockRetrieve } = vi.hoisted(() => ({
  mockCollectionExists: vi.fn(),
  mockRetrieve: vi.fn(),
}));

vi.mock("@qdrant/js-client-rest", () => ({
  // A regular function, not an arrow: `new QdrantClient(...)` requires something
  // constructable, and arrow functions can never be called with `new`.
  QdrantClient: vi.fn().mockImplementation(function QdrantClientStub() {
    return { collectionExists: mockCollectionExists, retrieve: mockRetrieve };
  }),
}));

const { fetchDigests } = await import("../../src/vectorstore/qdrant.ts");

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
