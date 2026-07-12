import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// runtime tuple / platform bundle 纯函数库(scripts/v5-runtime-release-lib.sh)的回归门:
// 复用同一份 bash drill(build_platform_bundle + digest 幂等/忽略 mtime + selfcheck 拒绝 +
// M8 必需叶子(含 bin/oc-web-context,R2-M2①) + current 原子翻转 + history checksum/masterRelease
// (M7)+ R2-M3 schemaVer v1/v2 混存 + R2-B1 env 三态写(禁用轴写空值)+ R2-B2 首启 pre-state→
// rollback 退回启用前 + B4 basename label GC + m5 退休台账 + B6 ccb 隔离构建 + B7/R2-M1 emergency
// 硬验(显式候选 + immutable ID 钉死 + R2-m1 bak 轮转)+ M6 symlink digest + m6 env.bak 轮转 +
// 激活 saga 成功/失败点回滚 + M7c .prev-release 还原 + R2-M2③ canary boot 成功/失败/跳过)。
// drill 用 /tmp 假树 + docker/bun stub 全本地跑,断言 148 项全绿。
const here = path.dirname(fileURLToPath(import.meta.url))
const drill = path.join(here, 'v5-runtime-release-lib-drill.sh')
const imageGcDrill = path.join(here, 'build-image-gc-drill.sh')

describe('v5 runtime-release lib (hotcfg core)', () => {
  test('bundle/digest/selfcheck/GC/saga drill passes (148 assertions)', () => {
    const r = spawnSync('bash', [drill], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /PASS=148 FAIL=0/)
  })

  // build-image.sh image GC(R2-M1):immutable ID 保护 / inspect 失败保守跳过 /
  // emergency tuple 解析失败放弃本轮 / DRY_RUN 零删除。OC_IMAGE_GC_ONLY=1 + PATH docker stub 全本地跑。
  test('build-image image-gc drill passes (12 assertions)', () => {
    const r = spawnSync('bash', [imageGcDrill], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /PASS=12 FAIL=0/)
  })
})
