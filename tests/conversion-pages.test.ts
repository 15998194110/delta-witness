import { describe, expect, it } from "vitest";
import { landingHtml, docsHtml } from "../src/discovery";

describe("buyer-facing conversion pages", () => {
  it("connects the supplier scenario to the paid app without pretending the scenario is a proof", () => {
    const html = landingHtml("https://delta.example", "0.7.1");
    expect(html).toContain("supplier recommendation");
    expect(html).toContain("FICTIONAL SCENARIO · NO PAYMENT");
    expect(html).toContain("No live capture or payment has been made");
    expect(html).toContain("https://delta-witness-app.pages.dev/?product=capture");
    expect(html).toContain("legacy_unverifiable");
    expect(html).toContain("not_anchored");
    expect(html).toContain("example.com</strong>, not a supplier");
    expect(html).toContain("The public verifier cannot show the original");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<form");
  });
  it.each([landingHtml("https://delta.example", "0.7.1"), docsHtml("https://delta.example")])("preserves 1/5/10 pricing, links, metadata limits and mobile layout", (html) => {
    for (const price of [1, 5, 10]) expect(html).toContain('class="price">' + price + ' USDC');
    expect(html).toContain("metadata and hashes");
    expect(html).toContain("not independently anchored");
    expect(html).toContain('@media(max-width:720px)');
    expect(html).toContain('<nav aria-label="Main navigation">');
    expect(html).toContain("https://delta-witness-app.pages.dev/?product=preflight");
  });
  it("starts docs with Capture and explains payment and processing separately", () => {
    const html = docsHtml("https://delta.example");
    expect(html.indexOf("Capture costs 1 USDC")).toBeLessThan(html.indexOf("10 USDC"));
    for (const text of ["202 / processing", "502 / retryable_failure", "outcome unknown", "identical payment header", "case-sensitive", "no buyer download"]) expect(html).toContain(text);
    expect(html).toContain("https://delta.example/v1/quote?product=capture");
  });
  it("escapes externally configured origin/version in markup", () => {
    const html = landingHtml('https://delta.example/\"><script>bad()</script>', '<img src=x onerror=bad()>');
    expect(html).not.toContain('<script>bad()');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain("&lt;img");
  });
});
