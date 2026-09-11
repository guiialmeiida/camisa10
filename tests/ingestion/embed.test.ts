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

  it("splits into token-budgeted batches", async () => {
    // MAX_TOKENS_PER_BATCH is 5000; a ~5200-char text alone estimates to ~1300 tokens
    // (chars/4). Three of them (~3900) fit one batch; the fourth (~5200) tips over.
    const bigText = "palavra ".repeat(650);
    fetchSpy.mockImplementation(async (_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return voyageResponse(body.input.length);
    });

    const promise = embedAll([bigText, bigText, bigText, bigText], "document");

    // Let the first batch's fetch resolve, then fast-forward past the pacing delay for
    // every subsequent batch without actually waiting in real time.
    await vi.runAllTimersAsync();
    const vectors = await promise;

    expect(vectors).toHaveLength(4);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("waits the full ~65s pacing interval before firing the next batch — not less", async () => {
    // Same 3-fit/4th-tips split as above: exercises the part of embedAll that actually
    // fixes the rate-limit 429 (batchByTokenBudget alone doesn't: two 5K-token batches
    // fired back to back would still total 10K in the same one-minute window).
    const bigText = "palavra ".repeat(650);
    fetchSpy.mockImplementation(async (_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return voyageResponse(body.input.length);
    });

    const promise = embedAll([bigText, bigText, bigText, bigText], "document");

    // First batch fires immediately, no wait involved.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Just under the pacing interval: the second batch must not have fired yet.
    await vi.advanceTimersByTimeAsync(64_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Past the interval: now it does.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await promise;
  });

  it("keeps vectors in the same order as the input texts across multiple batches", async () => {
    // Same regression the reviewer caught by mutation: reversing the batch-concatenation
    // order in embedAll left every existing assertion green (all texts were identical,
    // so any order looked "correct"). Distinguishable texts/vectors close that gap.
    const makeText = (id: number): string => `${"palavra ".repeat(650)}#${id}`;
    const texts = [0, 1, 2, 3].map(makeText);

    fetchSpy.mockImplementation(async (_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      const data = body.input.map((text, index) => {
        const id = Number(text.split("#")[1]);
        const embedding = Array.from({ length: EMBEDDING.dimensions }, (_, dim) => (dim === 0 ? id : 0));
        return { embedding, index };
      });
      return new Response(JSON.stringify({ data }), { status: 200 });
    });

    const promise = embedAll(texts, "document");
    await vi.runAllTimersAsync();
    const vectors = await promise;

    expect(vectors.map((vector) => vector[0])).toEqual([0, 1, 2, 3]);
  });

  it("throws when a batch response has a different vector count than texts sent — never silently misaligns", async () => {
    fetchSpy.mockResolvedValue(voyageResponse(2)); // sends 3 texts, gets 2 vectors back

    await expect(embedAll(["um", "dois", "três"], "document")).rejects.toThrow(/2 embeddings for 3 texts/);
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
