import { describe, expect, it } from "vitest";
import { hostnameAllowedByPolicy, normalizeHostname } from "./hostAccess.js";

describe("hostname admission policy", () => {
  it("accepts loopback names and IP literals without any configured entry", () => {
    for (const hostname of ["localhost", "LOCALHOST", "pi.localhost", "127.0.0.1", "10.0.0.4", "::1", "[::1]"]) {
      expect(hostnameAllowedByPolicy(hostname, [])).toBe(true);
      expect(hostnameAllowedByPolicy(hostname, undefined)).toBe(true);
    }
  });

  it("refuses foreign names until they are configured", () => {
    expect(hostnameAllowedByPolicy("evil.example", [])).toBe(false);
    expect(hostnameAllowedByPolicy("evil.example", undefined)).toBe(false);
    expect(hostnameAllowedByPolicy("evil.example", ["pi.example.com"])).toBe(false);
  });

  it("matches an exact configured name regardless of case and trailing dot", () => {
    expect(hostnameAllowedByPolicy("PI.Example.com", ["pi.example.com"])).toBe(true);
    expect(hostnameAllowedByPolicy("pi.example.com.", ["pi.example.com"])).toBe(true);
    expect(hostnameAllowedByPolicy("sub.pi.example.com", ["pi.example.com"])).toBe(false);
  });

  it("matches a dot-prefixed entry as a suffix, never as a partial label", () => {
    const policy = [".example.net"];
    expect(hostnameAllowedByPolicy("example.net", policy)).toBe(true);
    expect(hostnameAllowedByPolicy("pi.example.net", policy)).toBe(true);
    expect(hostnameAllowedByPolicy("x.y.example.net", policy)).toBe(true);
    expect(hostnameAllowedByPolicy("notexample.net", policy)).toBe(false);
  });

  it("accepts every name when the policy opts into any host", () => {
    expect(hostnameAllowedByPolicy("evil.example", true)).toBe(true);
  });

  it("does not treat shortened or non-decimal IPv4 aliases as IP literals", () => {
    // URL and node disagree about these, so they must not slip through as IPs.
    expect(hostnameAllowedByPolicy("127.1", [])).toBe(false);
    expect(hostnameAllowedByPolicy("0x7f.0.0.1", [])).toBe(false);
    expect(hostnameAllowedByPolicy("127.0.0.01", [])).toBe(false);
  });

  it("normalizes case and one trailing dot only", () => {
    expect(normalizeHostname("Pi.Example.COM.")).toBe("pi.example.com");
    expect(normalizeHostname("pi.example.com..")).toBe("pi.example.com.");
  });
});
