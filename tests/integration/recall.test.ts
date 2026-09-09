import "dotenv/config";
import { describe, expect, it } from "vitest";
import { measureRecall } from "../eval/recall.ts";

// Agreed with the user when the spec was approved (docs/tasks/00-vertical-slice.md).
// If the first real measurement falls below this, lowering the threshold vs. fixing
// retrieval is the user's call, not the implementer's.
const RECALL_THRESHOLD = 0.8;

describe("recall@5 against the fixture", () => {
  it("meets the agreed threshold", async () => {
    const report = await measureRecall({ k: 5 });

    // Printed even when it passes — an aggregate recall alone doesn't say which
    // question broke after someone touches chunking.
    console.log(`recall@${report.k} = ${report.recall.toFixed(3)}`);
    for (const question of report.perQuestion) {
      console.log(
        `  ${question.id}: recall=${question.recall.toFixed(2)} expected=[${question.expected.join(", ")}] retrieved=[${question.retrieved.join(", ")}]`,
      );
    }

    expect(report.recall).toBeGreaterThanOrEqual(RECALL_THRESHOLD);
  });

  it("always returns k results for a team outside the fixture — search never says 'I don't know'", async () => {
    const report = await measureRecall({ k: 5 });
    const outOfFixture = report.perQuestion.find((question) => question.expected.length === 0);

    expect(outOfFixture).toBeDefined();
    expect(outOfFixture?.retrieved.length).toBe(5);
    expect(report.falsePositives).toBeGreaterThan(0);
  });
});
