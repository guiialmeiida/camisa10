import "dotenv/config";
import { indexPassages } from "../ingestion/indexer.ts";

async function main(): Promise<void> {
  try {
    const report = await indexPassages();
    console.log(`${report.passages} passages -> ${report.points} points in collection ${report.collection}`);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
