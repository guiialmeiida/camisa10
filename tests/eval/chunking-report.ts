import "dotenv/config";
import { CHUNK_OVERLAP, CHUNK_SIZE, chunkText } from "../../src/ingestion/chunk.ts";
import { embedAll } from "../../src/ingestion/embed.ts";
import { listPassages } from "../../src/sources/index.ts";
import { search } from "../../src/vectorstore/qdrant.ts";

// Manual inspection tool for task 03 (spec §11) — separate from the fixture's recall@k
// (tests/eval/recall.ts), which never exercises chunking because the fixture is one
// chunk per passage by design (docs/tasks/03-vector-index.md §1). This one runs against
// the real index, has no threshold and no pass/fail, and is never collected by vitest
// (it doesn't match tests/**/*.test.ts) — see docs/learning/04-chunking.md's "por que não
// gate de CI" for why that's on purpose.
//
//   npm run eval:chunking
//   npm run eval:chunking -- --size=600 --overlap=100
//   npm run eval:chunking -- "como o Palmeiras vem jogando?"
//   npm run eval:chunking -- --k=8 "como o Palmeiras vem jogando?"

const USAGE = 'usage: npm run eval:chunking -- [--size=N] [--overlap=N] [--k=N] ["pergunta"]';

interface ParsedArgs {
  size: number;
  overlap: number;
  k: number;
  question: string | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  let size = CHUNK_SIZE;
  let overlap = CHUNK_OVERLAP;
  let k = 5;
  let question: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith("--size=")) {
      size = Number(arg.slice("--size=".length));
      continue;
    }
    if (arg.startsWith("--overlap=")) {
      overlap = Number(arg.slice("--overlap=".length));
      continue;
    }
    if (arg.startsWith("--k=")) {
      k = Number(arg.slice("--k=".length));
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`unknown argument: "${arg}"\n${USAGE}`);
    }
    question = arg;
  }

  return { size, overlap, k, question };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

/** Never touches the index — chunks the source's own passages locally, in memory. */
function printDistribution(size: number, overlap: number, chunksByPassage: string[][]): void {
  const chunkCounts = chunksByPassage.map((chunks) => chunks.length);
  const chunkLengths = chunksByPassage.flatMap((chunks) => chunks.map((chunk) => chunk.length));
  const singleChunkPassages = chunkCounts.filter((count) => count === 1).length;

  console.log(`chunking (size=${size}, overlap=${overlap})`);
  console.log(`  ${chunksByPassage.length} passages -> ${chunkLengths.length} chunks`);
  console.log(
    `  chunks/passage: min ${Math.min(...chunkCounts)}, median ${median(chunkCounts)}, max ${Math.max(...chunkCounts)}`,
  );
  console.log(
    `  chunk length: min ${Math.min(...chunkLengths)}, median ${median(chunkLengths)}, max ${Math.max(...chunkLengths)}`,
  );
  console.log(`  ${singleChunkPassages} passage(s) produce a single chunk`);
}

/** One embedding call, one search against the configured collection. Never writes. */
async function printRetrieval(question: string, k: number): Promise<void> {
  const [vector] = await embedAll([question], "query");
  if (!vector) {
    throw new Error("eval:chunking: no embedding returned for the question");
  }

  const results = await search({ vector, k });

  console.log("");
  console.log(`retrieval for "${question}" (k=${k})`);
  if (results.length === 0) {
    console.log("  no passages retrieved");
    return;
  }

  results.forEach((result, index) => {
    const chunkLabel =
      result.payload.chunkCount > 1 ? ` chunk ${result.payload.chunkIndex + 1}/${result.payload.chunkCount}` : "";
    const snippet = result.payload.text.length > 120 ? `${result.payload.text.slice(0, 120)}…` : result.payload.text;
    console.log(
      `  #${index + 1}  ${result.score.toFixed(3)}  ${result.payload.passageId}${chunkLabel}  ${result.payload.type}  "${snippet}"`,
    );
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const passages = await listPassages();
  const chunksByPassage = passages.map((passage) =>
    chunkText(passage.text, { size: args.size, overlap: args.overlap }),
  );
  printDistribution(args.size, args.overlap, chunksByPassage);

  if (args.question !== undefined) {
    await printRetrieval(args.question, args.k);
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
