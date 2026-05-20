/**
 * V3 envv2 Phase 2(2026-05-21)— admin 层 envelope_prefix_templates 管理。
 *
 * ### 端点设计
 *   GET /api/admin/envelope-prefix-templates              列出三行 active(无分页)
 *   PUT /api/admin/envelope-prefix-templates/:variant     in-place 替换 text
 *
 * **不**提供 active 切换 / 历史回滚 PATCH —— YAGNI,等真出现需要再加(plan §Phase 2)。
 * 当前 PR 只把硬编码迁到 DB,可改字面。
 *
 * ### 字段
 *   variant         CHECK 三选一(0071 SQL 约束)
 *   text            长度上限 4096 字符(本层 RangeError 早返,**没**写进 DB CHECK ——
 *                   anti-abuse prefix 增长场景罕见,真要超就说明出问题了;长度限制纯
 *                   防 admin 手滑粘整篇 sysprompt 进来)。
 *   active          PR 不支持切;UPDATE 永远不动这列。
 *   updated_at      由 admin store 同事务写当前 NOW()。
 *   updated_by      admin id;NULL 仅 bootstrap seed。
 *
 * ### 同事务审计
 * 所有 PUT 必须原子:UPDATE + INSERT admin_audit(同 pricing patch 抽象)。
 * audit 不存明文 text(可能含 anti-abuse 锚点,leak 出去等于把反风控钩子白送对手) —— 走
 * len/sha256/preview 摘要,与 pricing.extra_system_prompt 同型。
 *
 * ### NOTIFY envelope_prefix_templates_changed
 * 由 0071 trigger AFTER STATEMENT 自动发,本层不重复 NOTIFY。
 * Admin handler PUT 完后还会 await reloadPrefixTemplateCache() 做 read-your-write(异
 * 步 NOTIFY 窗口本进程内不依赖)。
 */

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { query, tx } from "../db/queries.js";
import { writeAdminAudit } from "./audit.js";
import type { PrefixVariant } from "../envelope/prefixTemplateCache.js";
import { PREFIX_VARIANTS } from "../envelope/prefixTemplateCache.js";

/** text 字段上限 — 本层 RangeError 早返,不在 DB CHECK 写约束(详见文件头注释)。 */
export const PREFIX_TEMPLATE_TEXT_MAX_LEN = 4096;

export interface EnvelopePrefixTemplateRowView {
  variant: PrefixVariant;
  text: string;
  active: boolean;
  updated_at: Date;
  updated_by: string | null;
}

const COLS = `
  variant,
  text,
  active,
  updated_at,
  updated_by::text AS updated_by
`;

/** ORDER 按 PREFIX_VARIANTS 数组顺序对齐:default / agent_sdk_claude_code_preset / agent_sdk。 */
export async function listEnvelopePrefixTemplates(): Promise<EnvelopePrefixTemplateRowView[]> {
  const r = await query<EnvelopePrefixTemplateRowView>(
    `SELECT ${COLS}
       FROM envelope_prefix_templates
      WHERE active = TRUE
      ORDER BY CASE variant
                 WHEN 'default' THEN 0
                 WHEN 'agent_sdk_claude_code_preset' THEN 1
                 WHEN 'agent_sdk' THEN 2
                 ELSE 3
               END`,
  );
  return r.rows;
}

export class PrefixTemplateNotFoundError extends Error {
  constructor(variant: string) {
    super(`envelope_prefix_template not found or inactive: ${variant}`);
    this.name = "PrefixTemplateNotFoundError";
  }
}

export interface PutPrefixTemplateCtx {
  adminId: bigint | number | string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * variant 是否合法 — 来自 URL slug,不能信。
 * 复用 PREFIX_VARIANTS 数组,新增 variant 一处改全处对齐。
 */
export function isPrefixVariant(s: string): s is PrefixVariant {
  return (PREFIX_VARIANTS as readonly string[]).includes(s);
}

/**
 * 归一化 text:
 *   - 非 string → RangeError("invalid_text")
 *   - 空白/全空格 → RangeError("invalid_text")(prefix 不允许空,空了 startsWith 永远命中
 *     所有 body,逻辑错乱)
 *   - 长度 > PREFIX_TEMPLATE_TEXT_MAX_LEN → RangeError("text_too_long")
 *
 * 注意:**不** trim — anti-abuse prefix 字面字节级敏感,头尾空格也是字节构成,
 * 与 externalEnvelope.ts:detectCcPrefix.startsWith 行为对齐。如果 admin 真粘进来
 * 头尾空格那是 admin 的输入责任。
 */
export function normalizePrefixText(v: unknown): string {
  if (typeof v !== "string") throw new RangeError("invalid_text");
  if (v.length === 0) throw new RangeError("invalid_text");
  // 全空白也算无效(否则 startsWith("   ") 等价 substring 任意字符串都命中)
  if (/^\s*$/.test(v)) throw new RangeError("invalid_text");
  if (v.length > PREFIX_TEMPLATE_TEXT_MAX_LEN) throw new RangeError("text_too_long");
  return v;
}

/** audit 摘要(同 pricing.extra_system_prompt)— 不落明文。 */
function summarizeText(v: string): { len: number; sha256: string; preview: string } {
  const sha256 = createHash("sha256").update(v, "utf8").digest("hex");
  const preview = v.length > 40 ? `${v.slice(0, 40)}…` : v;
  return { len: v.length, sha256, preview };
}

/**
 * In-place 更新 active 行的 text。同事务写 admin_audit。
 * 不动 active 列(PR 不支持切换);找不到 active 行抛 PrefixTemplateNotFoundError。
 */
export async function updateEnvelopePrefixTemplate(
  variant: PrefixVariant,
  text: string,
  ctx: PutPrefixTemplateCtx,
): Promise<EnvelopePrefixTemplateRowView> {
  // text 已由 handler 层 normalize 过,这里不再二次校验,保持职责分明
  return tx(async (client: PoolClient) => {
    const before = await client.query<EnvelopePrefixTemplateRowView>(
      `SELECT ${COLS}
         FROM envelope_prefix_templates
        WHERE variant = $1 AND active = TRUE
        FOR UPDATE`,
      [variant],
    );
    if (before.rows.length === 0) throw new PrefixTemplateNotFoundError(variant);

    const after = await client.query<EnvelopePrefixTemplateRowView>(
      `UPDATE envelope_prefix_templates
          SET text = $1,
              updated_at = NOW(),
              updated_by = $2::bigint
        WHERE variant = $3 AND active = TRUE
        RETURNING ${COLS}`,
      [text, String(ctx.adminId), variant],
    );

    const b = before.rows[0];
    const a = after.rows[0];
    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "envelope_prefix.put",
      target: `variant:${variant}`,
      before: { text: summarizeText(b.text) },
      after: { text: summarizeText(a.text) },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    return a;
  });
}
