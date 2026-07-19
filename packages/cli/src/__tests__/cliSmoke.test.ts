/**
 * cli 包导入图冒烟(2026-07-18 门禁审计批F)。
 *
 * 背景:packages/cli 是发布物却零测试——命令模块的导入图断裂(依赖重构/路径改名)
 * 只有用户敲命令时才爆。本测试把"每个命令模块可加载且导出可调用"钉进 CI。
 * 有意不 import index.ts:它是 CLI 入口,顶层会构建 commander 树并 parse,
 * 在测试进程里有副作用;命令实现模块才是无副作用的可测面。
 * plugin-sdk 无同类测试是有意裁定:纯类型包,typecheck 即全部运行面。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

describe('cli 命令模块导入图', () => {
  test('agents 命令导出可调用', async () => {
    const m = await import('../commands/agents.js')
    assert.equal(typeof m.agentsAdd, 'function')
    assert.equal(typeof m.agentsList, 'function')
  })
  test('doctor 命令导出可调用', async () => {
    const m = await import('../commands/doctor.js')
    assert.equal(typeof m.doctor, 'function')
  })
  test('gateway 命令导出可调用', async () => {
    const m = await import('../commands/gateway.js')
    assert.equal(typeof m.gatewayCmd, 'function')
  })
  test('onboard 命令导出可调用', async () => {
    const m = await import('../commands/onboard.js')
    assert.equal(typeof m.onboard, 'function')
  })
  test('pairing 命令导出可调用', async () => {
    const m = await import('../commands/pairing.js')
    assert.equal(typeof m.pairingList, 'function')
    assert.equal(typeof m.pairingTelegramAdd, 'function')
    assert.equal(typeof m.pairingTelegramRemove, 'function')
  })
})
