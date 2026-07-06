/**
 * T-60 — 超管 model_pricing 管理。
 *
 * ### 允许改哪些字段
 * - `multiplier`:NUMERIC(6,3),线上 0.001 ~ 999.999
 * - `enabled`:boolean(模型上/下线)
 * - `extra_system_prompt`(0060)/ `visibility`(0049)/ `display_name`
 * - `default_effort`(0105):per-model 默认思考深度,按 protocol 适用性校验(modelOps.ts)
 * - 四个 `*_per_mtok` 价格列(0105 放开)。原「要动走 migration/seed」的安全初衷改由
 *   四重护栏承接(Codex 方案评审):API 整数分校验(normalizePriceCents,0..1e8)+
 *   DB CHECK >= 0(0105)+ 逐列 before/after 审计 + `if_match_updated_at` 乐观并发
 *   (UI 行内编辑带读取时的 updated_at,中途被他人改过 → PricingStaleError/409,防脏写)。
 *
 * ### NOTIFY pricing_changed
 * 由 0008 的 trigger 自动发出(`AFTER INSERT OR UPDATE OR DELETE`),
 * 本模块**不**再显式 NOTIFY —— 那样会发两次(trigger 一次 + 手动一次),
 * pricing cache 重复 reload 浪费。
 *
 * ### 同事务审计
 * 所有 PATCH 必须原子:UPDATE + INSERT admin_audit。失败任一回滚,避免
 * "倍率改了但审计没记"或反之。
 */

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { query, tx } from "../db/queries.js";
import { writeAdminAudit } from "./audit.js";
import { safeEnqueueAlert } from "./alertOutbox.js";
import { EVENTS } from "./alertEvents.js";
import { EFFORT_ENUM, effortMetaForModel } from "./modelOps.js";

export interface ModelPricingRowView {
  model_id: string;
  display_name: string;
  input_per_mtok: string;
  output_per_mtok: string;
  cache_read_per_mtok: string;
  cache_write_per_mtok: string;
  multiplier: string;
  enabled: boolean;
  sort_order: number;
  updated_at: Date;
  updated_by: string | null;
  // 0049 引入。DB schema 是 NOT NULL DEFAULT 'public',因此非 nullable。
  // 前端 admin.js mg-tab 用这个字段 filter 受限模型,漏 select 会让所有
  // visibility=admin/hidden 的模型(gpt-5.5 / claude-haiku-4-5 / deepseek-*)
  // 在"用户模型授权"页签消失。
  visibility: 'public' | 'admin' | 'hidden';
  /**
   * 0060 引入 — Per-model 行为补丁文案。
   * NULL/空白 → 不注入(provider 端 trim 后判空过滤)。
   * 上限 4096 字符,DB CHECK 约束兜底。
   */
  extra_system_prompt: string | null;
  /** 0105 引入 — per-model 默认思考深度(proxy 注入;NULL=不注入)。 */
  default_effort: string | null;
  /** 0105 引入 — 乐观并发版本号(每次 PATCH 成功 +1;整数精确比较,无时间戳截断坑)。 */
  lock_version: number;
}

const PRICING_COLS = `
  model_id,
  display_name,
  input_per_mtok::text       AS input_per_mtok,
  output_per_mtok::text      AS output_per_mtok,
  cache_read_per_mtok::text  AS cache_read_per_mtok,
  cache_write_per_mtok::text AS cache_write_per_mtok,
  multiplier::text           AS multiplier,
  enabled,
  sort_order,
  updated_at,
  updated_by::text           AS updated_by,
  visibility,
  extra_system_prompt,
  default_effort,
  lock_version
`;

/** extra_system_prompt 长度上限,与 0060 migration 的 CHECK 约束对齐。 */
export const EXTRA_SYSTEM_PROMPT_MAX_LEN = 4096;

/** model_id 白名单:字母数字 + . + - + _,上限 64 字符。 */
const MODEL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export async function listPricing(): Promise<ModelPricingRowView[]> {
  const r = await query<ModelPricingRowView>(
    `SELECT ${PRICING_COLS} FROM model_pricing ORDER BY sort_order DESC, model_id`,
  );
  return r.rows;
}

// ─── PATCH ─────────────────────────────────────────────────────────

export interface PatchPricingInput {
  multiplier?: string | number;
  enabled?: boolean;
  /**
   * 0060 — Per-model extra_system_prompt。
   * - undefined:不改
   * - null 或空白字串:清空(DB 写 NULL)
   * - 非空字串:trim 后存(长度 ≤ EXTRA_SYSTEM_PROMPT_MAX_LEN,否则 RangeError)
   */
  extra_system_prompt?: string | null;
  // ─── 0105 运维页放开字段 ───
  display_name?: string;
  visibility?: string;
  /** null=清除(回落"不注入");string=EFFORT_ENUM 且须过 per-model 适用性校验。 */
  default_effort?: string | null;
  input_per_mtok?: string | number;
  output_per_mtok?: string | number;
  cache_read_per_mtok?: string | number;
  cache_write_per_mtok?: string | number;
  /**
   * 乐观并发:GET 返回的 lock_version 原样回传;不匹配 → PricingStaleError(HTTP 409)。
   * **价格列出现时强制要求本字段**(缺失 → RangeError,四重护栏之一);其他字段可选带。
   * 用整数版本号而非 updated_at 时间戳:timestamptz 微秒被 pg→JS Date 截到毫秒,
   * 同毫秒并发会误判匹配(Codex 审计)。
   */
  if_match_lock_version?: number;
}

const PRICE_FIELDS = [
  "input_per_mtok",
  "output_per_mtok",
  "cache_read_per_mtok",
  "cache_write_per_mtok",
] as const;
type PriceField = (typeof PRICE_FIELDS)[number];

export interface PatchPricingCtx {
  adminId: bigint | number | string;
  ip?: string | null;
  userAgent?: string | null;
}

export class PricingNotFoundError extends Error {
  constructor(modelId: string) { super(`model_pricing not found: ${modelId}`); this.name = "PricingNotFoundError"; }
}

/** 0105 — 乐观并发冲突(if_match_updated_at 与行当前 updated_at 不符)→ HTTP 409。 */
export class PricingStaleError extends Error {
  constructor(modelId: string) {
    super(`model_pricing row changed since read: ${modelId}`);
    this.name = "PricingStaleError";
  }
}

/**
 * 0105 — 价格列(分/Mtok):非负整数,上限 1e8(=¥100 万/Mtok,再高必是手滑)。
 * 字符串只认十进制数字(拒 "1e3"/"0x10" 这类 Number() 可解析的旁门写法,Codex nit)。
 */
export function normalizePriceCents(v: unknown, field: string): string {
  let n: number;
  if (typeof v === "number") {
    n = v;
  } else if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    n = Number(v.trim());
  } else {
    throw new RangeError(`invalid_${field}`);
  }
  if (!Number.isInteger(n) || n < 0 || n > 100_000_000) throw new RangeError(`invalid_${field}`);
  return String(n);
}

const VISIBILITY_ENUM = ["public", "admin", "hidden"] as const;
export function normalizeVisibility(v: unknown): string {
  if (typeof v !== "string" || !(VISIBILITY_ENUM as readonly string[]).includes(v)) {
    throw new RangeError("invalid_visibility");
  }
  return v;
}

export function normalizeDisplayName(v: unknown): string {
  if (typeof v !== "string") throw new RangeError("invalid_display_name");
  const t = v.trim();
  if (t === "" || t.length > 128) throw new RangeError("invalid_display_name");
  return t;
}

/**
 * 0105 — default_effort:null=清除;string 须 ∈ EFFORT_ENUM 且 ∈ 该模型 provider 的
 * 适用档位(protocol 推导,见 modelOps.effortMetaForModel —— capability-zero 静态模型
 * 的 output_config 会被 upstream 整体 strip,配了也无效,这里直接拒,不做静默无效配置)。
 */
export function normalizeDefaultEffort(modelId: string, v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || !(EFFORT_ENUM as readonly string[]).includes(v)) {
    throw new RangeError("invalid_default_effort");
  }
  const meta = effortMetaForModel(modelId);
  if (!meta.applicable) throw new RangeError("effort_not_applicable_for_model");
  if (!meta.allowed.includes(v)) throw new RangeError("effort_not_allowed_for_provider");
  return v;
}

/**
 * 把 multiplier 输入规整为 NUMERIC(6,3) 可接受的字符串:
 *   - 允许 number 或字符串
 *   - 范围 [0.001, 999.999](含);小于 0.001 积分几乎不扣,大于 999.999 整数位溢出
 *   - 最多 3 位小数
 *
 * 返回清洁字符串,失败抛 RangeError("invalid_multiplier")。
 */
export function normalizeMultiplier(v: unknown): string {
  let s: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RangeError("invalid_multiplier");
    // 用 toFixed(3) 再 trim 多余 0,避免 JS 浮点抽风("2.1" → 2.1 → "2.100")
    s = v.toFixed(3);
  } else if (typeof v === "string") {
    s = v.trim();
  } else {
    throw new RangeError("invalid_multiplier");
  }
  if (!/^(\d{1,3})(\.\d{1,3})?$/.test(s)) throw new RangeError("invalid_multiplier");
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0.001 || n > 999.999) throw new RangeError("invalid_multiplier");
  return s;
}

/**
 * 0060 — 把 extra_system_prompt 输入归一化:
 *   - null / "" / 纯空白 → null(DB 写 NULL,等同清空)
 *   - 非空字串 → trim 后存(头尾空白对模型行为无意义,避免幽灵差异)
 *   - 非 string 非 null → RangeError("invalid_extra_system_prompt")
 *   - trim 后长度 > EXTRA_SYSTEM_PROMPT_MAX_LEN → RangeError("extra_system_prompt_too_long")
 *
 * DB CHECK 约束(0060)是兜底,这里先于 SQL 给出明确错误码,前端 UX 更准。
 */
export function normalizeExtraSystemPrompt(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string") throw new RangeError("invalid_extra_system_prompt");
  const trimmed = v.trim();
  if (trimmed === "") return null;
  if (trimmed.length > EXTRA_SYSTEM_PROMPT_MAX_LEN) {
    throw new RangeError("extra_system_prompt_too_long");
  }
  return trimmed;
}

/**
 * 审计摘要 — 不落明文。返回 { len, sha256, preview }(null 时返 null)。
 * preview 取前 40 个 code unit(.slice(0,40))再加 "…",肉眼对照足够。
 */
export function summarizeExtraPrompt(v: string | null): null | { len: number; sha256: string; preview: string } {
  if (v === null) return null;
  const sha256 = createHash("sha256").update(v, "utf8").digest("hex");
  const preview = v.length > 40 ? `${v.slice(0, 40)}…` : v;
  return { len: v.length, sha256, preview };
}

/**
 * 修改单个模型的 multiplier / enabled。同事务写 admin_audit。
 * 空 patch → 直接返当前行(不写 audit)。
 */
export async function patchPricing(
  modelId: string,
  patch: PatchPricingInput,
  ctx: PatchPricingCtx,
): Promise<ModelPricingRowView> {
  if (!MODEL_ID_RE.test(modelId)) throw new RangeError("invalid_model_id");

  const touched =
    patch.multiplier !== undefined ||
    patch.enabled !== undefined ||
    patch.extra_system_prompt !== undefined ||
    patch.display_name !== undefined ||
    patch.visibility !== undefined ||
    patch.default_effort !== undefined ||
    PRICE_FIELDS.some((f) => patch[f] !== undefined);
  if (!touched) {
    const cur = await query<ModelPricingRowView>(
      `SELECT ${PRICING_COLS} FROM model_pricing WHERE model_id = $1`, [modelId],
    );
    if (cur.rows.length === 0) throw new PricingNotFoundError(modelId);
    return cur.rows[0];
  }

  let multiplierNorm: string | null = null;
  if (patch.multiplier !== undefined) {
    multiplierNorm = normalizeMultiplier(patch.multiplier);
  }

  // extra_system_prompt 归一化:undefined→不改;null/空白→DB NULL;非空→trim 后存。
  // 用 sentinel symbol 区分 "未提供" 与 "显式清空(null)" 两态。
  const EXTRA_UNSET = Symbol("extra_unset");
  let extraNorm: string | null | typeof EXTRA_UNSET = EXTRA_UNSET;
  if (patch.extra_system_prompt !== undefined) {
    extraNorm = normalizeExtraSystemPrompt(patch.extra_system_prompt);
  }

  // 0105 — 运维页放开字段归一化(全部先于事务,校验失败零 DB 交互)。
  const displayNameNorm =
    patch.display_name !== undefined ? normalizeDisplayName(patch.display_name) : undefined;
  const visibilityNorm =
    patch.visibility !== undefined ? normalizeVisibility(patch.visibility) : undefined;
  const EFFORT_UNSET = Symbol("effort_unset");
  let effortNorm: string | null | typeof EFFORT_UNSET = EFFORT_UNSET;
  if (patch.default_effort !== undefined) {
    effortNorm = normalizeDefaultEffort(modelId, patch.default_effort);
  }
  const priceNorm: Partial<Record<PriceField, string>> = {};
  for (const f of PRICE_FIELDS) {
    if (patch[f] !== undefined) priceNorm[f] = normalizePriceCents(patch[f], f);
  }

  // 0105 — 价格列**强制**乐观并发(Codex 审计:可选=可绕过=不算护栏)。同步抛,零 DB 交互。
  if (Object.keys(priceNorm).length > 0 && patch.if_match_lock_version === undefined) {
    throw new RangeError("if_match_required_for_price_changes");
  }
  if (
    patch.if_match_lock_version !== undefined &&
    (!Number.isInteger(patch.if_match_lock_version) || patch.if_match_lock_version < 0)
  ) {
    throw new RangeError("invalid_if_match_lock_version");
  }

  return tx(async (client: PoolClient) => {
    const before = await client.query<ModelPricingRowView>(
      `SELECT ${PRICING_COLS} FROM model_pricing WHERE model_id = $1 FOR UPDATE`,
      [modelId],
    );
    if (before.rows.length === 0) throw new PricingNotFoundError(modelId);

    // 0105 — 乐观并发:UI 带上读取时的 lock_version,中途被他人改过 → 409 防脏写(价格列
    // 即改即生效,脏写=直接改错线上计费,必须 fail-closed;整数比较无时间戳截断坑)。
    if (
      patch.if_match_lock_version !== undefined &&
      before.rows[0].lock_version !== patch.if_match_lock_version
    ) {
      throw new PricingStaleError(modelId);
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown): void => {
      params.push(val); sets.push(`${col} = $${params.length}`);
    };
    if (multiplierNorm !== null) push("multiplier", multiplierNorm);
    if (patch.enabled !== undefined) push("enabled", patch.enabled);
    if (extraNorm !== EXTRA_UNSET) push("extra_system_prompt", extraNorm);
    if (displayNameNorm !== undefined) push("display_name", displayNameNorm);
    if (visibilityNorm !== undefined) push("visibility", visibilityNorm);
    if (effortNorm !== EFFORT_UNSET) push("default_effort", effortNorm);
    for (const f of PRICE_FIELDS) {
      if (priceNorm[f] !== undefined) push(f, priceNorm[f]);
    }
    sets.push("lock_version = lock_version + 1");
    sets.push("updated_at = NOW()");
    params.push(String(ctx.adminId));
    sets.push(`updated_by = $${params.length}::bigint`);

    params.push(modelId);
    const after = await client.query<ModelPricingRowView>(
      `UPDATE model_pricing SET ${sets.join(", ")} WHERE model_id = $${params.length}
       RETURNING ${PRICING_COLS}`,
      params,
    );

    const b = before.rows[0], a = after.rows[0];
    const changedBefore: Record<string, unknown> = {};
    const changedAfter: Record<string, unknown> = {};
    if (multiplierNorm !== null) { changedBefore.multiplier = b.multiplier; changedAfter.multiplier = a.multiplier; }
    if (patch.enabled !== undefined) { changedBefore.enabled = b.enabled; changedAfter.enabled = a.enabled; }
    // 审计 extra_system_prompt:**不**写明文(可能含敏感措辞或被人当 leak 渠道),
    // 而是 {len, sha256, preview} 三件:len 看尺寸变化,sha256 防篡改对照,preview 看头 40 字符
    // 让 admin 一眼分辨"是不是我刚刚改的那条"。
    if (extraNorm !== EXTRA_UNSET) {
      changedBefore.extra_system_prompt = summarizeExtraPrompt(b.extra_system_prompt);
      changedAfter.extra_system_prompt = summarizeExtraPrompt(a.extra_system_prompt);
    }
    // 0105 — 新放开字段逐列 before/after(价格列审计是放开编辑的护栏之一,不许省)。
    if (displayNameNorm !== undefined) { changedBefore.display_name = b.display_name; changedAfter.display_name = a.display_name; }
    if (visibilityNorm !== undefined) { changedBefore.visibility = b.visibility; changedAfter.visibility = a.visibility; }
    if (effortNorm !== EFFORT_UNSET) { changedBefore.default_effort = b.default_effort; changedAfter.default_effort = a.default_effort; }
    for (const f of PRICE_FIELDS) {
      if (priceNorm[f] !== undefined) { changedBefore[f] = b[f]; changedAfter[f] = a[f]; }
    }

    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "pricing.patch",
      target: `model:${modelId}`,
      before: changedBefore,
      after: changedAfter,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    // T-63 告警:模型定价改动 —— warning,dedupe 按 (model, 分钟桶) 防 admin 连点。
    safeEnqueueAlert({
      event_type: EVENTS.SYSTEM_PRICING_CHANGED,
      severity: "warning",
      title: "模型定价改动",
      body: `admin #${ctx.adminId} 修改了 \`${modelId}\` 的定价 —— before=${JSON.stringify(changedBefore)} → after=${JSON.stringify(changedAfter)}`,
      payload: {
        model_id: modelId,
        before: changedBefore,
        after: changedAfter,
        admin_id: String(ctx.adminId),
      },
      dedupe_key: `system.pricing_changed:${modelId}:${new Date().toISOString().slice(0, 16)}`,
    });

    return a;
  });
}
