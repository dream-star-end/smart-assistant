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
      if (f === '0160_moonshot_kimi_k3.sql') {
        assert.ok(literals.length > 0, '0160 的 profile 字面量必须被本契约覆盖')
      }
    })
  }
})
