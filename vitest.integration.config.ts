import { defineConfig } from "vitest/config";

// Complemento de vitest.config.ts: Vitest aplica `exclude` antes de qualquer filtro
// de linha de comando, então `vitest run tests/integration` sozinho não basta para
// rodar o que o config padrão exclui — daí este segundo config, só para
// `npm run test:integration`.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
  },
});
