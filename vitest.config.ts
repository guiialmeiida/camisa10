import { defineConfig } from "vitest/config";

// A run padrão (npm test) nunca gasta API nem depende de Docker: os testes de
// tests/integration/ ficam fora daqui e rodam via `npm run test:integration`
// (ver vitest.integration.config.ts).
export default defineConfig({
  test: {
    exclude: ["node_modules/**", "tests/integration/**"],
  },
});
