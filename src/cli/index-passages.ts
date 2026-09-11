import "dotenv/config";
import { indexPassages } from "../ingestion/indexer.ts";
import type { IndexReport } from "../ingestion/indexer.ts";
import type { PassageType } from "../sources/types.ts";

const USAGE = "usage: npm run index -- [--recreate]";

interface ParsedArgs {
  recreate: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let recreate = false;

  for (const arg of argv) {
    if (arg === "--recreate") {
      recreate = true;
      continue;
    }
    throw new Error(`unknown argument: "${arg}"\n${USAGE}`);
  }

  return { recreate };
}

function formatTypeCounts(typeCounts: Record<PassageType, number>): string {
  const order: PassageType[] = ["article", "matchReport", "chronicle", "preview"];
  return order
    .filter((type) => typeCounts[type] > 0)
    .map((type) => `${typeCounts[type]} ${type}`)
    .join(", ");
}

function printReport(report: IndexReport): void {
  console.log(`collection ${report.collection} (${report.mode})`);
  console.log(`  ${report.passages} passages from the source`);

  if (report.mode === "recreate") {
    console.log(`  ${report.newPassages} to index (full rebuild)`);
  } else {
    console.log(`  ${report.newPassages} new, ${report.changed} changed, ${report.unchanged} unchanged`);
  }

  if (report.points === 0) {
    console.log("  nothing to do — no embeddings, no LLM calls, no writes");
    return;
  }

  const fallbackWord = report.classificationFallbacks === 1 ? "fallback" : "fallbacks";
  console.log(
    `  ${report.points} classified: ${formatTypeCounts(report.typeCounts)}  (${report.classificationFallbacks} ${fallbackWord})`,
  );
  console.log(`  ${report.points} points upserted`);
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  try {
    const report = await indexPassages({ recreate: args.recreate });
    printReport(report);
    process.exitCode = 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();
