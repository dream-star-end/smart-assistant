/**
 * V3 Phase 2 Task 2G — 用户偏好(`user_preferences` 表)读写。
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §2.5 / §5.1,03-MVP-CHECKLIST.md Task 2G。
 *
 * 设计:
 *   - 整张表为 `user_id PK + prefs JSONB + updated_at`,默认行不存在 → 视为 `{}`。
 *   - GET 路径:select * → 找不到也返默认空对象,避免前端二状态分支。
 *   - PATCH 路径:zod strict 白名单校验 patch(只接受已知字段);未知字段 400。
 *     合法 patch 与现有 prefs 做"浅 merge"(JSONB `||`),前端可一次只发改动字段。
 *     `null` 字段 = 删除该 key(JSONB `- 'key'`)。
 *   - 返回值:始终返完整快照 + updated_at,前端用作 etag/optimistic refresh。
 *
 * 字段 allowlist(MVP,按 migration 0011 注释):
 *   theme           : 'light' | 'dark' | 'auto'
 *   default_model   : string (1..64 chars;不强校 model_id 是否在 model_pricing)
 *   default_effort  : 'low' | 'medium' | 'high' | 'xhigh'
 *   notify_email    : boolean
 *   notify_telegram : boolean
 *   hotkeys         : Record<string, string>(最多 32 条,key/value <= 64 chars)
 *
 * 不做的:
 *   - 不做 etag / If-Match 乐观锁(MVP 只返当前快照,前端"最后写入赢"够用)
 *   - 不做合并冲突保护(冲突几率 ≈ 同一用户两个 tab 同时改;最坏后果 = 后写覆盖前写)
 */

import { z } from "zod";
import { query } from "../db/queries.js";

// ─── zod schema ───────────────────────────────────────────────────────────

const themeSchema = z.enum(["light", "dark", "auto"]);
const effortSchema = z.enum(["low", "medium", "high", "xhigh"]);
const modelSchema = z.string().min(1).max(64);
const hotkeysSchema = z
  .record(z.string().min(1).max(64), z.string().min(1).max(64))
  .refine((o) => Object.keys(o).length <= 32, {
    message: "too many hotkeys (max 32)",
  });

/**
 * 全字段 schema(GET 返回 / 内部表示)。所有字段都是可选 — DB 默认行不存在时为空对象。
 */
export const PreferencesSchema = z
  .object({
    theme: themeSchema.optional(),
    default_model: modelSchema.optional(),
    default_effort: effortSchema.optional(),
    notify_email: z.boolean().optional(),
    notify_telegram: z.boolean().optional(),
    hotkeys: hotkeysSchema.optional(),
  })
  .strict();
export type Preferences = z.infer<typeof PreferencesSchema>;

/**
 * PATCH 输入:每字段都是 optional,且接受 `null` 表示"删除该 key"。
 * `strict()` 拒绝未知字段(整个请求 400),避免静默存垃圾。
 */
export const PreferencesPatchSchema = z
  .object({
    theme: themeSchema.nullable().optional(),
    default_model: modelSchema.nullable().optional(),
    default_effort: effortSchema.nullable().optional(),
    notify_email: z.boolean().nullable().optional(),
    notify_telegram: z.boolean().nullable().optional(),
    hotkeys: hotkeysSchema.nullable().optional(),
  })
  .strict();
export type PreferencesPatch = z.infer<typeof PreferencesPatchSchema>;

export interface PreferencesSnapshot {
  prefs: Preferences;
  updated_at: string; // ISO-8601
}

// ─── DB ops ───────────────────────────────────────────────────────────────

/**
 * 读 user_preferences 行;不存在 → 返回 `{ prefs: {}, updated_at: <now> }`。
 *
 * 不会 INSERT 默认行(避免每次 GET 写一次 DB),只在 PATCH 时 upsert。
 */
export async function getPreferences(userId: bigint | string): Promise<PreferencesSnapshot> {
  const r = await query<{ prefs: unknown; updated_at: Date }>(
    `SELECT prefs, updated_at FROM user_preferences WHERE user_id = $1`,
    [String(userId)],
  );
  if (r.rows.length === 0) {
    return { prefs: {}, updated_at: new Date().toISOString() };
  }
  const row = r.rows[0];
  // DB 里存的可能被外部直接 UPDATE 过 → 仍跑一次 schema 兜底,过滤掉非法字段。
  const parsed = PreferencesSchema.safeParse(row.prefs);
  return {
    prefs: parsed.success ? parsed.data : {},
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * Patch 偏好。失败抛 `PreferencesError`('VALIDATION' / 'INTERNAL')。
 *
 * 实现:用 SQL 把"删除字段"和"赋值字段"分开:
 *   - null 字段 → JSONB `- 'key'` 一次次叠
 *   - 非 null 字段 → 整体 build 成一个 JSONB 对象后 `||` 浅 merge
 * 单条 INSERT ... ON CONFLICT DO UPDATE,原子。
 */
export async function patchPreferences(
  userId: bigint | string,
  rawPatch: unknown,
): Promise<PreferencesSnapshot> {
  const parsed = PreferencesPatchSchema.safeParse(rawPatch);
  if (!parsed.success) {
    throw new PreferencesError(
      "VALIDATION",
      parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; "),
    );
  }
  const patch = parsed.data;

  // 拆 set / unset
  const setPart: Record<string, unknown> = {};
  const unsetKeys: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) unsetKeys.push(k);
    else if (v !== undefined) setPart[k] = v;
  }

  if (Object.keys(setPart).length === 0 && unsetKeys.length === 0) {
    // 空 patch:保持幂等返回当前快照(不写 DB,不动 updated_at)
    return await getPreferences(userId);
  }

  // 构造 SQL 表达式:从 COALESCE(prefs, '{}') 起,先按顺序 - 'key',再 || setJsonb
  // 用 parameter 占位避免 SQL 注入(虽然 key 已被 zod 限制成 enum-ish,但仍按数据通道传)。
  let exprParamIdx = 2; // $1 = user_id,$2 = setJsonb,$3+ = unset keys
  const expr = ["COALESCE(user_preferences.prefs, '{}'::jsonb)"];
  // 单条 INSERT 时 EXCLUDED.prefs 拿不到旧值,所以走 ON CONFLICT DO UPDATE 时改用列名引用
  const params: unknown[] = [String(userId)];

  // setJsonb 总是一个 JSONB 对象(可能是空的,但 || '{}'::jsonb 是 noop)
  exprParamIdx = 2;
  params.push(JSON.stringify(setPart));
  // 注意:JSONB 的 - 'k' 操作符按顺序应用
  let unsetExpr = "";
  for (const k of unsetKeys) {
    exprParamIdx += 1;
    params.push(k);
    unsetExpr += ` - $${exprParamIdx}`;
  }
  // 最终表达式:(COALESCE(prefs, '{}') - 'k1' - 'k2') || $2::jsonb
  const newPrefsExpr = `(COALESCE(user_preferences.prefs, '{}'::jsonb)${unsetExpr}) || $2::jsonb`;
  // INSERT 路径:不存在的旧行,COALESCE 落到 '{}',语义同上
  const insertNewExpr = `('{}'::jsonb${unsetExpr}) || $2::jsonb`;

  let r;
  try {
    r = await query<{ prefs: unknown; updated_at: Date }>(
      `INSERT INTO user_preferences (user_id, prefs, updated_at)
       VALUES ($1, ${insertNewExpr}, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET prefs = ${newPrefsExpr},
             updated_at = NOW()
       RETURNING prefs, updated_at`,
      params,
    );
  } catch (err) {
    if (err instanceof Error && /violates foreign key/i.test(err.message)) {
      throw new PreferencesError("VALIDATION", "user does not exist");
    }
    throw new PreferencesError(
      "INTERNAL",
      err instanceof Error ? err.message : "unknown db error",
    );
  }
  void exprParamIdx; // 仅供构造时计数

  const row = r.rows[0];
  const verified = PreferencesSchema.safeParse(row.prefs);
  return {
    prefs: verified.success ? verified.data : {},
    updated_at: row.updated_at.toISOString(),
  };
}

/** 偏好操作错误。`code` 决定 HTTP status:VALIDATION → 400,INTERNAL → 500。 */
export class PreferencesError extends Error {
  constructor(
    readonly code: "VALIDATION" | "INTERNAL",
    message: string,
  ) {
    super(message);
    this.name = "PreferencesError";
  }
}
