import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// A self-contained config for the Task 5 harness only. It does not touch the
// project's own vitest.config.mts, so `npm test` keeps running `tests/**` and the
// three pre-existing failures in tests/payment-flow/* stay visible rather than being
// papered over by Task 5 work.
//
//   node .\node_modules\vitest\vitest.mjs run --config task-5\vitest.config.mts
export default defineConfig({
  resolve: {
    alias: {
      // This config lives in task-5/, so the repo root is one level up. Pointing "@"
      // at task-5/ instead would resolve "@/lib/..." to task-5/lib, which does not exist.
      "@": fileURLToPath(new URL("../", import.meta.url)),
    },
  },
  test: {
    include: ["task-5/harness/**/*.test.ts"],
    environment: "node",
    // A1 exercises fulfilFromWebhook against the real Prisma schema, so DATABASE_URL
    // has to be loaded the same way the project's own tests load it. This reuses the
    // existing setup file rather than duplicating it.
    setupFiles: ["tests/setup.ts"],
    // Serial, because A1 writes to the same database the project's own tests use and
    // a parallel run would interleave their fixtures.
    fileParallelism: false,
  },
});