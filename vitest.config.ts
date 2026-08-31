import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "packages/**", "channels/**"],
    coverage: { reporter: ["text", "json-summary"] },
  },
});
