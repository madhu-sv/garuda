import ipaddr from "ipaddr.js";

/**
 * Which IP addresses web_fetch may connect to (SSRF protection, 0.2).
 * Only public unicast addresses. Loopback only when the user allows localhost.
 * ipaddr.js does the parsing: it handles IPv4-mapped IPv6 and odd forms (octal, hex).
 */
export type AddressVerdict = { ok: true } | { ok: false; range: string };

export function checkAddress(address: string, allowLocalhost: boolean): AddressVerdict {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.process(address);
  } catch {
    return { ok: false, range: "invalid" };
  }
  const range = parsed.range();
  if (range === "unicast") return { ok: true };
  if (range === "loopback" && allowLocalhost) return { ok: true };
  return { ok: false, range };
}

/** True for a host that is written as an IP address (v4 or v6, with or without brackets). */
export function isIpLiteral(host: string): boolean {
  return ipaddr.isValid(host.replace(/^\[|\]$/g, ""));
}

/** True for "localhost" and loopback IP literals. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare === "localhost") return true;
  return ipaddr.isValid(bare) && ipaddr.process(bare).range() === "loopback";
}
