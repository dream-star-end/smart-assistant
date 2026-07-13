import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const deploy = path.join(root, 'scripts/deploy-v5.sh')
const monitor = path.join(root, 'scripts/v5-monitor.sh')
const caddy = path.join(root, 'scripts/install-v5-upstream-errors.sh')
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function run(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ALLOW_ANY_BRANCH: '1', ...env },
  })
}

describe('v5 release safety lanes', () => {
  test('ordinary deploy/dist/rollback dry-runs never require a cutover nonce', () => {
    for (const [mode, args] of [
      ['deploy', ['--dry-run']],
      ['dist', ['--dist', '--dry-run']],
      ['rollback', ['--rollback', '--dry-run']],
    ] as const) {
      const result = run(deploy, args)
      assert.equal(result.status, 0, result.stderr || result.stdout)
      assert.doesNotMatch(result.stdout + result.stderr, /缺 --cutover-nonce|manifest missing/)
      assert.match(result.stdout, new RegExp(`begin planned-maintenance schema=2 mode=${mode}`))
      assert.match(result.stdout, /end planned-maintenance schema=2 nonce=.*\(nonce-match\)/)
    }
  })

  test('ordinary deploy maintenance scope includes egress only for --egress', () => {
    const normal = run(deploy, ['--dry-run'])
    const egress = run(deploy, ['--dry-run', '--egress'])
    assert.equal(normal.status, 0, normal.stderr || normal.stdout)
    assert.equal(egress.status, 0, egress.stderr || egress.stdout)
    assert.doesNotMatch(normal.stdout, /checks=.*svc_egress/)
    assert.match(egress.stdout, /checks=svc_v5,http_v5,public_route,svc_egress,http_egress/)
  })

  test('maintenance lifecycle uses one cleanup trap and locked schema+nonce clear', async () => {
    const source = await readFile(deploy, 'utf8')
    assert.equal((source.match(/trap cleanup_deploy_process EXIT/g) ?? []).length, 1)
    assert.doesNotMatch(source, /trap 'rm -f .*DEPLOY_LOCK.*holder.*' EXIT/)
    assert.match(source, /exec 9>"\$lock"; flock -x 9/)
    assert.match(source, /\.schema == 2 and \.nonce == \$nonce/)
    assert.match(source, /PLANNED_MAINTENANCE_ACTIVE=0/)
    const recovery = source.match(/recover_cutover\(\) \{([\s\S]*?)\n\}\n\nset_cutover_maintenance/)?.[1] ?? ''
    assert.match(recovery, /flock -x 8/)
    assert.match(recovery, /\.schema == 1 and \.nonce == \$nonce/)
    assert.equal((recovery.match(/rm -f "\$marker"/g) ?? []).length, 1)
    assert.match(source, /stale\/untrusted schema1 marker preserved; deployment continues fail-open/)
    assert.match(source, /safely cleared expired schema1 marker/)
  })

  test('dangerous offline mode fails closed without one-shot nonce', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-deploy-safety-')); dirs.push(dir)
    await writeFile(path.join(dir, 'ssh'), '#!/bin/sh\necho active\n')
    await chmod(path.join(dir, 'ssh'), 0o755)
    const result = run(deploy, ['--offline-recycle', '--dry-run'], {
      PATH: `${dir}:${process.env.PATH}`,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, /缺 --cutover-nonce/)
    assert.doesNotMatch(result.stdout + result.stderr, /Docker v5 label 清理/)
  })

  test('target migration readiness is scoped to offline activation only', async () => {
    const source = await readFile(deploy, 'utf8')
    assert.match(source, /activate_staged_inner\(\)[\s\S]*assert_gpt56_migration_ready/)
    assert.match(source, /activate_staged_inner\(\)[\s\S]*install_cutover_target_image_env/)
    const deployBody = source.match(/deploy\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const distBody = source.match(/deploy_dist\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const rollbackBody = source.match(/rollback\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    for (const body of [deployBody, distBody, rollbackBody]) {
      assert.doesNotMatch(body, /assert_gpt56_migration_ready|cutover_transition/)
    }
  })

  // ── 模型权威:四面 capability 守卫(方案 §7 步 4/5,R3-B4 + R4-M2)──────────────
  //
  // 用 ssh stub 模拟 kl-mirror:preflight 的四面探测(DB/master/egress/容器 runtime)全部
  // 经 `ssh $KL_HOST <cmd>` 出口,故一个 stub 即可把"四面缺任一 → 拒绝开 flag"的矩阵实跑出来。
  // 锁走 OC_V5_DEPLOY_LOCK_FILE(hermetic,不抢真实部署锁)。
  async function maFixture(over: Record<string, string> = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-ma-')); dirs.push(dir)
    const ssh = path.join(dir, 'ssh')
    // stub 收到的是 `ssh <host> <cmd...>`;按命令特征回放各面的探测结果。
    await writeFile(
      ssh,
      [
        '#!/bin/bash',
        'cmd="$*"',
        'case "$cmd" in',
        '  *schema_migrations*) printf "%s\\n" "${MA_DB:-1}" ;;',
        '  *"/healthz"*) printf "%s\\n" "{\\"ok\\":true,\\"runtime\\":{\\"capabilities\\":[${MA_MASTER_CAPS-\\"model_authority_v1\\"}]}}" ;;',
        '  *egress-health*) printf "%s\\n" "{\\"ok\\":true,\\"role\\":\\"egress\\",\\"capabilities\\":[${MA_EGRESS_CAPS-\\"model_authority_v1-egress\\"}]}" ;;',
        '  *OC_RUNTIME_RELEASE*) printf "%s\\n" "${MA_RT_RELEASE-/var/lib/openclaude-v5/runtime-releases/rel-abc}" ;;',
        '  *OC_RUNTIME_IMAGE_ID*) printf "%s\\n" "sha256:emb" ;;',
        '  *OC_MODEL_AUTHORITY_CUTOVER*) printf "%s\\n" "${MA_CUTOVER:-}" ;;',
        '  *OC_MODEL_AUTHORITY=*) printf "%s\\n" "${MA_FLAG:-}" ;;',
        '  *MANIFEST.json*) printf "%s\\n" "${MA_RT_CAPS-model_authority_v1}" ;;',
        '  *oc.runtime.features*) printf "%s\\n" "${MA_IMG_FEATURES-v3-sink model_authority_v1}" ;;',
        '  *) printf "\\n" ;;',
        'esac',
        'exit 0',
      ].join('\n'),
    )
    await chmod(ssh, 0o755)
    return run(deploy, ['--model-authority-preflight'], {
      PATH: `${dir}:${process.env.PATH}`,
      OC_V5_DEPLOY_LOCK_FILE: path.join(dir, 'lock'),
      ...over,
    })
  }

  test('model-authority preflight passes only when all four faces declare capability', async () => {
    const green = await maFixture()
    assert.equal(green.status, 0, green.stdout + green.stderr)
    for (const line of ['✓ ① DB', '✓ ② master', '✓ ③ egress', '✓ ④ runtime']) {
      assert.ok(green.stdout.includes(line), `missing "${line}" in:\n${green.stdout}`)
    }

    // ① DB:0135 未 apply
    const noDb = await maFixture({ MA_DB: '0' })
    assert.notEqual(noDb.status, 0)
    assert.match(noDb.stdout + noDb.stderr, /① DB:迁移 0135_model_catalog 未 apply/)

    // ② master:旧版本不广播 capability
    const oldMaster = await maFixture({ MA_MASTER_CAPS: '' })
    assert.notEqual(oldMaster.status, 0)
    assert.match(oldMaster.stdout + oldMaster.stderr, /② master:\/healthz 未广播/)

    // ③ egress:旧进程无 epoch fence(deploy 默认不重启 egress —— 最易错配的一面,R4-m6)
    const oldEgress = await maFixture({ MA_EGRESS_CAPS: '' })
    assert.notEqual(oldEgress.status, 0)
    assert.match(oldEgress.stdout + oldEgress.stderr, /③ egress:未广播/)
    assert.match(oldEgress.stdout + oldEgress.stderr, /--egress/)

    // ④ 容器 runtime release 未声明
    const oldRelease = await maFixture({ MA_RT_CAPS: '' })
    assert.notEqual(oldRelease.status, 0)
    assert.match(oldRelease.stdout + oldRelease.stderr, /④ runtime release:.*未声明/)

    // ④ release 轴关闭时回落镜像 label:旧镜像(无 model_authority_v1 token)同样拒
    const oldImage = await maFixture({ MA_RT_RELEASE: '', MA_IMG_FEATURES: 'v3-sink' })
    assert.notEqual(oldImage.status, 0)
    assert.match(oldImage.stdout + oldImage.stderr, /④ runtime 镜像/)
  })

  test('step-5 compat floor is irreversible and guards every activation path', async () => {
    const source = await readFile(deploy, 'utf8')
    // 地板挂在**全部**激活/回滚路径:蓝绿 activate_release、hotcfg tuple 激活、tuple 回滚。
    for (const fn of ['activate_release', 'activate_runtime_tuple', 'rollback_runtime_tuple']) {
      const body = source.match(new RegExp(`${fn}\\(\\) \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? ''
      assert.match(body, /assert_model_authority_floor/, `${fn} 未挂兼容地板`)
    }
    // marker 探测 fail-closed:psql 失败 → 按已置位处理(不确定即拒)
    const cutoverFn = source.match(/model_authority_cutover_done\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    assert.match(cutoverFn, /fail-closed/)
    // 关 flag 在 cutover 后必须被拒(不可逆地板)
    const disableFn = source.match(/disable_model_authority\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    assert.match(disableFn, /model_authority_cutover_done/)
    assert.match(disableFn, /兼容地板不可逆/)
  })

  test('release metadata declares the 0135 migration and both authority capabilities', async () => {
    const meta = JSON.parse(await readFile(path.join(root, 'deploy/v5/release-metadata.json'), 'utf8'))
    assert.ok(meta.requiredMigrations.includes('0135_model_catalog'))
    assert.ok(meta.capabilities.includes('model_authority_v1'))
    assert.ok(meta.capabilities.includes('model_authority_v1-egress'))
    // 容器面单独一列:release MANIFEST 只声明容器实现的能力(digest 相同 ⇒ 声明相同)
    assert.deepEqual(meta.runtimeCapabilities, ['model_authority_v1'])
    // 既有 capability 不得被本批次挤掉(sessions 割接地板仍在)
    assert.ok(meta.capabilities.includes('sessions-store-pg-v1'))
  })

  test('Caddy fallback is transport-error-only and installer dry-run is inert', async () => {
    const source = await readFile(caddy, 'utf8')
    assert.match(source, /handle_errors/)
    assert.match(source, /\{err\.status_code\} in \[502, 503, 504\]/)
    assert.match(source, /application error.*418/)
    assert.match(source, /websocket failure must be non-200/)
    assert.doesNotMatch(source, /@v5_upstream_unavailable status/)
    const result = run(caddy, ['--dry-run'])
    assert.equal(result.status, 0, result.stderr)
  })
})

interface MonitorFixtureOptions {
  markerMode?: number
  checkV3?: boolean
  marker?: Record<string, unknown>
  state?: Record<string, unknown>
  egressBad?: boolean
  conditions?: boolean
  schema1Manifest?: boolean
}

function schema1Marker(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    host: spawnSync('hostname', ['-f'], { encoding: 'utf8' }).stdout.trim(),
    nonce: 'a'.repeat(32),
    deadline: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  }
}

function schema2Marker(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    schema: 2,
    host: spawnSync('hostname', ['-f'], { encoding: 'utf8' }).stdout.trim(),
    nonce: 'b'.repeat(32),
    kind: 'deploy',
    mode: 'deploy',
    target_commit: 'd'.repeat(40),
    started_at: now,
    deadline: now + 180,
    checks: ['svc_v5', 'http_v5', 'public_route'],
    ...overrides,
  }
}

async function monitorFixture(options: MonitorFixtureOptions = {}) {
  const {
    markerMode = 0o600,
    checkV3 = false,
    marker = schema1Marker(),
    state = { checks: {} },
    egressBad = false,
    conditions = false,
    schema1Manifest = true,
  } = options
  const dir = await mkdtemp(path.join(tmpdir(), 'v5-monitor-safety-')); dirs.push(dir)
  const bin = path.join(dir, 'bin'); await writeFile(path.join(dir, 'meminfo'), 'MemTotal: 1000 kB\nMemAvailable: 900 kB\n')
  await writeFile(path.join(dir, 'env'), 'OC_RUNTIME_IMAGE=test/runtime:v5\nDATABASE_URL=postgres://unused\n')
  await writeFile(path.join(dir, 'state'), JSON.stringify(state))
  await writeFile(path.join(dir, 'marker'), JSON.stringify(marker))
  await chmod(path.join(dir, 'marker'), markerMode)
  const cutoverRoot = path.join(dir, 'cutovers')
  if (marker.schema === 1 && schema1Manifest && typeof marker.nonce === 'string') {
    const bundle = path.join(cutoverRoot, marker.nonce)
    spawnSync('mkdir', ['-p', bundle])
    await chmod(cutoverRoot, 0o700)
    await chmod(bundle, 0o700)
    await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({
      schema: 1,
      host: marker.host,
      nonce: marker.nonce,
    }))
    await chmod(path.join(bundle, 'manifest.json'), 0o600)
  }
  await writeFile(path.join(dir, 'setup'), '')
  spawnSync('mkdir', ['-p', bin])
  const scripts: Record<string, string> = {
    systemctl: `#!/bin/sh\ncase "$2" in openclaude-v5${egressBad ? '|openclaude-v5-egress' : ''}) echo inactive; exit 3;; *) echo active;; esac\n`,
    curl: egressBad
      ? '#!/bin/sh\necho refused >&2; exit 7\n'
      : '#!/bin/sh\ncase "$*" in *18892*) echo \'{"ok":true,"role":"egress"}\';; *) echo refused >&2; exit 7;; esac\n',
    df: '#!/bin/sh\necho "Use%"; echo "10%"\n',
    docker: '#!/bin/sh\ncase "$1" in images) echo test/runtime:v5;; ps) :;; esac\n',
  }
  for (const [name, body] of Object.entries(scripts)) {
    await writeFile(path.join(bin, name), body); await chmod(path.join(bin, name), 0o755)
  }
  const result = run(monitor, ['--dry-run'], {
    PATH: `${bin}:${process.env.PATH}`,
    V5MON_ENV_FILE: path.join(dir, 'env'),
    V5MON_STATE_FILE: path.join(dir, 'state'),
    V5MON_LOG_FILE: path.join(dir, 'log'),
    V5MON_MEMINFO: path.join(dir, 'meminfo'),
    V5MON_MAINTENANCE_FILE: path.join(dir, 'marker'),
    V5MON_MAINTENANCE_LOCK: path.join(dir, 'maintenance.lock'),
    V5MON_CUTOVER_ROOT: cutoverRoot,
    V5MON_CHECK_V3: checkV3 ? '1' : '0',
    V5MON_CONDITIONS: conditions ? '1' : '0',
  })
  return result
}

describe('v5 monitor planned-maintenance scope', () => {
  test('monitor validates and consumes one marker snapshot under the shared lock', async () => {
    const source = await readFile(monitor, 'utf8')
    assert.match(source, /flock -n -s 7/)
    assert.match(source, /MARKER_JSON="\$\(cat "\$MAINTENANCE_FILE"/)
    assert.match(source, /<<<"\$MARKER_JSON"/)
    const markerSection = source.match(/MARKER_PRESENT=0([\s\S]*?)maintenance_suppresses\(\)/)?.[1] ?? ''
    assert.equal((markerSection.match(/cat "\$MAINTENANCE_FILE"/g) ?? []).length, 1)
  })

  test('valid marker suppresses only expected v5/public failures and v3 is off by default', async () => {
    const result = await monitorFixture()
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /PLANNED svc_v5/)
    assert.match(result.stdout, /PLANNED http_v5/)
    assert.match(result.stdout, /PLANNED public_route/)
    assert.doesNotMatch(result.stdout, /EVENT ❌ \*\*(svc_v5|http_v5|public_route)\*\*/)
    assert.doesNotMatch(result.stdout, /http_v3/)
  })

  test('invalid marker fails open and explicit v3 check is still available', async () => {
    const result = await monitorFixture({ checkV3: true, marker: schema1Marker({ schema: 3 }) })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /fail-open to normal alerts/)
    assert.match(result.stdout, /EVENT ❌ \*\*svc_v5\*\*/)
    assert.match(result.stdout, /EVENT ❌ \*\*http_v5\*\*/)
    assert.match(result.stdout, /EVENT ❌ \*\*public_route\*\*/)
    assert.match(result.stdout, /http_v3/)
  })

  test('schema1 without its trusted cutover manifest fails open', async () => {
    const result = await monitorFixture({ schema1Manifest: false })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /invalid\/expired maintenance marker; fail-open/)
    assert.match(result.stdout, /EVENT ❌ \*\*svc_v5\*\*/)
    assert.doesNotMatch(result.stdout, /PLANNED svc_v5/)
  })

  test('schema2 suppresses exactly its validated checks, including egress when requested', async () => {
    const masterOnly = await monitorFixture({ marker: schema2Marker() })
    assert.equal(masterOnly.status, 0, masterOnly.stderr)
    assert.match(masterOnly.stdout, /PLANNED svc_v5/)
    assert.match(masterOnly.stdout, /PLANNED http_v5/)
    assert.match(masterOnly.stdout, /PLANNED public_route/)

    const withEgress = await monitorFixture({
      egressBad: true,
      marker: schema2Marker({
        checks: ['svc_v5', 'http_v5', 'public_route', 'svc_egress', 'http_egress'],
      }),
    })
    assert.equal(withEgress.status, 0, withEgress.stderr)
    assert.match(withEgress.stdout, /PLANNED svc_egress/)
    assert.match(withEgress.stdout, /PLANNED http_egress/)
    assert.doesNotMatch(withEgress.stdout, /EVENT ❌ \*\*(svc_egress|http_egress)\*\*/)
  })

  test('schema2 invalid TTL, duplicate scope, or invalid mode fails open', async () => {
    const now = Math.floor(Date.now() / 1000)
    for (const marker of [
      schema2Marker({ started_at: now, deadline: now + 181 }),
      schema2Marker({ checks: ['svc_v5', 'svc_v5'] }),
      schema2Marker({ mode: 'offline-recycle' }),
    ]) {
      const result = await monitorFixture({ marker })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /invalid\/expired maintenance marker; fail-open/)
      assert.match(result.stdout, /EVENT ❌ \*\*svc_v5\*\*/)
    }
  })

  test('pre-existing bad state is never hidden by a valid deployment marker', async () => {
    const now = Math.floor(Date.now() / 1000)
    const result = await monitorFixture({
      marker: schema2Marker(),
      state: { checks: { svc_v5: { status: 'bad', since: now - 600, last_alert: 0 } } },
      conditions: true,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout, /PLANNED svc_v5/)
    assert.match(result.stdout, /EVENT ⏰ \*\*svc_v5\*\* 仍异常/)
    assert.match(result.stdout, /write_alert_condition\('ops\.monitor:svc_v5','probe',true/)
    const source = await readFile(monitor, 'utf8')
    assert.match(source, /maintenance_nonce:\$nonce/)
  })

  test('planned state becomes an immediate real alert after marker expiry', async () => {
    const now = Math.floor(Date.now() / 1000)
    const result = await monitorFixture({
      marker: schema2Marker({ started_at: now - 200, deadline: now - 20 }),
      state: {
        checks: {
          svc_v5: {
            status: 'planned',
            since: 0,
            last_alert: 0,
            maintenance_nonce: 'b'.repeat(32),
          },
        },
      },
      conditions: true,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /invalid\/expired maintenance marker; fail-open/)
    assert.match(result.stdout, /EVENT ❌ \*\*svc_v5\*\*/)
    assert.match(result.stdout, /write_alert_condition\('ops\.monitor:svc_v5','probe',true/)
  })
})
