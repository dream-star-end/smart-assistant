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

/** The uid may use the owner's Cursor accounts from its container. Exactly the rule that mounts the
 * root-only credential pool into a container (resolveV5CursorAuthMount): OC_V5_CURSOR_CREDENTIAL_UIDS
 * when set, else the owner uid. The interactive Box route asks the master for a Box exec target under
 * the same entitlement instead of reading that pool. */
export function isCursorCredentialEntitled(uid: number | string | bigint, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OC_V5_CURSOR_CREDENTIAL_UIDS?.trim() ? env.OC_V5_CURSOR_CREDENTIAL_UIDS : env.OC_V5_CURSOR_OWNER_UID;
  return isCursorCredentialMember(uid, raw);
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
