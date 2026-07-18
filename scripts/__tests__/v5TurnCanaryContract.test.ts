// turn canary 矩阵 ↔ protocol 引擎权威 契约(2026-07-18 门禁审计批B)。
//
// v5-smoke-turn-canary.mjs 必须用 plain node 运行(kl-mirror release 树内无 tsx 入口
// 约定),而 @openclaude/protocol 包入口是 TS 源 —— 脚本内钉了一份 codex 模型清单副本。
// 本测试把副本焊死在权威上:CODEX_ENGINE_MODEL_IDS 变更(上/下架 codex 系模型)而
// canary 未同步 → CI 红。同时锁矩阵结构契约:三格齐全 + 三信号判据不被弱化。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CODEX_ENGINE_MODEL_IDS, DEFAULT_CODEX_ENGINE_MODEL } from '@openclaude/protocol'

const canaryPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'v5-smoke-turn-canary.mjs')

test('canary 内嵌 codex 模型清单 === protocol 权威(契约锁定的副本)', async () => {
  const source = await readFile(canaryPath, 'utf8')
  const m = source.match(/const CODEX_ENGINE_MODEL_IDS = \[([^\]]*)\]/)
  assert.ok(m, 'canary 脚本缺 CODEX_ENGINE_MODEL_IDS 清单')
  const embedded = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  assert.deepEqual(
    embedded,
    [...CODEX_ENGINE_MODEL_IDS],
    'canary 内嵌 codex 清单与 @openclaude/protocol CODEX_ENGINE_MODEL_IDS 漂移——两处必须同步',
  )
})

test('canary 默认 codex 模型 === protocol 权威默认', async () => {
  const source = await readFile(canaryPath, 'utf8')
  const m = source.match(/V5_TURN_MODEL \?\? '([^']+)'/)
  assert.ok(m, 'canary 脚本缺 V5_TURN_MODEL 默认值')
  assert.equal(m[1], DEFAULT_CODEX_ENGINE_MODEL, 'canary 默认模型与 protocol DEFAULT_CODEX_ENGINE_MODEL 漂移')
})

test('矩阵结构契约:三格齐全且默认全跑,三信号判据不被弱化', async () => {
  const source = await readFile(canaryPath, 'utf8')
  // 三格定义齐全,且默认 CELLS = 全矩阵(单格只允许经 V5_CANARY_CELLS 显式收窄——timer 轮转)。
  for (const cell of ['codex-new', 'ccb-new', 'codex-reuse']) {
    assert.ok(source.includes(`'${cell}'`), `矩阵缺格:${cell}`)
  }
  assert.match(
    source,
    /V5_CANARY_CELLS \?\? KNOWN_CELLS\.join\(','\)/,
    '默认必须跑全矩阵(部署门语义);单格收窄只能显式传 V5_CANARY_CELLS',
  )
  // 三信号判据(2026-07-17 收紧)不许回退成"见 text 即过"。
  assert.match(source, /sawText && sawFinal && \(sawCost \|\| !REQUIRE_COST\)/, '三信号判据被弱化')
  // 冷启动重试红线(2026-07-18 admit 竞态教训):只有零信号 clean close 允许重试,
  // 出了部分信号必须硬失败——重试掩蔽过 100% 复现故障,这条判据不许放宽。
  assert.match(source, /r === 'closed' && !sawText && !sawFinal/, '冷启动重试判据被放宽(部分信号必须硬失败)')
  // ccb 格 fail-loud:catalog 无 ccb 模型必须失败而非跳过。
  assert.match(source, /没有任何非 codex 系模型/, 'ccb 格缺 catalog 异常 fail-loud 路径')
})
