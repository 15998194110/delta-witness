import { beforeEach, vi } from "vitest";

// A missing test double must fail locally, never reach a live provider.
beforeEach(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline_test_requires_fetch_double")));
});
