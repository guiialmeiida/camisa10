import { defineConfig } from "vitest/config";

// Complemento de vitest.config.ts: Vitest aplica `exclude` antes de qualquer filtro
// de linha de comando, então `vitest run tests/integration` sozinho não basta para
// rodar o que o config padrão exclui — daí este segundo config, só para
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
