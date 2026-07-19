import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
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
      'while [[ "${1:-}" == "-o" ]]; do shift 2; done',
      'shift',                                   // drop host
      'if [[ "${OC_TEST_FAIL_MANUAL_MARKER:-0}" == 1 && "${1:-}" == bash && "${2:-}" == -s && "${4:-}" == "${OC_TEST_MANUAL_MARKER:-}" ]]; then exit 42; fi',
      'if [[ "${OC_TEST_STALL_LANE_CLEAR:-0}" == 1 && "${1:-}" == bash && "${2:-}" == -s && "${4:-}" == "${OC_TEST_LANE_MARKER:-}" && -z "${6:-}" ]]; then',
      '  printf "%s %s\\n" "$BASHPID" "$(ps -o pgid= -p "$BASHPID" | tr -d "[:space:]")" >"${OC_TEST_CLEAR_PIDS}"',
      '  : >"${OC_TEST_CLEAR_STARTED}"',
      '  while :; do sleep 0.1; done',
      'fi',
      'if [ "${1:-}" = bash ] && [ "${2:-}" = -s ]; then exec "$@"; fi',
      'exec bash -c "$1"',
    ].join('\n') + '\n',
  )
  await chmod(path.join(bin, 'ssh'), 0o755)
  const lock = path.join(dir, 'mut.lock')
  const laneMarker = path.join(dir, 'mutation-lane-inflight')
  return {
    dir,
    lock,
    meta: `${lock}.meta`,
    laneMarker,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      KL_HOST: 'fake',
      ALLOW_ANY_BRANCH: '1',
      OC_V5_PRODUCTION_MUTATION_LOCK: lock,
      OC_V5_MUTATION_LEASE_TTL_SECONDS: String(ttlSeconds),
      OC_V5_MUTATION_LANE_MARKER: laneMarker,
    } as NodeJS.ProcessEnv,
  }
}

function spawnOrchestrated(script: string, env: NodeJS.ProcessEnv) {
  return spawn(
    'bash',
    ['-c', `V5_DEPLOY_SOURCE_ONLY=1 source scripts/deploy-v5.sh\nset +e\n${script}`],
    { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore', detached: true },
  )
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve(true) })
  })
}

async function recordedProcessesExited(pidFile: string): Promise<boolean> {
  const raw = await readFile(pidFile, 'utf8').catch(() => '')
  const pids = raw.split(/\s+/).map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 1)
  if (pids.length === 0) return false
  return pids.every((pid) => {
    try { process.kill(pid, 0); return false } catch { return true }
  })
}

async function killRecordedProcesses(...pidFiles: string[]): Promise<void> {
  for (const pidFile of pidFiles) {
    const raw = await readFile(pidFile, 'utf8').catch(() => '')
    for (const value of raw.split(/\s+/)) {
      const pid = Number(value)
      if (!Number.isSafeInteger(pid) || pid <= 1) continue
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
}

function stoppedChildGroupLeader(parentPid: number): number | undefined {
  const out = spawnSync('ps', ['-eo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' }).stdout
  for (const line of out.split('\n')) {
    const [pidRaw, ppidRaw, pgidRaw, stat = ''] = line.trim().split(/\s+/)
    const pid = Number(pidRaw)
    if (Number(ppidRaw) === parentPid && Number(pgidRaw) === pid && stat.startsWith('T')) return pid
  }
  return undefined
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
  test('process-group census failure is fail-closed instead of authorizing quiet', async () => {
    const fx = await fixture(30)
    const out = orchestrate(
      [
        'ps() { return 42; }',
        'process_group_has_live_members 424242 && echo GROUP_CONSERVATIVELY_LIVE',
        'process_group_has_live_members_except 424242 424243 && echo DESCENDANT_CONSERVATIVELY_LIVE',
        'process_group_has_live_members_except_two 424242 424243 424244 && echo TWO_DESCENDANTS_CONSERVATIVELY_LIVE',
      ].join('\n'),
      fx.env,
    )
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /GROUP_CONSERVATIVELY_LIVE/)
    assert.match(out.stdout, /DESCENDANT_CONSERVATIVELY_LIVE/)
    assert.match(out.stdout, /TWO_DESCENDANTS_CONSERVATIVELY_LIVE/)
  })

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

  test('supervised mutation lane preserves normal status and exact-clears its marker', async () => {
    const fx = await fixture(30)
    const bad = path.join(fx.dir, 'errexit-bypassed')
    const out = orchestrate(
      [
        'lane_ok() { return 0; }',
        'lane_23() { return 23; }',
        `lane_errexit() { false; : >"${bad}"; }`,
        'acquire_production_mutation_lease 5 >/dev/null',
        'run_mutation_lane_supervised lane_ok; echo OK_RC=$?',
        `[ ! -e "${fx.laneMarker}" ] && echo OK_MARKER_CLEARED`,
        'run_mutation_lane_supervised lane_23; echo ERR_RC=$?',
        `[ ! -e "${fx.laneMarker}" ] && echo ERR_MARKER_CLEARED`,
        'run_mutation_lane_supervised lane_errexit; echo ERREXIT_RC=$?',
        `[ ! -e "${bad}" ] && echo ERREXIT_ENFORCED`,
        `[ ! -e "${fx.laneMarker}" ] && echo ERREXIT_MARKER_CLEARED`,
        'mutation_lease_live && echo LEASE_STILL_LIVE',
        'release_production_mutation_lease',
      ].join('\n'),
      fx.env,
    )
    assert.equal(out.status, 0, out.stderr)
    for (const marker of [
      'OK_RC=0', 'OK_MARKER_CLEARED', 'ERR_RC=23', 'ERR_MARKER_CLEARED',
      'ERREXIT_RC=1', 'ERREXIT_ENFORCED', 'ERREXIT_MARKER_CLEARED', 'LEASE_STILL_LIVE',
    ]) {
      assert.match(out.stdout, new RegExp(marker), `${marker} missing\n${out.stdout}\n${out.stderr}`)
    }
  })

  test('in-flight arm durability failure rejects the payload before any mutation starts', async () => {
    const fx = await fixture(30)
    const attempted = path.join(fx.dir, 'payload-attempted')
    const fakeSync = path.join(fx.dir, 'bin', 'sync')
    await writeFile(fakeSync, '#!/bin/sh\nexit 42\n')
    await chmod(fakeSync, 0o755)
    const out = orchestrate(
      [
        `must_not_run() { : >"${attempted}"; }`,
        'acquire_production_mutation_lease 5 >/dev/null',
        'run_mutation_lane_supervised must_not_run; echo ARM_RC=$?',
        `[ ! -e "${attempted}" ] && echo PAYLOAD_NOT_STARTED`,
        `[ ! -e "${fx.laneMarker}" ] && echo MARKER_NOT_PUBLISHED`,
        'release_production_mutation_lease',
      ].join('\n'),
      fx.env,
    )
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /ARM_RC=3/)
    assert.match(out.stdout, /PAYLOAD_NOT_STARTED/)
    assert.match(out.stdout, /MARKER_NOT_PUBLISHED/)
  })

  test('manual recovery marker write failure crash-stops without clearing in-flight evidence', async () => {
    const fx = await fixture(30)
    const manualMarker = path.join(fx.dir, 'manual-recovery-required')
    const out = orchestrate(
      [
        `DEPLOY_RECOVERY_MARKER="${manualMarker}"`,
        'needs_manual_recovery() { mark_deploy_recovery_required "injected marker transport failure"; return 1; }',
        'acquire_production_mutation_lease 5 >/dev/null',
        'run_mutation_lane_supervised needs_manual_recovery; echo RECOVERY_RC=$?',
        `[ ! -e "${manualMarker}" ] && echo MANUAL_MARKER_ABSENT`,
        `[ -e "${fx.laneMarker}" ] && echo INFLIGHT_MARKER_PRESERVED`,
        'release_production_mutation_lease',
      ].join('\n'),
      { ...fx.env, OC_TEST_FAIL_MANUAL_MARKER: '1', OC_TEST_MANUAL_MARKER: manualMarker },
    )
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /RECOVERY_RC=86/)
    assert.match(out.stdout, /MANUAL_MARKER_ABSENT/)
    assert.match(out.stdout, /INFLIGHT_MARKER_PRESERVED/)
  })

  test('lease holder loss KILLs the whole lane group and skips mutation cleanup', async () => {
    const fx = await fixture(30)
    const started = path.join(fx.dir, 'lane-started')
    const commandPids = path.join(fx.dir, 'lane-pids')
    const leasePidFile = path.join(fx.dir, 'lease-pid')
    const cleanup = path.join(fx.dir, 'cleanup-ran')
    const child = spawnOrchestrated(
      [
        `end_planned_maintenance() { : >"${cleanup}"; PLANNED_MAINTENANCE_ACTIVE=0; }`,
        'stubborn_lane() {',
        "  trap '' TERM",
        `  printf '%s\\n' "$BASHPID" >>"${commandPids}"`,
        `  ( trap '' TERM; printf '%s\\n' "$BASHPID" >>"${commandPids}"; while :; do sleep 0.1; done ) &`,
        '  PLANNED_MAINTENANCE_ACTIVE=1',
        `  : >"${started}"`,
        '  while :; do sleep 0.1; done',
        '}',
        'acquire_production_mutation_lease 5 >/dev/null',
        `printf '%s\\n' "$MUTATION_LEASE_PID" >"${leasePidFile}"`,
        'run_mutation_lane_supervised stubborn_lane',
        'rc=$?',
        'release_production_mutation_lease',
        'exit "$rc"',
      ].join('\n'),
      fx.env,
    )
    try {
      assert.equal(await waitUntil(() => readFile(started).then(() => true).catch(() => false), 5_000), true)
      const leasePid = Number((await readFile(leasePidFile, 'utf8')).trim())
      assert.equal(Number.isSafeInteger(leasePid) && leasePid > 1, true, 'missing lease pid')
      process.kill(leasePid, 'SIGKILL')
      assert.equal(await waitForExit(child, 6_000), true, 'supervisor did not exit after holder loss')
      assert.equal(child.exitCode, 86, `holder loss must use rc=86; signal=${child.signalCode}`)
      assert.equal(await waitUntil(() => recordedProcessesExited(commandPids), 5_000), true, 'lane descendants survived holder loss')
      assert.equal(await readFile(cleanup).then(() => true).catch(() => false), false, 'lease-loss child ran mutation cleanup')
      assert.equal(await readFile(fx.laneMarker).then(() => true).catch(() => false), true, 'lease loss did not preserve in-flight marker')
      assert.equal(await waitUntil(() => spawnSync('flock', ['-n', fx.lock, 'true']).status === 0, 5_000), true, 'holder loss left flock held')
    } finally {
      child.kill('SIGKILL')
      await killRecordedProcesses(commandPids, leasePidFile)
    }
  })

  test('outer process-group SIGKILL leaves the independent watchdog to crash-stop lane and lease', async () => {
    const fx = await fixture(30)
    const started = path.join(fx.dir, 'parent-kill-started')
    const commandPids = path.join(fx.dir, 'parent-kill-pids')
    const leasePidFile = path.join(fx.dir, 'parent-kill-lease-pid')
    const cleanup = path.join(fx.dir, 'parent-kill-cleanup')
    const child = spawnOrchestrated(
      [
        `end_planned_maintenance() { : >"${cleanup}"; PLANNED_MAINTENANCE_ACTIVE=0; }`,
        'stubborn_lane() {',
        "  trap '' TERM",
        `  printf '%s\\n' "$BASHPID" >>"${commandPids}"`,
        `  ( trap '' TERM; printf '%s\\n' "$BASHPID" >>"${commandPids}"; while :; do sleep 0.1; done ) &`,
        '  PLANNED_MAINTENANCE_ACTIVE=1',
        `  : >"${started}"`,
        '  while :; do sleep 0.1; done',
        '}',
        'acquire_production_mutation_lease 5 >/dev/null',
        `printf '%s\\n' "$MUTATION_LEASE_PID" >"${leasePidFile}"`,
        'run_mutation_lane_supervised stubborn_lane',
      ].join('\n'),
      fx.env,
    )
    try {
      assert.equal(await waitUntil(() => readFile(started).then(() => true).catch(() => false), 5_000), true)
      process.kill(-child.pid!, 'SIGKILL')
      assert.equal(await waitForExit(child, 3_000), true, 'outer deploy shell did not die')
      assert.equal(await waitUntil(() => recordedProcessesExited(commandPids), 6_000), true, 'independent watchdog left lane descendants alive')
      assert.equal(await waitUntil(() => spawnSync('flock', ['-n', fx.lock, 'true']).status === 0, 6_000), true, 'independent watchdog left lease held')
      assert.equal(await readFile(cleanup).then(() => true).catch(() => false), false, 'outer SIGKILL ran mutation cleanup')
      assert.equal(await readFile(fx.laneMarker).then(() => true).catch(() => false), true, 'outer SIGKILL lost recovery marker')
    } finally {
      child.kill('SIGKILL')
      await killRecordedProcesses(commandPids, leasePidFile)
    }
  })

  test('a stopped outer process group cannot freeze the local lease TTL or leave the lane mutating', async () => {
    const fx = await fixture(30)
    const started = path.join(fx.dir, 'stopped-parent-started')
    const commandPids = path.join(fx.dir, 'stopped-parent-pids')
    const leasePidFile = path.join(fx.dir, 'stopped-parent-lease-pid')
    const heartbeat = path.join(fx.dir, 'stopped-parent-heartbeat')
    const child = spawnOrchestrated(
      [
        'heartbeat_lane() {',
        `  printf '%s\\n' "$BASHPID" >>"${commandPids}"`,
        `  : >"${started}"`,
        `  while :; do printf '%s\\n' "$RANDOM" >"${heartbeat}"; sleep 0.05; done`,
        '}',
        'acquire_production_mutation_lease 5 >/dev/null',
        `printf '%s\\n' "$MUTATION_LEASE_PID" >"${leasePidFile}"`,
        'run_mutation_lane_supervised heartbeat_lane',
        'rc=$?',
        'release_production_mutation_lease',
        'exit "$rc"',
      ].join('\n'),
      fx.env,
    )
    try {
      assert.equal(await waitUntil(() => readFile(started).then(() => true).catch(() => false), 5_000), true)
      const stoppedAt = Date.now()
      process.kill(-child.pid!, 'SIGSTOP')
      assert.equal(await waitUntil(() => recordedProcessesExited(commandPids), 3_000), true, 'watchdog did not immediately KILL lane after outer group STOP')
      assert.ok(Date.now() - stoppedAt < 3_000, 'lane survived until the much later local TTL instead of failing on supervisor STOP')
      assert.equal(await waitUntil(() => spawnSync('flock', ['-n', fx.lock, 'true']).status === 0, 4_000), true, 'stopped outer left lease held')
      const stoppedHeartbeat = await readFile(heartbeat, 'utf8')
      await new Promise((resolve) => setTimeout(resolve, 250))
      assert.equal(await readFile(heartbeat, 'utf8'), stoppedHeartbeat, 'lane kept mutating after watchdog crash-stop')
      assert.equal(await readFile(fx.laneMarker).then(() => true).catch(() => false), true, 'TTL crash-stop lost recovery marker')
      process.kill(-child.pid!, 'SIGCONT')
      assert.equal(await waitForExit(child, 4_000), true, 'outer did not finish after resume')
      assert.equal(child.exitCode, 86, `resumed outer must report lease-loss rc=86; signal=${child.signalCode}`)
    } finally {
      try { process.kill(-child.pid!, 'SIGCONT') } catch { /* already gone */ }
      child.kill('SIGKILL')
      await killRecordedProcesses(commandPids, leasePidFile)
    }
  })

  test('lane leader death after payload completion cannot wedge authorization or clear evidence', async () => {
    const fx = await fixture(30)
    const returned = path.join(fx.dir, 'payload-returned')
    const descendantPids = path.join(fx.dir, 'post-return-descendant-pids')
    const child = spawnOrchestrated(
      [
        'return_with_descendant() {',
        `  sleep 10 & printf '%s\\n' "$!" >"${descendantPids}"`,
        `  : >"${returned}"`,
        '  return 0',
        '}',
        'acquire_production_mutation_lease 5 >/dev/null',
        'run_mutation_lane_supervised return_with_descendant',
        'rc=$?',
        'release_production_mutation_lease',
        'exit "$rc"',
      ].join('\n'),
      fx.env,
    )
    let leaderPid: number | undefined
    try {
      assert.equal(await waitUntil(() => readFile(returned).then(() => true).catch(() => false), 5_000), true)
      assert.equal(await waitUntil(() => {
        leaderPid = stoppedChildGroupLeader(child.pid!)
        return leaderPid !== undefined
      }, 5_000), true, 'parent never reached the stopped-leader authorization phase')
      process.kill(leaderPid!, 'SIGKILL')
      assert.equal(await waitForExit(child, 12_000), true, 'leader death wedged the parent supervisor')
      assert.equal(child.exitCode, 86, `leader death must crash-stop with rc=86; signal=${child.signalCode}`)
      assert.equal(await waitUntil(() => recordedProcessesExited(descendantPids), 5_000), true, 'leader descendant survived crash-stop')
      assert.equal(await readFile(fx.laneMarker).then(() => true).catch(() => false), true, 'leader death cleared in-flight evidence')
    } finally {
      child.kill('SIGKILL')
      await killRecordedProcesses(descendantPids)
    }
  })

  test('lane leader death during exact marker clear kills the clear child and preserves evidence', async () => {
    const fx = await fixture(30)
    const clearStarted = path.join(fx.dir, 'phase2-clear-started')
    const clearPids = path.join(fx.dir, 'phase2-clear-pids')
    const child = spawnOrchestrated(
      [
        'payload_done() { return 0; }',
        'acquire_production_mutation_lease 5 >/dev/null',
        'run_mutation_lane_supervised payload_done',
        'rc=$?',
        'release_production_mutation_lease',
        'exit "$rc"',
      ].join('\n'),
      {
        ...fx.env,
        OC_TEST_STALL_LANE_CLEAR: '1',
        OC_TEST_LANE_MARKER: fx.laneMarker,
        OC_TEST_CLEAR_STARTED: clearStarted,
        OC_TEST_CLEAR_PIDS: clearPids,
      },
    )
    try {
      assert.equal(await waitUntil(() => readFile(clearStarted).then(() => true).catch(() => false), 7_000), true, 'exact marker clear never entered fake ssh')
      const [, leaderRaw] = (await readFile(clearPids, 'utf8')).trim().split(/\s+/)
      const leaderPid = Number(leaderRaw)
      assert.equal(Number.isSafeInteger(leaderPid) && leaderPid > 1, true, 'missing lane PGID leader')
      process.kill(leaderPid, 'SIGKILL')
      assert.equal(await waitForExit(child, 12_000), true, 'leader death during clear wedged the parent supervisor')
      assert.equal(child.exitCode, 86, `phase2 leader death must crash-stop with rc=86; signal=${child.signalCode}`)
      assert.equal(await waitUntil(() => recordedProcessesExited(clearPids), 5_000), true, 'marker-clear ssh child escaped the anchored PGID')
      assert.equal(await readFile(fx.laneMarker).then(() => true).catch(() => false), true, 'escaped/partial clear lost in-flight evidence')
    } finally {
      child.kill('SIGKILL')
      await killRecordedProcesses(clearPids)
    }
  })

  test('unexpected sentinel death during exact marker clear crash-stops the anchored group', async () => {
    const fx = await fixture(30)
    const clearStarted = path.join(fx.dir, 'anchor-loss-clear-started')
    const clearPids = path.join(fx.dir, 'anchor-loss-clear-pids')
    const child = spawnOrchestrated(
      [
        'payload_done() { return 0; }',
        'acquire_production_mutation_lease 5 >/dev/null',
        'run_mutation_lane_supervised payload_done',
        'rc=$?',
        'release_production_mutation_lease',
        'exit "$rc"',
      ].join('\n'),
      {
        ...fx.env,
        OC_TEST_STALL_LANE_CLEAR: '1',
        OC_TEST_LANE_MARKER: fx.laneMarker,
        OC_TEST_CLEAR_STARTED: clearStarted,
        OC_TEST_CLEAR_PIDS: clearPids,
      },
    )
    try {
      assert.equal(await waitUntil(() => readFile(clearStarted).then(() => true).catch(() => false), 7_000), true, 'exact marker clear never entered fake ssh')
      const [clearRaw, leaderRaw] = (await readFile(clearPids, 'utf8')).trim().split(/\s+/)
      const clearPid = Number(clearRaw)
      const leaderPid = Number(leaderRaw)
      const clearParent = Number(spawnSync('ps', ['-o', 'ppid=', '-p', clearRaw], { encoding: 'utf8' }).stdout.trim())
      const children = spawnSync('ps', ['-o', 'pid=,pgid=,stat=', '--ppid', leaderRaw], { encoding: 'utf8' }).stdout
        .trim().split('\n').map((line) => line.trim().split(/\s+/))
        .filter(([pid, pgid, stat]) => Number(pid) !== clearParent && Number(pgid) === leaderPid && !stat.startsWith('Z'))
        .map(([pid]) => Number(pid))
      assert.equal(Number.isSafeInteger(clearPid) && clearPid > 1, true, 'missing clear child pid')
      assert.equal(children.length, 1, `could not identify the sole live sentinel: ${children.join(',')}`)
      process.kill(children[0]!, 'SIGKILL')
      assert.equal(await waitForExit(child, 12_000), true, 'sentinel death did not wake the independent watchdog')
      assert.equal(child.exitCode, 86, `sentinel death must crash-stop with rc=86; signal=${child.signalCode}`)
      assert.equal(await waitUntil(() => recordedProcessesExited(clearPids), 5_000), true, 'watchdog left the marker-clear child alive after sentinel loss')
      assert.equal(await readFile(fx.laneMarker).then(() => true).catch(() => false), true, 'sentinel loss allowed in-flight evidence to clear')
    } finally {
      child.kill('SIGKILL')
      await killRecordedProcesses(clearPids)
    }
  })
})
