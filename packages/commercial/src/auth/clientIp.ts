import { isIP } from "node:net";

/**
 * A client address safe to store on refresh_tokens.client_ip.
 * Blank, invalid, and wildcard values are an incomplete fingerprint (null).
 * IPv4-mapped IPv6 is stored as dotted IPv4 so the two spellings compare equal.
 */
export function validClientIp(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!isIP(trimmed)) return null;
  if (trimmed === "0.0.0.0" || trimmed === "::") return null;
  const mapped = /^::ffff:([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$/i.exec(trimmed);
  return mapped?.[1] ?? trimmed;
}
