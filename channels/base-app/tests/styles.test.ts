// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const styles = readFileSync(resolve("src/styles.css"), "utf8");

describe("Base app responsive buyer examples", () => {
  it("parses the mobile use-case rules without literal newline escapes", () => {
    expect(styles).not.toContain("\\n");
    const element = document.createElement("style");
    element.textContent = styles;
    document.head.append(element);
    try {
      const media = Array.from(element.sheet!.cssRules).find((rule) =>
        "media" in rule && (rule as CSSMediaRule).media.mediaText === "(max-width: 820px)",
      ) as CSSMediaRule;
      expect(media).toBeDefined();
      const rule = (selector: string) => Array.from(media.cssRules).find((candidate) =>
        "selectorText" in candidate && candidate.selectorText === selector,
      ) as CSSStyleRule;
      expect(rule(".use-cases").style.getPropertyValue("grid-template-columns")).toBe("1fr");
      expect(rule(".use-cases article, .use-cases article + article").style.getPropertyValue("border-left")).toBe("0");
      expect(rule(".use-cases article:last-child").style.getPropertyValue("border-bottom")).toBe("0");
    } finally {
      element.remove();
    }
  });
});
