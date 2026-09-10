import { defineConfig } from "vitest/config";

// Complements vitest.config.ts: Vitest applies `exclude` before any command-line
// filter, so `vitest run tests/integration` alone isn't enough to run what the
// default config excludes — hence this second config, just for
// `npm run test:integration`.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    // Sequential on purpose: these files share external rate limits (Voyage's free
    // tier is 3 requests/min without a payment method on file), so running them
    // concurrently causes intermittent 429s unrelated to the code under test.
    fileParallelism: false,
    // Opt-in record/replay cache for the Anthropic and Voyage calls — see the file for
    // details. A no-op unless LLM_CASSETTE is set, so this doesn't change default behavior.
    setupFiles: ["./tests/integration/support/llm-cassette.ts"],
  },
});
