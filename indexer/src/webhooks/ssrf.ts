import dns from "node:dns/promises";
import net from "node:net";

export interface SsrfCheckResult {
  safe: boolean;
  reason?: string;
  resolvedIp?: string;
}

/**
 * Checks if an IPv4 address belongs to a disallowed or private/internal range.
 */
function isDisallowedIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // malformed IP
  }

  const [b0, b1] = parts;

  // 0.0.0.0/8 Current network
  if (b0 === 0) return true;

  // 127.0.0.0/8 Loopback
  if (b0 === 127) return true;

  // 10.0.0.0/8 Private RFC 1918
  if (b0 === 10) return true;

  // 172.16.0.0/12 Private RFC 1918 (172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;

  // 192.168.0.0/16 Private RFC 1918
  if (b0 === 192 && b1 === 168) return true;

  // 169.254.0.0/16 Link-local / Cloud Metadata (including 169.254.169.254)
  if (b0 === 169 && b1 === 254) return true;

  // 100.64.0.0/10 Shared Address Space (Carrier NAT)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;

  // 192.0.0.0/24 IETF Protocol Assignments
  if (b0 === 192 && b1 === 0 && parts[2] === 0) return true;

  // 198.18.0.0/15 Benchmarking
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;

  // 224.0.0.0/4 Multicast
  if (b0 >= 224 && b0 <= 239) return true;

  // 240.0.0.0/4 Reserved
  if (b0 >= 240) return true;

  // Broadcast
  if (ip === "255.255.255.255") return true;

  return false;
}

/**
 * Expands an IPv6 address (including embedded dotted-quad IPv4) into 8 16-bit words.
 * Returns null if the address cannot be parsed.
 */
function parseIpv6Words(ip: string): number[] | null {
  let clean = ip.toLowerCase().trim();
  if (clean.startsWith("[") && clean.endsWith("]")) {
    clean = clean.slice(1, -1);
  }
  const zoneIdx = clean.indexOf("%");
  if (zoneIdx !== -1) {
    clean = clean.slice(0, zoneIdx);
  }
  // Convert trailing dotted-quad IPv4 (e.g. ::ffff:127.0.0.1 or ::169.254.169.254) into two 16-bit hex groups
  const lastColon = clean.lastIndexOf(":");
  if (lastColon !== -1 && clean.slice(lastColon + 1).includes(".")) {
    const ipv4Str = clean.slice(lastColon + 1);
    const parts = ipv4Str.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
      return null;
    }
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    clean = `${clean.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const dblParts = clean.split("::");
  if (dblParts.length > 2) return null;
  const left = dblParts[0] ? dblParts[0].split(":") : [];
  const right = dblParts.length === 2 && dblParts[1] ? dblParts[1].split(":") : [];
  const missing = 8 - (left.length + right.length);
  if ((dblParts.length === 1 && missing !== 0) || (dblParts.length === 2 && missing < 1)) {
    return null;
  }
  const full = dblParts.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (full.length !== 8) return null;
  const words: number[] = [];
  for (const g of full) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    words.push(parseInt(g, 16));
  }
  return words;
}

function wordsToIpv4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * Checks if an IPv6 address belongs to a disallowed internal, special-purpose, or IPv4-transition range.
 */
function isDisallowedIpv6(ip: string): boolean {
  const words = parseIpv6Words(ip);
  if (!words) return true; // fail-closed on malformed IPv6

  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;

  // Unspecified ::/128 or Loopback ::1/128
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && (w7 === 0 || w7 === 1)) {
    return true;
  }

  // IPv4-compatible ::/96 (RFC 4291 deprecated) — e.g. ::127.0.0.1 (::7f00:1) or ::169.254.169.254 (::a9fe:a9fe)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    return true;
  }

  // IPv4-mapped ::ffff:0:0/96 and IPv4-translated ::ffff:0:0:0/96 (RFC 2765)
  if (
    w0 === 0 &&
    w1 === 0 &&
    w2 === 0 &&
    w3 === 0 &&
    ((w4 === 0 && w5 === 0xffff) || (w4 === 0xffff && w5 === 0))
  ) {
    return isDisallowedIpv4(wordsToIpv4(w6, w7));
  }

  // NAT64 Well-Known Prefix 64:ff9b::/96 (RFC 6052) and Local-Use NAT64 64:ff9b:1::/48 (RFC 8215)
  if (w0 === 0x0064 && w1 === 0xff9b && ((w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) || w2 === 1)) {
    return isDisallowedIpv4(wordsToIpv4(w6, w7));
  }

  // Discard-Only Prefix 100::/64 (RFC 6666)
  if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) {
    return true;
  }

  // IETF Protocol Assignments 2001::/23 (includes Teredo 2001:0000::/32, Benchmarking 2001:2::/48, Orchid 2001:10::/28 & 2001:20::/28)
  if (w0 === 0x2001 && w1 < 0x0200) {
    return true;
  }

  // Documentation 2001:db8::/32 (RFC 3849)
  if (w0 === 0x2001 && w1 === 0x0db8) {
    return true;
  }

  // 6to4 2002::/16 (RFC 3056) — embeds IPv4 in w1:w2
  if (w0 === 0x2002) {
    return isDisallowedIpv4(wordsToIpv4(w1, w2));
  }

  // Unique local fc00::/7 (fc00..fdff)
  if ((w0 & 0xfe00) === 0xfc00) {
    return true;
  }

  // Link-local fe80::/10 (fe80..febf) and deprecated Site-local fec0::/10 (fec0..feff)
  if ((w0 & 0xffc0) === 0xfe80 || (w0 & 0xffc0) === 0xfec0) {
    return true;
  }

  // Multicast ff00::/8
  if ((w0 & 0xff00) === 0xff00) {
    return true;
  }

  return false;
}

/**
 * Validates a target URL against SSRF threats.
 * Rejects non-HTTP(S) protocols, metadata hostnames, loopbacks, and RFC 1918 IPs.
 */
export async function validateWebhookUrl(urlString: string): Promise<SsrfCheckResult> {
  if (!urlString || typeof urlString !== "string") {
    return { safe: false, reason: "Empty or invalid URL" };
  }

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { safe: false, reason: "Malformed URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { safe: false, reason: `Disallowed protocol: ${parsed.protocol}` };
  }

  const rawHostname = parsed.hostname.toLowerCase();
  const hostname =
    rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;

  // Explicit cloud metadata and internal hostnames
  if (
    hostname === "metadata.google.internal" ||
    hostname === "metadata" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return { safe: false, reason: `Forbidden cloud metadata or internal hostname: ${hostname}` };
  }

  // If hostname is directly an IP literal
  if (net.isIPv4(hostname)) {
    if (isDisallowedIpv4(hostname)) {
      return { safe: false, reason: `Disallowed private or reserved IPv4: ${hostname}` };
    }
    return { safe: true, resolvedIp: hostname };
  }

  if (net.isIPv6(hostname) || rawHostname.startsWith("[")) {
    if (isDisallowedIpv6(hostname)) {
      return { safe: false, reason: `Disallowed private or reserved IPv6: ${hostname}` };
    }
    return { safe: true, resolvedIp: hostname };
  }

  // Resolve hostname via DNS
  try {
    const resolved = await dns.lookup(hostname, { all: true });
    if (!resolved || resolved.length === 0) {
      return { safe: false, reason: "DNS resolution yielded no IP addresses" };
    }

    for (const record of resolved) {
      if (record.family === 4 && isDisallowedIpv4(record.address)) {
        return {
          safe: false,
          reason: `Resolved to disallowed IPv4: ${record.address}`,
          resolvedIp: record.address,
        };
      }
      if (record.family === 6 && isDisallowedIpv6(record.address)) {
        return {
          safe: false,
          reason: `Resolved to disallowed IPv6: ${record.address}`,
          resolvedIp: record.address,
        };
      }
    }

    return { safe: true, resolvedIp: resolved[0].address };
  } catch (err: unknown) {
    return {
      safe: false,
      reason: `DNS resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
