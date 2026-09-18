/**
 * msc-config 阶段 A 审计用例:agents.yaml 读取的 shape 契约。
 *
 * readAgentsConfig() 只在 ENOENT 时给默认值;文件存在但内容为空 / 缺 agents 键时,
 * parseYaml 的结果(null / 缺字段对象)被原样 `as AgentsConfig` 返回,下游
 * `cfg.agents.find(...)` 直接 TypeError(见 docs/audit/msc-config.md CFG-01 / CFG-02)。
 *
 * 红灯用例标注 TODO(msc-config): 阶段 B 修复(在 readAgentsConfig 内做 shape 归一)。
 * 运行:npx tsx --test packages/storage/src/__tests__/mscConfigAgentsYamlShape.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'msc-config-yaml-shape-'))
process.env.OPENCLAUDE_HOME = home
const { readAgentsConfig, updateAgentsConfig } = await import('../config.js')
const { paths } = await import('../paths.js')
after(() => rm(home, { recursive: true, force: true }))

// TODO(msc-config): 阶段 B 修复 —— 空文件应与 ENOENT 同语义(返回 bootstrap 默认),而不是 null。
test('empty agents.yaml resolves to the bootstrap default instead of null', async () => {
  await writeFile(paths.agentsYaml, '')
  const cfg = await readAgentsConfig()
  assert.ok(cfg !== null && typeof cfg === 'object', 'readAgentsConfig must never resolve null')
  assert.ok(Array.isArray(cfg.agents), 'agents must be an array')
  assert.equal(typeof cfg.default, 'string')
})

// TODO(msc-config): 阶段 B 修复 —— 缺 agents / routes 键时补空数组,default 缺失时补首个 agent。
test('agents.yaml missing agents/routes keys is normalized to arrays', async () => {
  await writeFile(paths.agentsYaml, 'default: main\n')
  const cfg = await readAgentsConfig()
  assert.ok(Array.isArray(cfg.agents), 'agents must be normalized to an array')
  assert.ok(Array.isArray(cfg.routes), 'routes must be normalized to an array')
  // 事务入口不能因为 shape 问题在回调里 TypeError
  const { result } = await updateAgentsConfig((c) => c.agents.some((a) => a.id === 'main'))
  assert.equal(typeof result, 'boolean')
})

// 回归锁(当前已满足):写回保留 schema 外字段(agent 级 + 顶层),marketplace 归属标记不丢。
test('updateAgentsConfig round-trip keeps unknown keys and provenance markers', async () => {
  await writeFile(
    paths.agentsYaml,
    [
      'agents:',
      '  - id: main',
      '    model: glm-5.3-zai',
      '    customFlag: keep-me',
      '  - id: shop',
      '    source: marketplace',
      'default: main',
      'routes: []',
      'teams:',
      '  - id: legacy',
      '',
    ].join('\n'),
  )
  await updateAgentsConfig((cfg) => {
    cfg.agents[0].model = 'deepseek-v4-pro'
  })
  const text = await readFile(paths.agentsYaml, 'utf8')
  assert.match(text, /model: deepseek-v4-pro/)
  assert.match(text, /customFlag: keep-me/, 'unknown per-agent key must survive a write-back')
  assert.match(text, /teams:/, 'unknown top-level key must survive a write-back')
  assert.match(text, /source: marketplace/)
})
