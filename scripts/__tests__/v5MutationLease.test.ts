import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// C1 行为测试:用**本地 flock** 模拟远端 holder(不碰 kl-mirror),验证
//   ① acquire 落 fencing meta + 持锁,release 释放并清 meta;
//   ② 硬 TTL:即便 holder 的父进程仍活(正是 SIGKILL 部署→残活 ssh 焊死锁的场景),
//      holder 也在 TTL 到点后自 exit 释放 flock 并清 meta;
//   ③ reclaim 对"活 holder + 未超 TTL"拒绝,OC_V5_RECLAIM_FORCE=1 才强清;
//   ④ reclaim 对"holder 进程已死"的陈旧 meta 自动清理。
// 手法:V5_DEPLOY_SOURCE_ONLY=1 source deploy-v5.sh 拿到真实函数,PATH 注入一个把
// `ssh <host> <script>` / `ssh <host> bash -s -- …` 就地本机执行的 fake ssh,PRODUCTION_MUTATION_LOCK
// 指向临时文件。锁语义、TTL 循环、reclaim 裁决全是**真实 remote 脚本**在本机跑。

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const deploy = path.join(root, 'scripts/deploy-v5.sh')
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture(ttlSeconds: number) {
  const dir = await mkdtemp(path.join(tmpdir(), 'v5-lease-'))
  dirs.push(dir)
  const bin = path.join(dir, 'bin')
  await mkdir(bin)
  // fake ssh:holder 形态 `ssh host "<script>"` → 本机 bash -c;
  //          reclaim 形态 `ssh host bash -s -- a b c` (stdin=heredoc) → 本机 bash -s。
  await writeFile(
    path.join(bin, 'ssh'),
    [
      '#!/bin/bash',
      'shift',                                   // drop host
      'if [ "${1:-}" = bash ] && [ "${2:-}" = -s ]; then exec "$@"; fi',
      'exec bash -c "$1"',
    ].join('\n') + '\n',
  )
  await chmod(path.join(bin, 'ssh'), 0o755)
  const lock = path.join(dir, 'mut.lock')
  return {
    dir,
    lock,
    meta: `${lock}.meta`,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      KL_HOST: 'fake',
      ALLOW_ANY_BRANCH: '1',
      OC_V5_PRODUCTION_MUTATION_LOCK: lock,
      OC_V5_MUTATION_LEASE_TTL_SECONDS: String(ttlSeconds),
    } as NodeJS.ProcessEnv,
  }
}

function orchestrate(script: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000) {
  const childEnv = { ...process.env, ...env }
  return spawnSync(
    'bash',
    ['-c', `V5_DEPLOY_SOURCE_ONLY=1 source scripts/deploy-v5.sh\nset +e\n${script}`],
    { cwd: root, encoding: 'utf8', env: childEnv, timeout: timeoutMs },
  )
}

describe('v5 production-mutation lease: TTL + fencing + reclaim (local flock model)', () => {
  test('acquire writes fencing meta and holds the flock; release frees and clears it', async () => {
    const fx = await fixture(2)
    const out = orchestrate(
      [
        'acquire_production_mutation_lease 5 >/dev/null 2>&1',
        `[ -f "${fx.meta}" ] && echo META_PRESENT`,
        `grep -q '"ttl":2' "${fx.meta}" && echo TTL_IN_META`,
        `grep -q '"mode":"deploy"' "${fx.meta}" && echo MODE_IN_META`,
        `grep -q '"deploy_id":"[0-9a-f]\\{24\\}"' "${fx.meta}" && echo DEPLOY_ID_IN_META`,
        `flock -n "${fx.lock}" true || echo HELD`,
        'release_production_mutation_lease',
        'sleep 1',
        `flock -n "${fx.lock}" true && echo FREED`,
        `[ -f "${fx.meta}" ] || echo META_GONE`,
      ].join('\n'),
      fx.env,
    )
    assert.equal(out.status, 0, out.stderr)
    for (const marker of ['META_PRESENT', 'TTL_IN_META', 'MODE_IN_META', 'DEPLOY_ID_IN_META', 'HELD', 'FREED', 'META_GONE']) {
      assert.match(out.stdout, new RegExp(`\\b${marker}\\b`), `缺 ${marker}\n${out.stdout}`)
    }
  })

  test('hard TTL self-releases even while the holder parent stays alive', async () => {
    const fx = await fixture(2) // TTL=2s
    const out = orchestrate(
      [
        'acquire_production_mutation_lease 5 >/dev/null 2>&1',
        `flock -n "${fx.lock}" true || echo HELD_INITIALLY`,
        'sleep 4', // 父进程(本 bash)全程存活;holder 必须靠 TTL 自 exit
        `flock -n "${fx.lock}" true && echo FREED_BY_TTL`,
        `[ -f "${fx.meta}" ] || echo META_GONE_BY_TTL`,
      ].join('\n'),
      fx.env,
    )
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /\bHELD_INITIALLY\b/, out.stdout)
    assert.match(out.stdout, /\bFREED_BY_TTL\b/, `TTL 未自释放\n${out.stdout}`)
    assert.match(out.stdout, /\bMETA_GONE_BY_TTL\b/, out.stdout)
  })

  test('reclaim refuses a live holder within TTL, and force cleans it', async () => {
    const fx = await fixture(3600) // 大 TTL → holder 不会自退
    const out = orchestrate(
      [
        '( acquire_production_mutation_lease 5 >/dev/null 2>&1; sleep 30 ) &',
        'KEEPER=$!',
        `for _ in $(seq 1 100); do [ -f "${fx.meta}" ] && break; sleep 0.1; done`,
        'reclaim_production_mutation_lease 2>&1 | grep -o "REFUSE:holder-live" | head -1',
        'OC_V5_RECLAIM_FORCE=1 reclaim_production_mutation_lease 2>&1 | grep -o "CLEAN:forced" | head -1',
        `[ -f "${fx.meta}" ] || echo META_CLEARED`,
        'kill "$KEEPER" 2>/dev/null; wait "$KEEPER" 2>/dev/null',
        'true',
      ].join('\n'),
      fx.env,
    )
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /\bREFUSE:holder-live\b/, `活 holder 未被拒绝\n${out.stdout}`)
    assert.match(out.stdout, /\bCLEAN:forced\b/, `force 未强清\n${out.stdout}`)
    assert.match(out.stdout, /\bMETA_CLEARED\b/, out.stdout)
  })

  test('reclaim clears stale metadata under a free flock without signalling a reused live pid', async () => {
    const fx = await fixture(3600)
    const out = orchestrate(
      [
        'sleep 30 & OTHER=$!',
        `printf '{"schema":1,"remote_pid":%s,"started_at":1,"ttl":1,"deploy_id":"old","holder_host":"old","mode":"deploy"}\\n' "$OTHER" > "${fx.meta}"`,
        'reclaim_production_mutation_lease 2>&1 | grep -o "CLEAN:no-meta-lock-free" | head -1',
        'kill -0 "$OTHER" 2>/dev/null && echo OTHER_ALIVE',
        `[ -f "${fx.meta}" ] || echo META_CLEARED`,
        'kill "$OTHER" 2>/dev/null; wait "$OTHER" 2>/dev/null',
        'true',
      ].join('\n'),
      fx.env,
    )
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /\bCLEAN:no-meta-lock-free\b/, out.stdout)
    assert.match(out.stdout, /\bOTHER_ALIVE\b/, `reclaim signalled an unrelated live pid\n${out.stdout}`)
    assert.match(out.stdout, /\bMETA_CLEARED\b/, out.stdout)
  })

  test('reclaim never lets force bypass exact flock-owner proof', async () => {
    const fx = await fixture(3600)
    const release = path.join(fx.dir, 'release-locker')
    const out = orchestrate(
      [
        `flock "${fx.lock}" bash -c 'while [ ! -e "${release}" ]; do sleep 0.05; done' & LOCKER=$!`,
        `for _ in $(seq 1 100); do flock -n "${fx.lock}" true 2>/dev/null || break; sleep 0.05; done`,
        'sleep 30 & OTHER=$!',
        `printf '{"schema":1,"remote_pid":%s,"started_at":1,"ttl":1,"deploy_id":"wrong","holder_host":"wrong","mode":"deploy"}\\n' "$OTHER" > "${fx.meta}"`,
        'reclaim_production_mutation_lease 2>&1 | grep -o "REFUSE:holder-identity-mismatch" | head -1',
        'OC_V5_RECLAIM_FORCE=1 reclaim_production_mutation_lease 2>&1 | grep -o "REFUSE:holder-identity-mismatch" | head -1',
        'kill -0 "$LOCKER" 2>/dev/null && echo LOCKER_ALIVE',
        'kill -0 "$OTHER" 2>/dev/null && echo OTHER_ALIVE',
        `: > "${release}"`,
        'wait "$LOCKER" 2>/dev/null',
        'kill "$OTHER" 2>/dev/null; wait "$OTHER" 2>/dev/null',
        'true',
      ].join('\n'),
      fx.env,
    )
    assert.equal(out.status, 0, out.stderr)
    assert.equal(
      (out.stdout.match(/\bREFUSE:holder-identity-mismatch\b/g) ?? []).length,
      2,
      out.stdout,
    )
    assert.match(out.stdout, /\bLOCKER_ALIVE\b/, `reclaim killed the real lock owner\n${out.stdout}`)
    assert.match(out.stdout, /\bOTHER_ALIVE\b/, `reclaim killed the unrelated metadata pid\n${out.stdout}`)
  })

  test('reclaim cleans a stale meta whose holder process is already dead', async () => {
    const fx = await fixture(3600)
    const out = orchestrate(
      [
        '( acquire_production_mutation_lease 5 >/dev/null 2>&1; sleep 30 ) &',
        'KEEPER=$!',
        `for _ in $(seq 1 100); do [ -f "${fx.meta}" ] && break; sleep 0.1; done`,
        // SIGKILL holder:trap 不跑 → meta 残留(陈旧),flock 由内核释放
        `RPID=$(sed -n 's/.*"remote_pid":\\([0-9]*\\).*/\\1/p' "${fx.meta}")`,
        'kill -9 "$RPID" 2>/dev/null',
        'kill -9 "$KEEPER" 2>/dev/null; wait "$KEEPER" 2>/dev/null',
        // holder loop 的在飞 sleep 继承 fd9，最多再持锁约 1s；reclaim 只有在内核
        // flock 真空闲后才能宣告 CLEAN，而不能只凭 holder PID 已死猜测。
        `for _ in $(seq 1 50); do flock -n "${fx.lock}" true 2>/dev/null && break; sleep 0.1; done`,
        `[ -f "${fx.meta}" ] && echo STALE_META_REMAINS`,
        'reclaim_production_mutation_lease 2>&1 | grep -oE "CLEAN:(stale|no-meta-lock-free)" | head -1',
        `[ -f "${fx.meta}" ] || echo META_CLEARED`,
        'true',
      ].join('\n'),
      fx.env,
    )
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /\bSTALE_META_REMAINS\b/, `SIGKILL 后 meta 应残留待 reclaim\n${out.stdout}`)
    assert.match(out.stdout, /\bCLEAN:(stale|no-meta-lock-free)\b/, `陈旧 meta 未被回收\n${out.stdout}`)
    assert.match(out.stdout, /\bMETA_CLEARED\b/, out.stdout)
  })
})
