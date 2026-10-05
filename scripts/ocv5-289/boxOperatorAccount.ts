/** Explicit operator account fence shared by the Box probes. There is no
 * default: the operator names the exact account in OCV5_289_ACK_ACCOUNT_ID, so
 * a probe never lands on a Box identity nobody acknowledged. */
export interface BoxOperatorAccount { readonly id: bigint; readonly text: string }

export function parseBoxOperatorAccount(raw: string | undefined): BoxOperatorAccount | null {
  // Canonical positive decimal only: "020", "+20", " 20" or "0" must not alias
  // another account's evidence or pass an exact-id comparison by accident.
  // Same shape as the prelaunch identity's accountId.
  if (raw === undefined || !/^[1-9][0-9]{0,18}$/.test(raw)) return null;
  return { id: BigInt(raw), text: raw };
}

/** Throws the caller's existing fixed ACK code; never echoes the raw value. */
export function requireBoxOperatorAccount(code: string,
  env: NodeJS.ProcessEnv = process.env): BoxOperatorAccount {
  const account = parseBoxOperatorAccount(env.OCV5_289_ACK_ACCOUNT_ID);
  if (!account) throw new Error(code);
  return account;
}
