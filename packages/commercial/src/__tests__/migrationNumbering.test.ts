import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.resolve(here, '../db/migrations')

// 历史遗留同号对,冻结名单:这些序号各有两个文件共存,runner 按全名排序、
// ledger 记全名,机械上无害,但破坏"next = max+1"开号约定。只冻结,不许新增
// (2026-07-17 一天内三起并行批撞号,0163 双开实际合入 canonical 后才被发现)。
const GRANDFATHERED_DUPLICATE_PREFIXES = new Set(['0102', '0103', '0130', '0134', '0135'])

describe('migration numbering gate', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))

  test('每个迁移文件名以四位序号加下划线开头', () => {
    for (const f of files) {
      assert.match(f, /^\d{4}_/, `迁移文件名必须形如 NNNN_name.sql: ${f}`)
    }
  })

  test('禁止新增同号迁移(存量同号对已冻结)', () => {
    const byPrefix = new Map<string, string[]>()
    for (const f of files) {
      const prefix = f.slice(0, 4)
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), f])
    }
    for (const [prefix, names] of byPrefix) {
      if (names.length === 1) continue
      assert.ok(
        GRANDFATHERED_DUPLICATE_PREFIXES.has(prefix),
        `迁移序号 ${prefix} 出现 ${names.length} 个文件(${names.join(', ')})。` +
          `开号必须对生产 schema_migrations ledger 与 canonical 目录双源取 max+1;` +
          `若与并行批撞号,后落地者重编号。`,
      )
      assert.equal(
        names.length,
        2,
        `冻结的同号对 ${prefix} 只允许历史存量的 2 个文件,不许继续叠加: ${names.join(', ')}`,
      )
    }
  })

  test('冻结名单不含已消亡的序号(防名单腐化)', () => {
    const prefixes = new Set(files.map((f) => f.slice(0, 4)))
    for (const prefix of GRANDFATHERED_DUPLICATE_PREFIXES) {
      assert.ok(prefixes.has(prefix), `冻结名单中的 ${prefix} 已不存在,应从名单移除`)
    }
  })
})
