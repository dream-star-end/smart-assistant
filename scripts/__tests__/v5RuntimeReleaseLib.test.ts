import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// runtime tuple / platform bundle 纯函数库(scripts/v5-runtime-release-lib.sh)的回归门:
// 复用同一份 bash drill(build_platform_bundle + digest 幂等/忽略 mtime + selfcheck 拒绝 +
// current 原子翻转 + history checksum + GC 保护集含 docker 失败放弃 + 激活 saga 成功/两处失败点回滚)。
// drill 用 /tmp 假树 + docker stub 全本地跑,断言 46 项全绿。
const here = path.dirname(fileURLToPath(import.meta.url))
const drill = path.join(here, 'v5-runtime-release-lib-drill.sh')

describe('v5 runtime-release lib (hotcfg core)', () => {
  test('bundle/digest/selfcheck/GC/saga drill passes (46 assertions)', () => {
    const r = spawnSync('bash', [drill], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /PASS=46 FAIL=0/)
  })
})
