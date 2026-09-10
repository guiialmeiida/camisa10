import "dotenv/config";
import { answer } from "../agent/graph.ts";
import { formatTrace } from "../agent/trace.ts";

interface ParsedArgs {
  question: string;
  k: number;
  trace: boolean;
}

const USAGE = 'usage: npm run ask -- "your question" [--k=8] [--no-trace]';

/**
 * The CLI is a boundary: process.argv is string[], and under noUncheckedIndexedAccess
 * every position is string | undefined — which is the truth (an argument may not be
 * there). --k=8 is parsed with Number.parseInt and NaN is rejected with its own
 * message; this is where the validation that getFacts' type made unnecessary lives on.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let k = 5;
  let trace = true;

  for (const arg of argv) {
    if (arg === "--no-trace") {
      trace = false;
      continue;
    }
    if (arg.startsWith("--k=")) {
      const raw = arg.slice("--k=".length);
      // Number.parseInt("8abc", 10) silently returns 8 — a full-match digit check
      // catches that, and >= 1 keeps Qdrant's limit param from ever seeing 0/negative.
      if (!/^\d+$/.test(raw) || Number.parseInt(raw, 10) < 1) {
        throw new Error(`invalid --k value: "${raw}" (must be a positive integer)`);
      }
      k = Number.parseInt(raw, 10);
      continue;
    }
    positional.push(arg);
  }

  const question = positional.join(" ").trim();
  if (question.length === 0) {
    throw new Error(USAGE);
  }

  return { question, k, trace };
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    // process.exitCode + a natural return, not process.exit(): exit() can cut off
    // stdout that's still draining to a pipe (confirmed: a 300KB console.log piped
    // through `| wc -c` loses everything past 64KB when exit() follows it directly).
    process.exitCode = 2;
    return;
  }

  try {
    const state = await answer({ question: args.question, k: args.k });
    console.log(args.trace ? formatTrace(state) : state.answer.text);
    process.exitCode = 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();
