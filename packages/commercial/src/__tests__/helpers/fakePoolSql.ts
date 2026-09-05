/**
 * Observability / side-effect SQL that anthropic proxy tests do not assert.
 * Return a no-op result so fakePool stays fail-closed on unknown product SQL.
 *
 * After 0253-era schema growth, nightly-1 proxy tests started 500-ing or
 * hanging because these INSERTs/SELECTs were not on the allowlist.
 */
export function matchObservabilitySql(
  sql: string,
): { rows: unknown[]; rowCount: number } | null {
  const trimmed = sql.trim();
  const head = trimmed.slice(0, 96).toUpperCase();
  const compact = trimmed.replace(/\s+/g, " ").toUpperCase();

  if (head.startsWith("INSERT INTO ACCOUNT_REFRESH_EVENTS")) {
    return { rows: [], rowCount: 1 };
  }
  if (head.startsWith("INSERT INTO INBOX_MESSAGES")) {
    return { rows: [], rowCount: 1 };
  }
  if (head.startsWith("INSERT INTO SELFHEAL_USER_IMPACT_EVIDENCE")) {
    return { rows: [], rowCount: 1 };
  }
  if (head.startsWith("INSERT INTO TURN_UPSTREAM_PERFORMANCE")) {
    return { rows: [], rowCount: 1 };
  }
  if (head.startsWith("SELECT COALESCE(PO.PROVIDER_ID")) {
    return { rows: [], rowCount: 0 };
  }
  if (head.startsWith("SELECT CS.USER_ID AS USER_ID")) {
    return { rows: [], rowCount: 0 };
  }
  if (head.startsWith("SELECT 1 FROM TURN_WAIVERS")) {
    return { rows: [], rowCount: 0 };
  }
  if (compact.startsWith("SELECT ID::TEXT AS ID, ADMIN_ID::TEXT AS ADMIN_ID")) {
    return { rows: [], rowCount: 0 };
  }
  return null;
}
