#!/usr/bin/env -S npx tsx
/**
 * Ops 脚本: 市场僵尸 listing 治理(2026-07-10)。
 *
 * 症状: 早期批量导入/试验产生了大量「state='active' 但从无任何过审版本」的 listing
 * (2026-07 盘点为 155 个 skill + 1 个 e2e agent,版本全 rejected)。它们对目录/搜索/详情
 * 不可见(catalog JOIN current_approved_version_id),但:
 *   - 永久占用 slug(owner-locked,他人无法使用这些名字);
 *   - 污染发布者「我的发布」与运营统计口径。
 *
 * 判据(结构性,与 owner 无关): state='active' AND current_approved_version_id IS NULL
 * AND 不存在 status='pending' 的版本(在审的不碰)。
 *
 * 两种处置(都先 dry-run 默认打印清单):
 *   --archive  软处置: state → 'revoked' + revoked_reason 标注(保留审计;slug 仍被占)
 *   --purge    硬处置: DELETE listing(版本行随 ON DELETE CASCADE 删除;释放 slug)。
 *              适用于确认是批量导入垃圾的场景 —— 上线前由 boss 拍板选哪种。
 *
 * 用法(kl-mirror 本机):
 *   env $(grep -v '^#' /etc/openclaude/commercial-v5.env | xargs) \
 *     npx tsx scripts/v5-market-cleanup-zombies.ts              # dry-run 清单
 *   ... v5-market-cleanup-zombies.ts --archive|--purge          # 实际执行
 */
import { query, tx } from '../packages/commercial/src/db/queries.js'

async function main(): Promise<void> {
  const archive = process.argv.includes('--archive')
  const purge = process.argv.includes('--purge')
  if (archive && purge) {
    console.error('--archive 与 --purge 互斥')
    process.exit(2)
  }

  const zombies = await query<{
    slug: string
    kind: string
    owner: string
    versions: string
    last_rejected: string | null
  }>(
    `SELECT l.slug, l.kind, l.owner_user_id::text AS owner,
            count(v.id)::text AS versions, max(v.reviewed_at)::text AS last_rejected
       FROM marketplace_skill_listings l
       LEFT JOIN marketplace_skill_versions v ON v.slug = l.slug
      WHERE l.state = 'active'
        AND l.current_approved_version_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM marketplace_skill_versions p
           WHERE p.slug = l.slug AND p.status = 'pending')
      GROUP BY l.slug, l.kind, l.owner_user_id
      ORDER BY l.slug`,
  )

  if (zombies.rows.length === 0) {
    console.log('无僵尸 listing。')
    return
  }
  for (const z of zombies.rows)
    console.log(`${z.slug} (kind=${z.kind} owner=${z.owner} versions=${z.versions} lastReviewed=${z.last_rejected ?? '-'})`)
  console.log(`共 ${zombies.rows.length} 个。`)

  if (!archive && !purge) {
    console.log('dry-run;--archive 软下架 / --purge 删除释放 slug。')
    return
  }

  const slugs = zombies.rows.map((z) => z.slug)
  await tx(async (c) => {
    if (purge) {
      // 版本行 FK ON DELETE CASCADE;这些 listing 从未有过审版本,不可能有 install 行
      // (installs FK 指向 version 且只装 approved),故无悬挂引用。
      const r = await query(`DELETE FROM marketplace_skill_listings WHERE slug = ANY($1::text[])`, [slugs], c)
      console.log(`已删除 ${r.rowCount} 个 listing(slug 已释放)。`)
    } else {
      const r = await query(
        `UPDATE marketplace_skill_listings
            SET state = 'revoked',
                revoked_reason = '平台治理: 批量导入遗留、无过审版本,2026-07 归档',
                updated_at = NOW()
          WHERE slug = ANY($1::text[])`,
        [slugs],
        c,
      )
      console.log(`已归档 ${r.rowCount} 个 listing(state=revoked,slug 仍占用)。`)
    }
  })
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e)
  process.exit(1)
})
