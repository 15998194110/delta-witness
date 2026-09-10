import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";

const config = JSON.parse(readFileSync(new NodeURL("../wrangler.jsonc", import.meta.url), "utf8"));

describe("partner pricing policy", () => {
  it("charges the $1 entry price for new partner and watch calls", () => {
    expect(config.vars.PARTNER_NET_CAPTURE_USD).toBe("1");
    expect(config.vars.PARTNER_NET_PREFLIGHT_USD).toBe("1");
    expect(config.vars.PARTNER_NET_WATCH_CHECK_USD).toBe("1");
  });
});
