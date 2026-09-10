import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Facts, Passage } from "../../src/sources/types.ts";

vi.mock("../../src/sources/index.ts", () => ({ getFacts: vi.fn(), listPassages: vi.fn() }));
vi.mock("../../src/ingestion/embed.ts", () => ({ embedAll: vi.fn() }));
vi.mock("../../src/vectorstore/qdrant.ts", () => ({ ensureCollection: vi.fn(), insertPoints: vi.fn() }));
vi.mock("../../src/config/env.ts", () => ({ loadEnv: () => ({ QDRANT_COLLECTION: "camisa10-test" }) }));

const { getFacts, listPassages } = await import("../../src/sources/index.ts");
const { embedAll } = await import("../../src/ingestion/embed.ts");
const { ensureCollection, insertPoints } = await import("../../src/vectorstore/qdrant.ts");
const { indexPassages } = await import("../../src/ingestion/indexer.ts");

const mockGetFacts = vi.mocked(getFacts);
const mockListPassages = vi.mocked(listPassages);
const mockEmbedAll = vi.mocked(embedAll);
const mockEnsureCollection = vi.mocked(ensureCollection);
const mockInsertPoints = vi.mocked(insertPoints);

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

describe("indexPassages", () => {
  beforeEach(() => {
    mockGetFacts.mockReset();
    mockListPassages.mockReset();
    mockEmbedAll.mockReset();
    mockEnsureCollection.mockReset();
    mockInsertPoints.mockReset();
  });

  it("throws before calling ensureCollection when the source returns 0 passages — the index isn't wiped", async () => {
    mockGetFacts.mockResolvedValue(sampleFacts);
    mockListPassages.mockResolvedValue([]);

    await expect(indexPassages()).rejects.toThrow(/0 passages/);
    expect(mockEnsureCollection).not.toHaveBeenCalled();
  });

  it("takes matchweek from facts.matchweek, and matchId: null passes through the payload", async () => {
    mockGetFacts.mockResolvedValue(sampleFacts);
    mockListPassages.mockResolvedValue([samplePassage()]);
    mockEmbedAll.mockResolvedValue([Array.from({ length: 8 }, () => 0.1)]);
    mockEnsureCollection.mockResolvedValue(undefined);
    mockInsertPoints.mockImplementation(async (points) => points.length);

    const report = await indexPassages();

    expect(report.passages).toBe(1);
    expect(report.points).toBe(1);
    expect(mockInsertPoints).toHaveBeenCalledTimes(1);

    const [points] = mockInsertPoints.mock.calls[0] ?? [];
    expect(points?.[0]?.payload.matchweek).toBe(12);
    expect(points?.[0]?.payload.matchId).toBeNull();
  });
});
