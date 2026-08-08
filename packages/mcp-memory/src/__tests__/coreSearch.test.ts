import * as assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'core-search-'))
process.env.OPENCLAUDE_HOME = home
const { handleCoreSearch } = await import('../memoryTools.js')

test('中文长查询可召回其中相关主题，不把无关任务误召回', async () => {
  const dir = join(home, 'agents', 'main', 'memory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'health.md'),
    '---\nname: health\ndescription: 用户健康背景\ntype: user\n---\n用户有鼻炎鼻塞。',
  )
  const related = await handleCoreSearch({
    agentId: 'main',
    query: '过敏性鼻炎 咳嗽变异性哮喘 荨麻疹',
  })
  assert.match(related.content[0].text, /^Found 1 safe Core matches/)

  const unrelated = await handleCoreSearch({ agentId: 'main', query: '采购方案文件评阅' })
  assert.match(unrelated.content[0].text, /^No safe Core memories match/)
})
