#!/usr/bin/env -S npx tsx
/**
 * Ops 脚本: 市场存量条目「人向商品层」元数据回填(配合迁移 0127,2026-07-10)。
 *
 * 背景: 0127 给 marketplace_skill_versions 加了 category/use_cases/outcome_examples/
 * human_md,给 listings 加了 featured_rank。发布路径已强制新元数据,但存量已上架版本
 * 不会重发版 —— 由本脚本按 scripts/data/v5-market-human-metadata.json(人工撰写内容)
 * 一次性回填到各 listing 的 **current approved version** 行。
 *
 * 语义边界(为什么允许 UPDATE「不可变」的 approved 版本):
 *   - 版本不可变性保护的是**工件**(raw_skill_md/raw_artifact/artifact_hash =「审核所见
 *     即安装所得」);人向元数据是 storefront 展示层,不进工件、不影响 artifact_hash。
 *   - use_cases 参与语义检索文本(storage skillEmbedText),故回填后必须同步重算
 *     embedding_hash —— 本脚本用与发布路径同一权威 skillContentHash,绝不手搓。
 *
 * 用法(kl-mirror 本机、v5 部署树):
 *   env $(grep -v '^#' /etc/openclaude/commercial-v5.env | xargs) \
 *     npx tsx scripts/v5-market-backfill-metadata.ts            # dry-run(默认,只打印计划)
 *   ... v5-market-backfill-metadata.ts --apply                  # 实际写库(事务)
 *
 * 幂等: 内容以 JSON 为权威,重跑=覆盖为 JSON 当前值;JSON 里没有的 slug 不动。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { skillContentHash } from '../packages/storage/src/skillEmbedding.js'
import { isMarketplaceCategoryId } from '../packages/protocol/src/marketplaceTaxonomy.js'
import { query, tx } from '../packages/commercial/src/db/queries.js'

interface ItemMeta {
  category: string
  useCases: string[]
  outcomeExamples?: string[]
  humanMd?: string
  featuredRank?: number
}

const __dir = dirname(fileURLToPath(import.meta.url))
const DATA_PATH = join(__dir, 'data', 'v5-market-human-metadata.json')

function loadItems(): Map<string, ItemMeta> {
  const raw = JSON.parse(readFileSync(DATA_PATH, 'utf8')) as { items: Record<string, ItemMeta> }
  const out = new Map<string, ItemMeta>()
  for (const [slug, m] of Object.entries(raw.items)) {
    // 与发布路径同规则的最小校验 —— 回填内容也不许越过发布门槛。
    if (!isMarketplaceCategoryId(m.category)) throw new Error(`${slug}: 非法 category "${m.category}"`)
    if (!Array.isArray(m.useCases) || m.useCases.length < 1 || m.useCases.length > 4)
      throw new Error(`${slug}: useCases 须 1-4 条`)
    for (const u of m.useCases)
      if (typeof u !== 'string' || u.trim().length < 4 || u.trim().length > 120)
        throw new Error(`${slug}: useCase 长度须 4-120: ${u}`)
    for (const o of m.outcomeExamples ?? [])
      if (typeof o !== 'string' || o.trim().length === 0 || o.trim().length > 200)
        throw new Error(`${slug}: outcomeExample 长度须 1-200`)
    if (m.humanMd !== undefined && m.humanMd.length > 16384) throw new Error(`${slug}: humanMd 超长`)
    out.set(slug, m)
  }
  return out
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const items = loadItems()

  const rows = await query<{
    slug: string
    vid: string
    name: string
    description: string
    tags: unknown
    featured_rank: number | null
    category: string | null
  }>(
    `SELECT l.slug, v.id::text AS vid, v.name, v.description, v.tags, l.featured_rank, v.category
       FROM marketplace_skill_listings l
       JOIN marketplace_skill_versions v ON v.id = l.current_approved_version_id
      WHERE l.state = 'active'
      ORDER BY l.slug`,
  )

  const bySlug = new Map(rows.rows.map((r) => [r.slug, r]))
  const missingInDb = [...items.keys()].filter((s) => !bySlug.has(s))
  const missingInJson = rows.rows.filter((r) => !items.has(r.slug)).map((r) => r.slug)
  if (missingInDb.length) console.warn(`⚠ JSON 有但库里无 current approved(跳过): ${missingInDb.join(', ')}`)
  if (missingInJson.length) console.warn(`⚠ 库里在架但 JSON 未覆盖(保持未分类): ${missingInJson.join(', ')}`)

  let planned = 0
  for (const [slug, m] of items) {
    const row = bySlug.get(slug)
    if (!row) continue
    const tags = (row.tags as string[]) ?? []
    const newEmbeddingHash = skillContentHash({
      name: row.name,
      description: row.description,
      tags,
      use_cases: m.useCases,
    })
    planned++
    console.log(
      `${apply ? 'APPLY' : 'PLAN '} ${slug}: category=${m.category} useCases=${m.useCases.length}` +
        ` outcomes=${m.outcomeExamples?.length ?? 0} humanMd=${m.humanMd ? 'yes' : 'no'}` +
        ` featured=${m.featuredRank ?? '-'} embed=${newEmbeddingHash.slice(0, 12)}…`,
    )
    if (!apply) continue
    await tx(async (c) => {
      await query(
        `UPDATE marketplace_skill_versions
            SET category = $2, use_cases = $3::jsonb, outcome_examples = $4::jsonb,
                human_md = $5, embedding_hash = $6
          WHERE id = $1`,
        [
          row.vid,
          m.category,
          JSON.stringify(m.useCases.map((u) => u.trim())),
          JSON.stringify((m.outcomeExamples ?? []).map((o) => o.trim())),
          m.humanMd ?? null,
          newEmbeddingHash,
        ],
        c,
      )
      await query(
        `UPDATE marketplace_skill_listings SET featured_rank = $2, updated_at = NOW() WHERE slug = $1`,
        [slug, m.featuredRank ?? null],
        c,
      )
    })
  }
  console.log(`${apply ? '已回填' : 'dry-run 计划'} ${planned} 条;--apply 才会写库。`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
