/**
 * 账单流水行的用户可读上下文(#1237):对话扣费行的模型展示名 + 所属会话标题。
 *
 * credit_ledger.memo 是写侧内部串(`cost=<n>`),不能直接给用户看。usage_record 引用的行
 * 在这里补两项只读信息:
 *   - model_name:model_pricing.display_name,缺失时回落 usage_records.model 原 id;
 *   - session_title:client_sessions.title。会话键优先 turn_dispatches.session_id(codex 等
 *     引擎的 usage_records.session_id 是引擎会话 oceng-*,不是客户端会话),其次 delegate 的
 *     parent_session_id,最后是 web* 形态的 session_id 本身。
 * 会话只认本人(usageSessionOwnerCandidates)且未删除;其余情况给 null,前端只显示模型名。
 */

import { usageSessionOwnerCandidates } from "./boardProjectAttribution.js";

export type LedgerRowRef = { id: string; ref_type: string | null; ref_id: string | null };

export type LedgerRowContext = { model_name: string | null; session_title: string | null };

export type LedgerContextQuery = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: Array<{ usage_id: string; model_name: string | null; session_title: string | null }> }>;

const USAGE_REF_RE = /^[1-9][0-9]{0,18}$/;

/** 返回 ledger id → 上下文;非 usage_record 行或查不到的行不在 Map 里。 */
export async function loadLedgerRowContext(
  queryFn: LedgerContextQuery,
  uid: string,
  rows: readonly LedgerRowRef[],
): Promise<Map<string, LedgerRowContext>> {
  const ledgerByUsage = new Map<string, string[]>();
  for (const r of rows) {
    if (r.ref_type !== "usage_record" || !r.ref_id || !USAGE_REF_RE.test(r.ref_id)) continue;
    const list = ledgerByUsage.get(r.ref_id) ?? [];
    list.push(r.id);
    ledgerByUsage.set(r.ref_id, list);
  }
  const out = new Map<string, LedgerRowContext>();
  if (ledgerByUsage.size === 0) return out;
  const res = await queryFn(
    `SELECT ur.id::text AS usage_id,
            COALESCE(NULLIF(mp.display_name, ''), ur.model) AS model_name,
            cs.title AS session_title
       FROM usage_records ur
       LEFT JOIN model_pricing mp ON mp.model_id = ur.model
       LEFT JOIN turn_dispatches td ON td.dispatch_id = ur.dispatch_id AND td.user_id = ur.user_id
       LEFT JOIN client_sessions cs
         ON cs.id = COALESCE(
              td.session_id,
              CASE WHEN ur.mode = 'delegate' THEN ur.parent_session_id END,
              CASE WHEN ur.session_id ~ '^web' THEN ur.session_id END
            )
        AND cs.user_id = ANY($3::text[])
        AND cs.deleted_at IS NULL
      WHERE ur.user_id = $1 AND ur.id = ANY($2::bigint[])`,
    [uid, [...ledgerByUsage.keys()], usageSessionOwnerCandidates(uid)],
  );
  for (const row of res.rows) {
    const title = row.session_title?.trim() || null;
    for (const ledgerId of ledgerByUsage.get(row.usage_id) ?? []) {
      out.set(ledgerId, { model_name: row.model_name ?? null, session_title: title });
    }
  }
  return out;
}
