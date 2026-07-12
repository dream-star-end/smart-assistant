import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// runtime tuple / platform bundle 纯函数库(scripts/v5-runtime-release-lib.sh)的回归门:
// 复用同一份 bash drill(build_platform_bundle + digest 幂等/忽略 mtime + selfcheck 拒绝 +
// M8 必需叶子 + current 原子翻转 + history checksum/masterRelease(M7) + B2 开关互染 +
// B4 basename label GC + m5 退休台账 + B6 ccb 隔离构建 + B7 emergency 硬验 + M6 symlink digest +
// m6 env.bak 轮转 + 激活 saga 成功/失败点回滚 + M7c .prev-release 还原)。
// drill 用 /tmp 假树 + docker/bun stub 全本地跑,断言 99 项全绿。
const here = path.dirname(fileURLToPath(import.meta.url))
const drill = path.join(here, 'v5-runtime-release-lib-drill.sh')

describe('v5 runtime-release lib (hotcfg core)', () => {
  test('bundle/digest/selfcheck/GC/saga drill passes (99 assertions)', () => {
    const r = spawnSync('bash', [drill], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /PASS=99 FAIL=0/)
  })
})
