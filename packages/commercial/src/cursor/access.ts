/**
 * Cursor credential entitlement is deliberately separate from model grants.
 * A DB visibility grant alone must never cause the shared root-only key to be
 * mounted. Expanding this set is an explicit operator action.
 *
 * `*` or `all` (exact token) opens every syntactically valid uid. Empty or
 * malformed configuration still fails closed as a whole.
 */
export type CursorCredentialPolicy = ReadonlySet<number> | "all";

export function parseCursorCredentialUids(raw: string | undefined): CursorCredentialPolicy {
  const value = raw?.trim() ?? "";
  if (value === "*" || value === "all") return "all";
  if (!value) return new Set<number>();

  const members = new Set<number>();
  for (const token of value.split(",")) {
    if (!/^[1-9][0-9]*$/.test(token)) return new Set<number>();
    const uid = Number(token);
    if (!Number.isSafeInteger(uid)) return new Set<number>();
    members.add(uid);
  }
  return members;
}

export function isCursorCredentialMember(
  uid: number | string | bigint,
  raw = process.env.OC_V5_CURSOR_CREDENTIAL_UIDS,
): boolean {
  const text = String(uid);
  if (!/^[1-9][0-9]*$/.test(text)) return false;
  const normalized = Number(text);
  if (!Number.isSafeInteger(normalized)) return false;
  const policy = parseCursorCredentialUids(raw);
  if (policy === "all") return true;
  return policy.has(normalized);
}
