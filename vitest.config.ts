import { defineConfig } from "vitest/config";

// The default run (npm test) never spends on API calls or depends on Docker:
// tests/integration/ is excluded here and runs via `npm run test:integration`
// (see vitest.integration.config.ts).
export default defineConfig({
  test: {
    exclude: ["node_modules/**", "tests/integration/**"],
  },
});
