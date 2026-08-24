import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@india-stack/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@india-stack/connector-tally": path.resolve(__dirname, "packages/connector-tally/src/index.ts"),
      "@india-stack/connector-zoho": path.resolve(__dirname, "packages/connector-zoho/src/index.ts"),
      "@india-stack/connector-gst": path.resolve(__dirname, "packages/connector-gst/src/index.ts")
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "evals/**/*.test.ts"],
    environment: "node"
  }
});
