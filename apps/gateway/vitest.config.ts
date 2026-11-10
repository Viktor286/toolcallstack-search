import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The Postgres-backed test files share one database, so they must not overlap.
    fileParallelism: false,
  },
});
