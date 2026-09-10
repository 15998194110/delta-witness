import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";

const config = JSON.parse(readFileSync(new NodeURL("../wrangler.jsonc", import.meta.url), "utf8"));

describe("current owner pricing policy", () => {
  it("locks the core runtime to $0.03 Capture, $0.03 Preflight, and existing Watch/partner terms", () => {
    expect(config.vars.CAPTURE_BASE_PRICE_USD).toBe("0.03");
    expect(config.vars.PREFLIGHT_BASE_PRICE_USD).toBe("0.03");
    expect(config.vars.WATCH_BASE_PRICE_USD).toBe("1");
    expect(config.vars.PARTNER_PREFLIGHT_BASE_PRICE_USD).toBe("1");
    expect(config.vars.NETWORK).toBe("eip155:8453");
    expect(config.vars.PAY_TO.toLowerCase()).toBe("0x1990e21bc219696ff7fbc26527dbaed335ac6367");
  });
});
