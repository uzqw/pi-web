/**
 * Hostname admission policy shared by the web/API edge and the Vite dev server.
 *
 * `true` accepts every hostname, an array (including an empty one) accepts only
 * loopback names, IP literals and the listed names, and an undefined policy is
 * treated like an empty array so a config written before this setting existed
 * still refuses foreign hostnames.
 */
export type HostAccessPolicy = readonly string[] | true;

export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/u, "");
}

/** Match an actual hostname, not a URL or authority; callers own input validation. */
export function hostnameAllowedByPolicy(hostname: string, policy: HostAccessPolicy | undefined): boolean {
  if (policy === true) return true;
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host.endsWith(".localhost") || isIpLiteral(host)) return true;
  return (policy ?? []).some((value) => {
    const entry = normalizeHostname(value);
    return entry === host || (entry.startsWith(".") && (host === entry.slice(1) || host.endsWith(entry)));
  });
}

function isIpLiteral(hostname: string): boolean {
  if (!hostname.includes(":")) {
    const octets = hostname.split(".");
    // URL accepts shortened, octal and numeric IPv4 aliases; only canonical
    // decimal octets have the same meaning as node:net's isIP here.
    return octets.length === 4 && octets.every((octet) => {
      const value = Number(octet);
      return Number.isInteger(value) && value >= 0 && value <= 255 && String(value) === octet;
    });
  }
  const address = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  // Constrain the URL input to an IPv6 literal, never repaired URL syntax.
  if (/[^0-9a-f:.]/u.test(address)) return false;
  try {
    return new URL(`http://[${address}]`).hostname.startsWith("[");
  } catch {
    return false;
  }
}
