import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedAll } from "../../src/ingestion/embed.ts";
import { EMBEDDING } from "../../src/config/models.ts";

const fakeEnv = {
  FOOTBALL_DATA_TOKEN: "fake-token",
  API_FOOTBALL_KEY: "fake-api-football-key",
  VOYAGE_API_KEY: "voyage-fake",
  ANTHROPIC_API_KEY: "sk-ant-fake",
  QDRANT_URL: "http://localhost:6333",
};

function fakeVector(): number[] {
  return Array.from({ length: EMBEDDING.dimensions }, () => 0.1);
}

function voyageResponse(count: number): Response {
  const data = Array.from({ length: count }, (_, index) => ({ embedding: fakeVector(), index }));
  return new Response(JSON.stringify({ data }), { status: 200 });
}

describe("embedAll", () => {
  const originalEnv = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { ...process.env, ...fakeEnv };
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.useFakeTimers();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("returns [] without calling fetch for an empty input", async () => {
    expect(await embedAll([], "document")).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends everything in a single request when it fits the token budget", async () => {
    fetchSpy.mockResolvedValue(voyageResponse(3));

    const vectors = await embedAll(["um texto curto", "outro texto curto", "mais um"], "document");

    expect(vectors).toHaveLength(3);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("splits into token-budgeted batches, pacing them ~65s apart", async () => {
    // ~8000 tokens is the budget; a ~9000-char text alone estimates to ~2250 tokens,
    // safely under budget on its own but four of them (~9000 tokens) tip the next one
    // into a new batch.
    const bigText = "palavra ".repeat(1125); // ~9000 chars
    fetchSpy.mockImplementation(async (_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return voyageResponse(body.input.length);
    });

    const promise = embedAll([bigText, bigText, bigText, bigText, bigText], "document");

    // Let the first batch's fetch resolve, then fast-forward past the pacing delay for
    // every subsequent batch without actually waiting in real time.
    await vi.runAllTimersAsync();
    const vectors = await promise;

    expect(vectors).toHaveLength(5);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
  });

  it("never splits a single long text across two requests", async () => {
    fetchSpy.mockImplementation(async (_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return voyageResponse(body.input.length);
    });

    const oneHugeText = "x".repeat(100_000);
    const promise = embedAll([oneHugeText], "document");
    await vi.runAllTimersAsync();
    const vectors = await promise;

    expect(vectors).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws when a vector's dimension doesn't match EMBEDDING.dimensions", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2], index: 0 }] }), { status: 200 }),
    );

    await expect(embedAll(["texto"], "document")).rejects.toThrow(/dimensions/);
  });
});
