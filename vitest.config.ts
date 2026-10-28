import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/offline-setup.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "packages/**", "channels/**", "evidence/**"],
    coverage: { reporter: ["text", "json-summary"] },
  },
});
