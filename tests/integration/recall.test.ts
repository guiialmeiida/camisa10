import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Same reasoning as golden-rule.test.ts: task 01 moved sources off the fixture, so this
// evaluation can no longer assume `npm run index` populated the collection with the
// fixture's 14 known-ground-truth passages. Mock src/sources/index.ts back to the
// fixture double, just for this file, and index it into its own collection below.
vi.mock("../../src/sources/index.ts", async () => {
  const fixtureSource = await import("../fixtures/fixture-source.ts");
  return {
    getFacts: fixtureSource.getFacts,
    listPassages: fixtureSource.listPassages,
    listTeams: fixtureSource.listTeams,
    COMPETITION: fixtureSource.COMPETITION,
  };
});

const { indexPassages } = await import("../../src/ingestion/indexer.ts");
const { measureRecall } = await import("../eval/recall.ts");
import type { RecallReport } from "../eval/recall.ts";

// Agreed with the user when the spec was approved (docs/tasks/00-vertical-slice.md).
// If the first real measurement falls below this, lowering the threshold vs. fixing
// retrieval is the user's call, not the implementer's.
const RECALL_THRESHOLD = 0.8;

describe("recall@5 against the fixture", () => {
  const originalCollection = process.env["QDRANT_COLLECTION"];

  // One measurement shared by both cases below — a second call would re-embed all 15
  // questions and re-run all 15 searches for no reason, doubling this file's real API
  // cost and its exposure to Voyage's free-tier rate limit.
  let report: RecallReport;

  beforeAll(async () => {
    process.env["QDRANT_COLLECTION"] = "camisa10-eval";
    await indexPassages();

    report = await measureRecall({ k: 5 });

    // Printed even when it passes — an aggregate recall alone doesn't say which
    // question broke after someone touches chunking.
    console.log(`recall@${report.k} = ${report.recall.toFixed(3)}`);
    for (const question of report.perQuestion) {
      console.log(
        `  ${question.id}: recall=${question.recall.toFixed(2)} expected=[${question.expected.join(", ")}] retrieved=[${question.retrieved.join(", ")}]`,
      );
    }
    // Default hook timeout (5-10s) isn't enough now that this file also indexes the
    // fixture (embedAll + ensureCollection + insertPoints) before measuring recall.
  }, 30_000);

  afterAll(() => {
    if (originalCollection === undefined) {
      delete process.env["QDRANT_COLLECTION"];
    } else {
      process.env["QDRANT_COLLECTION"] = originalCollection;
    }
  });

  it("meets the agreed threshold", () => {
    expect(report.recall).toBeGreaterThanOrEqual(RECALL_THRESHOLD);
  });

  it("always returns k results for a team outside the fixture — search never says 'I don't know'", () => {
    const outOfFixture = report.perQuestion.find((question) => question.expected.length === 0);

    expect(outOfFixture).toBeDefined();
    expect(outOfFixture?.retrieved.length).toBe(5);
    expect(report.falsePositives).toBeGreaterThan(0);
  });
});
