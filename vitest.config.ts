import { defineConfig } from "vitest/config";
export default defineConfig({
  cacheDir: ".artifacts-checks/vite",
  test: {
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "extensions/**/*.ts"],
      reportsDirectory: "coverage",
      reporter: ["text", "json", "html"],
    },
    projects: [
      { test: { name: "unit", include: ["tests/unit/**/*.test.ts"] } },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
    ],
  },
});
