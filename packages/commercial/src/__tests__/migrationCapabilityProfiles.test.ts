/**
 * 迁移文件里的 model_catalog capability_profile JSONB ↔ parseCapabilityProfile wire 契约。
 *
 * 跑法:npx tsx --test packages/commercial/src/__tests__/migrationCapabilityProfiles.test.ts
 *
 * 背景(2026-07-17 kimi-k3 上线事故):迁移里手写的 profile 用了 camelCase
 * (supportsVision),而 parseCapabilityProfile 只认 snake_case(supports_vision)——
 * 迁移 apply 本身成功(PG 不校验 JSONB 形状),但生产快照重建当场 fail-closed,
 * 全站模型列表 503。org 单测虽然把迁移套用进真 PG,却不加载 catalog 快照,拦不住。
 * 本测试把「每个迁移文件写进 catalog 的 profile 字面量必须能被 parseCapabilityProfile
 * 解析」钉成契约:新增模型迁移写错形状,在这里就红,不用等生产。
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseCapabilityProfile } from '../billing/modelCatalog.js'

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations',
)

/** 提取 SQL 里所有 '{…}'::jsonb 字面量(单引号转义按 SQL 规则还原)。 */
function jsonbLiterals(sql: string): string[] {
  const out: string[] = []
  const re = /'((?:[^']|'')*)'\s*::\s*jsonb/gi
  for (const m of sql.matchAll(re)) {
    out.push(m[1].replaceAll("''", "'"))
  }
  return out
}

/** 去掉 SQL 行注释 `-- …` 与块注释 `/* … *​/`(避免注释里的提及被误计为调用)。 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
}

/**
 * 统计一个迁移里 `fn_model_stage_version(...)` 的**真实调用**次数(SELECT/PERFORM 调用点),
 * 排除:(a) 注释里的提及(如 0160 顶部说明);(b) 函数定义与授权语句
 * `... FUNCTION fn_model_stage_version(...)`(CREATE/REVOKE/GRANT ... ON FUNCTION)。
 */
function countStageVersionCalls(sql: string): number {
  const src = stripSqlComments(sql)
  const total = [...src.matchAll(/\bfn_model_stage_version\s*\(/g)].length
  const defsAndGrants = [...src.matchAll(/FUNCTION\s+fn_model_stage_version\s*\(/gi)].length
  return total - defsAndGrants
}

describe('迁移文件 capability_profile ↔ parseCapabilityProfile 契约', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
  // 只审"直接往 model_catalog 写 profile"的迁移(fn_model_stage_version / INSERT INTO
  // model_catalog 的调用点);其余 jsonb 字面量(别表)不适用本契约。
  const candidates = files.filter((f) => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')
    return /fn_model_stage_version|INSERT INTO model_catalog/i.test(sql)
  })

  test('候选迁移集非空(0160 起适用;找不到=过滤器坏了)', () => {
    assert.ok(candidates.includes('0160_moonshot_kimi_k3.sql'))
  })

  for (const f of candidates) {
    test(`${f}: 每个疑似 profile 的 jsonb 字面量可被 parseCapabilityProfile 解析`, () => {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')
      const literals = jsonbLiterals(sql)
        .map((s) => {
          try {
            return JSON.parse(s) as unknown
          } catch {
            return null
          }
        })
        // profile 判形:对象且带 reasoning + ccb 键(其它 jsonb 字面量不误伤)
        .filter(
          (v): v is Record<string, unknown> =>
            !!v && typeof v === 'object' && !Array.isArray(v) && 'reasoning' in v && 'ccb' in v,
        )
      // 候选过滤器允许误伤(如 0154 只动函数不写 profile)→ 零字面量直接过;
      // "0160 必须至少有一个"由上面的 canary 断言另行钉死。
      for (const lit of literals) {
        // 解析失败(错键名/错类型)会抛 → 测试红
        parseCapabilityProfile(`migration:${f}`, lit)
      }
      // 结构性计数断言(批D D2):每次 fn_model_stage_version 调用都应携带一个能被探测器
      // 看见的 '{…}'::jsonb profile 字面量。若"探测到的 profile 数 < 调用次数",几乎必然
      // 是 profile 用了探测盲区形态(dollar-quote $$…$$::jsonb / jsonb_build_object() /
      // 错键名让 reasoning+ccb 过滤器漏掉)——那会让上面的解析循环**空转、静默放绿**,
      // 正是 2026-07-17 kimi-k3 事故(camelCase 键)想根治的漏网场景。数不齐=红。
      const callCount = countStageVersionCalls(sql)
      if (callCount > 0) {
        assert.ok(
          literals.length >= callCount,
          `${f}: 探测到 ${literals.length} 个 profile 字面量,却有 ${callCount} 次 fn_model_stage_version 调用。` +
            `每次 stage 都应带一个可被 parseCapabilityProfile 解析的 '{…}'::jsonb profile;` +
            `数不齐通常意味着 profile 用了 dollar-quote / jsonb_build_object / 错键名等探测盲区形态,` +
            `会绕过本契约静默放绿。修法:把 profile 写成受探测的 '{…}'::jsonb 单引号字面量。`,
        )
      }
      if (f === '0160_moonshot_kimi_k3.sql') {
        assert.ok(literals.length > 0, '0160 的 profile 字面量必须被本契约覆盖')
        assert.equal(callCount, 1, '0160 应恰有 1 次 fn_model_stage_version 调用(计数器基准锚)')
      }
    })
  }
})
