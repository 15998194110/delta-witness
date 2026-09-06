import { describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../src/env";
import {
  GUARDED_ACTION_PILOT_PRICE_USD,
  guardedPilotEconomics,
  parseGuardedPilotInput,
} from "../src/guarded-pilot";

describe("guarded action pilot", () => {
  it("keeps the package at exactly ten dollars", () => {
    const economics = guardedPilotEconomics({} as RuntimeEnv);
    expect(GUARDED_ACTION_PILOT_PRICE_USD).toBe(10);
    expect(economics.grossPriceUsd).toBe(10);
    expect(Number(economics.estimatedContributionMarginUsd)).toBeGreaterThan(9);
  });

  it("accepts one to three public targets with one deterministic preflight", () => {
    const parsed = parseGuardedPilotInput({
      urls: ["https://example.com", "https://example.org/path"],
      preflight: { url_index: 1, expected: { contains: ["Example"] } },
    });
    expect(parsed.urls).toHaveLength(2);
    expect(parsed.preflight?.url_index).toBe(1);
    expect(parsed.preflight?.expected.contains).toEqual(["Example"]);
  });

  it("rejects packages larger than three URLs", () => {
    expect(() => parseGuardedPilotInput({
      urls: ["https://a.example", "https://b.example", "https://c.example", "https://d.example"],
    })).toThrow("invalid_urls");
  });

  it("rejects non-HTTPS targets", () => {
    expect(() => parseGuardedPilotInput({ urls: ["http://example.com"] })).toThrow("pilot_requires_https");
  });
});
