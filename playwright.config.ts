import { defineConfig } from "@playwright/test";

const PORT = process.env.PORT ?? "3100";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  // Starts an in-memory MongoDB + seeded app unless one is already running.
  webServer: {
    command: "npx tsx scripts/dev-local.ts",
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: true,
    timeout: 240_000,
    env: { PORT },
  },
});
