import { describe, expect, it, vi } from "vitest";
import {
  assertPublicDns,
  readJsonRequestBounded,
  resolvePublicRedirects,
  validateTarget,
  isNonPublicIpv6,
  BROWSER_REJECT_PATTERNS,
} from "../src/security";

describe("public URL policy", () => {
  it("allows ordinary public HTTP(S) URLs", () => {
    expect(validateTarget("https://example.com/path").hostname).toBe("example.com");
    expect(validateTarget("http://example.com:80/").protocol).toBe("http:");
  });

  it.each([
    "http://localhost/",
    "http://localhost./",
    "http://a.local/",
    "http://127.0.0.1/",
    "http://10.2.3.4/",
    "http://100.64.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://172.31.0.1/",
    "http://192.168.1.1/",
    "http://198.18.0.1/",
    "http://203.0.113.1/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://[64:ff9b::a00:1]/",
    "http://[2002:7f00:1::]/",
    "http://[2001:db8::1]/",
    "http://user:pass@example.com/",
    "http://example.com:8080/",
    "file:///etc/passwd",
  ])("blocks unsafe target %s", (url) => {
    expect(() => validateTarget(url)).toThrow();
  });

  it("blocks public hostnames resolving to private addresses", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const url = String(_input);
      const type = new URL(url).searchParams.get("type");
      return Response.json(type === "A"
        ? { Status: 0, Answer: [{ type: 1, data: "10.0.0.9" }] }
        : { Status: 0, Answer: [] }, init);
    }) as unknown as typeof fetch;
    await expect(assertPublicDns("rebinding.example", fetchImpl)).rejects.toThrow("private_dns_target_not_allowed");
  });

  it("keeps ordinary global unicast IPv6 available", () => {
    expect(isNonPublicIpv6("2606:4700:4700::1111")).toBe(false);
    expect(validateTarget("https://[2606:4700:4700::1111]/").hostname).toBe("[2606:4700:4700::1111]");
  });

  it.each(["::ffff:7f00:1", "0:0:0:0:0:0:0:1", "0:0:0:0:0:ffff:192.168.1.1", "fe80:0:0:0:0:0:0:1"])("rejects non-public AAAA %s even with a public A", async address => {
    const dns = vi.fn(async (url: string | URL | Request) => Response.json({Status:0, Answer:[new URL(String(url)).searchParams.get("type") === "A" ? {type:1,data:"93.184.216.34"} : {type:28,data:address}]})) as unknown as typeof fetch;
    await expect(assertPublicDns("example.com", dns)).rejects.toThrow("private_dns_target_not_allowed");
  });

  it.each(["failed", "servfail", "malformed_v4", "malformed_v6"])("does not proceed with incomplete DNS assurance: %s", async variant => {
    const dns = vi.fn(async (url: string | URL | Request) => {
      if (new URL(String(url)).searchParams.get("type") === "A") return Response.json({Status:0,Answer:[{type:1,data:"93.184.216.34"}]});
      if (variant === "failed") return new Response("unavailable", {status:503});
      if (variant === "servfail") return Response.json({Status:2});
      return Response.json({Status:0,Answer:[variant === "malformed_v4" ? {type:1,data:"999.1.1.1"} : {type:28,data:"not-an-ip"}]});
    }) as unknown as typeof fetch;
    await expect(assertPublicDns("example.com", dns)).rejects.toThrow("dns_resolution_failed");
  });

  it.each(["http://[::ffff:7f00:1]/", "http://[64:ff9b::a00:1]/", "http://[2002:7f00:1::]/", "http://a.b.local/", "http://user:pass@public.example/", "http://198.18.1.1/"])("rejects unsafe browser subresource %s", url => {
    expect(BROWSER_REJECT_PATTERNS.some(pattern => new RegExp(pattern).test(url))).toBe(true);
  });

  it("uses a Workers-compatible manual redirect policy for DNS resolution", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] });
    }) as unknown as typeof fetch;
    await expect(assertPublicDns("example.com", fetchImpl)).resolves.toBeUndefined();
  });

  it("rejects DNS resolver redirects rather than following them", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://resolver.invalid/dns-query" },
    })) as unknown as typeof fetch;
    await expect(assertPublicDns("example.com", fetchImpl)).rejects.toThrow("dns_resolver_redirect_not_allowed");
  });
});

describe("redirect and payload bounds", () => {
  const dns = (url: string) => {
    const type = new URL(url).searchParams.get("type");
    return Response.json(type === "A"
      ? { Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] }
      : { Status: 0, Answer: [] });
  };

  it("rejects a redirect into a private network", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://cloudflare-dns.com/")) return dns(url);
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
    }) as unknown as typeof fetch;
    await expect(resolvePublicRedirects("https://example.com", fetchImpl)).rejects.toThrow("private_target_not_allowed");
  });

  it("bounds redirect hops", async () => {
    let hop = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://cloudflare-dns.com/")) return dns(url);
      hop += 1;
      return new Response(null, { status: 302, headers: { location: `https://example.com/${hop}` } });
    }) as unknown as typeof fetch;
    await expect(resolvePublicRedirects("https://example.com", fetchImpl, 1)).rejects.toThrow("too_many_redirects");
  });

  it("rejects declared and streamed bodies over the limit", async () => {
    const declared = new Request("https://delta.test/v1/capture", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "5000" },
      body: "{}",
    });
    await expect(readJsonRequestBounded(declared, 4096)).rejects.toThrow("request_too_large");

    const streamed = new Request("https://delta.test/v1/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(5000) }),
    });
    await expect(readJsonRequestBounded(streamed, 4096)).rejects.toThrow("body_too_large");
  });
});
