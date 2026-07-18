/**
 * 迁移文件里 model_pricing 写入 ↔ model_catalog 先行 的顺序契约。
 *
 * 跑法:npx tsx --test packages/commercial/src/__tests__/migrationPricingCatalogOrder.test.ts
 *
 * 背景(2026-07-18 门禁审计批E;认知锚见 playbook §5 债表 0160 行):
 * 0143 的 fn_model_catalog_ensure_for_pricing 兼容路径只认 protocol 派生函数——
 * pricing 行先落而 catalog 行不存在时,不认识的新 model id 会被兜底成
 * provider='anthropic'/context 200k 的**错行**(kimi-k3 上线时靠人工纪律避开)。
 * 「catalog 行必须先于 pricing 行」此前只是 playbook 文字纪律,本测试把它钉成契约:
 * catalog 时代(>0144)的迁移里,任何 INSERT INTO model_pricing 的 model id,必须
 * 在**同文件更早位置**或**更早编号的迁移**里有 fn_model_stage_version('<id>' 调用。
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations',
)

/** 去掉 SQL 行注释与块注释(避免注释里的示例被误判为真实调用)。 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
}

function migrationNumber(file: string): number {
  const m = file.match(/^(\d+)_/)
  return m ? Number(m[1]) : Number.NaN
}

/** 该文件里 fn_model_stage_version('<id>' 的全部 (id, offset)。 */
function stageVersionCalls(sql: string): Array<{ id: string; offset: number }> {
  const out: Array<{ id: string; offset: number }> = []
  for (const m of sql.matchAll(/fn_model_stage_version\s*\(\s*'([^']+)'/gi)) {
    out.push({ id: m[1], offset: m.index ?? 0 })
  }
  return out
}

/** 该文件里 INSERT INTO model_pricing 的 (model_id, offset)。model_id 是首列(0144/0160 先例)。 */
function pricingInserts(sql: string): Array<{ id: string; offset: number }> {
  const out: Array<{ id: string; offset: number }> = []
  for (const m of sql.matchAll(/INSERT\s+INTO\s+model_pricing[\s\S]{0,400}?VALUES\s*\(\s*'([^']+)'/gi)) {
    out.push({ id: m[1], offset: m.index ?? 0 })
  }
  return out
}

describe('迁移 model_pricing ↔ model_catalog 先后顺序契约(>0144)', () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  // 更早编号迁移里已 stage 过的 model id 全集(含 0144 及以前——catalog 机制迁移本身)。
  const stagedByEarlier = new Set<string>()

  for (const file of files) {
    const num = migrationNumber(file)
    const sql = stripSqlComments(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
    const stages = stageVersionCalls(sql)
    const pricings = pricingInserts(sql)

    if (num > 144 && pricings.length > 0) {
      test(`${file}: pricing 写入的 model id 必须已有 catalog 行(同文件先行或更早迁移)`, () => {
        for (const p of pricings) {
          const stagedEarlierInFile = stages.some((s) => s.id === p.id && s.offset < p.offset)
          assert.ok(
            stagedEarlierInFile || stagedByEarlier.has(p.id),
            `${file} 在无 catalog 行的情况下写 model_pricing('${p.id}')——` +
              `fn_model_catalog_ensure_for_pricing 不认识的 id 会兜底成 anthropic/200k 错行。` +
              `修法:同一迁移里先 fn_model_stage_version('${p.id}', …) → fn_model_activate,再写 pricing。`,
          )
        }
      })
    }
    for (const s of stages) stagedByEarlier.add(s.id)
  }

  test('契约自检:样本提取有效(0160 kimi-k3 的 stage 与 pricing 都被解析到)', () => {
    const kimi = files.find((f) => f.includes('0160'))
    assert.ok(kimi, '0160 迁移缺失?')
    const sql = stripSqlComments(readFileSync(path.join(MIGRATIONS_DIR, kimi as string), 'utf8'))
    assert.ok(
      stageVersionCalls(sql).some((s) => s.id === 'kimi-k3'),
      '提取器没认出 0160 的 fn_model_stage_version 调用——正则腐化,先修提取器',
    )
    assert.ok(
      pricingInserts(sql).some((p) => p.id === 'kimi-k3'),
      '提取器没认出 0160 的 model_pricing 写入——正则腐化,先修提取器',
    )
  })
})
