#!/usr/bin/env tsx
/**
 * 发布 / 核对平台官方市场连接器 `bili`(OCV5-402)。只上 AI 市场、不预装。
 *
 *   --dry-run  编译 + 静态扫描 + 对真实上游逐个动作实测,不写库
 *   --apply    在 dry-run 全部通过后,以代码里的版本号发布 pending 版本并完成连接器审核上架
 *
 * 输出一份 JSON 报告(只含形状:条数、业务码、hash),不含任何上游内容或凭据。
 */

import { closePool } from '../src/db/index.js'
import { seedOfficialMarketConnector } from '../src/marketplace/seedOfficialConnectors.js'

const USAGE = 'usage: seed-bili-plugin.ts --dry-run | --apply'

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const apply = args.includes('--apply')
  if (dryRun === apply || args.some((a) => a !== '--dry-run' && a !== '--apply')) {
    console.error(USAGE)
    return 2
  }
  try {
    const report = await seedOfficialMarketConnector({ slug: 'bili', dryRun })
    console.log(JSON.stringify(report, null, 2))
    return 0
  } catch (e) {
    console.error(`seed-bili-plugin: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  } finally {
    if (apply) await closePool().catch(() => {})
  }
}

process.exitCode = await main()
