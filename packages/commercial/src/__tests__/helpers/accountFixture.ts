import { randomBytes } from "node:crypto";
import { encrypt } from "../../crypto/aead.js";
import { query } from "../../db/queries.js";

/**
 * Insert a dedicated egress_proxies row for one test Claude account.
 *
 * Migration 0253 (`idx_claude_accounts_egress_proxy_uniq`) enforces at most
 * one active Claude account per `egress_proxy_id`. Account integ fixtures
 * used to share a single proxy inserted in `before()`; after 0253 that
 * INSERT collides. Allocate a unique proxy per account instead of NULL
 * (0055 still requires claude/codex/grok `egress_proxy_id` NOT NULL).
 */
export async function insertTestEgressProxy(
  key: Buffer,
  labelPrefix = "t-proxy",
): Promise<string> {
  const ep = encrypt("http://test:test@10.0.0.1:8080", key);
  const label = `${labelPrefix}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const r = await query<{ id: string }>(
    "INSERT INTO egress_proxies(label, url_enc, url_nonce, status) VALUES ($1, $2, $3, 'active') RETURNING id::text AS id",
    [label, ep.ciphertext, ep.nonce],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error("insertTestEgressProxy: INSERT returned no id");
  return id;
}
