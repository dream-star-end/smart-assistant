import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const caddyApply = path.join(root, 'scripts/v5-caddy-apply.sh')
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function run(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const childEnv = { ...process.env, ALLOW_ANY_BRANCH: '1', ...env }
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[key]
  }
  return spawnSync('bash', [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: childEnv,
  })
}

async function caddyRemoteFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'v5-caddy-port-')); dirs.push(dir)
  const bin = path.join(dir, 'bin'); await mkdir(bin)
  const sshLog = path.join(dir, 'ssh.log')
  const sshStdinLog = path.join(dir, 'ssh.stdin.log')
  const scpLog = path.join(dir, 'scp.log')
  await writeFile(path.join(bin, 'ssh'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >>"$FAKE_SSH_LOG"',
    'if [ "${2:-}" = bash ] && [ "${3:-}" = -s ]; then',
    '  cat >"$FAKE_SSH_STDIN_LOG"',
    '  printf "SET:%s:svc_v5 http_v5 public_route\\n" "${9:-}"',
    '  exit 0',
    'fi',
    'case "$*" in',
    '  *psql*) cat >/dev/null; printf "%s\\n" "$FAKE_DS_ROW" ;;',
    '  *Cookie:*) printf "%s\\n" \'{"ok":true,"slot":"B"}\' ;;',
    '  *curl*) printf "%s\\n" \'{"ok":true,"slot":"A"}\' ;;',
    'esac',
  ].join('\n') + '\n')
  await writeFile(path.join(bin, 'scp'), '#!/bin/sh\nprintf "%s\\n" "$*" >>"$FAKE_SCP_LOG"\n')
  await chmod(path.join(bin, 'ssh'), 0o755)
  await chmod(path.join(bin, 'scp'), 0o755)
  return {
    dir,
    sshLog,
    sshStdinLog,
    scpLog,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      KL_HOST: 'fake-v5',
      FAKE_SSH_LOG: sshLog,
      FAKE_SSH_STDIN_LOG: sshStdinLog,
      FAKE_SCP_LOG: scpLog,
    } satisfies NodeJS.ProcessEnv,
  }
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

  test('requiredMigrations gate includes deploy_state and precedes every write dispatch', async () => {
    const metadata = JSON.parse(await readFile(path.join(root, 'deploy/v5/release-metadata.json'), 'utf8')) as {
      requiredMigrations: string[]
    }
    assert.ok(metadata.requiredMigrations.includes('0135_deploy_state'))
    const source = await readFile(deploy, 'utf8')
    const gateAt = source.indexOf('assert_repo_required_migrations || exit 1')
    const dispatchAt = source.indexOf('case "$MODE" in', gateAt)
    assert.ok(gateAt > 0 && dispatchAt > gateAt, '统一迁移门必须在模式 dispatch 前')
    assert.match(source, /activate_release\(\)[\s\S]*assert_release_required_migrations "\$reldir"/)
    assert.match(source, /rollback_runtime_tuple\(\)[\s\S]*assert_release_required_migrations "\$master"/)

    const dry = run(deploy, ['--dry-run'])
    assert.equal(dry.status, 0, dry.stderr || dry.stdout)
    const combined = dry.stdout + dry.stderr
    assert.ok(combined.indexOf('校验 requiredMigrations 已全部记录') < combined.indexOf('建 release'))
  })

  test('requiredMigrations remote failure stays fail-closed in production OR-list context', () => {
    const harness = [
      'set -u',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'ssh() { return 23; }',
      'assert_repo_required_migrations || exit 1',
      'printf "%s\\n" SIDE_EFFECT',
    ].join('\n')
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1' },
    })
    const combined = result.stdout + result.stderr
    assert.notEqual(result.status, 0)
    assert.match(combined, /requiredMigrations 远端校验失败/)
    assert.doesNotMatch(combined, /requiredMigrations 已应用/)
    assert.doesNotMatch(combined, /SIDE_EFFECT/)
  })

  test('finalize/abort verify the target before irreversible state changes', async () => {
    const source = await readFile(deploy, 'utf8')
    const finalizeBody = source.match(/finalize_run_steps\(\) \{([\s\S]*?)\n\}\n\n# ═+ lane: --abort/)?.[1] ?? ''
    const expectedAt = finalizeBody.indexOf('candidate release oc-build 权威')
    const smokeAt = finalizeBody.indexOf('提交 stable 前完整 smoke')
    const stopAt = finalizeBody.indexOf('systemctl stop $(slot_unit "$old")')
    const commitAt = finalizeBody.indexOf("active_slot='$cand', previous_active_release=active_release")
    assert.ok(expectedAt >= 0 && smokeAt > expectedAt, 'finalize 必须从 candidate release 建立 build 权威')
    assert.ok(stopAt > smokeAt && commitAt > smokeAt, '完整 smoke/版本握手必须早于 stop old 与 stable commit')
    assert.doesNotMatch(finalizeBody, /dist_handshake_smoke[^\n]*\|\| true/)
    assert.doesNotMatch(
      finalizeBody,
      /phase='aborting'[^\n]*desired_leader_slot/,
      'finalize 补偿必须先仅切 aborting，让 abort_continue 先回 Caddy 再收 desired',
    )

    const abortBody = source.match(/abort_continue\(\) \{([\s\S]*?)\n\}\n\n# ═+ --recover/)?.[1] ?? ''
    const abortSmokeAt = abortBody.indexOf('旧 slot($old)完整 smoke')
    const abortStopAt = abortBody.indexOf('systemctl stop $(slot_unit "$cand")')
    const abortCommitAt = abortBody.indexOf("phase='stable', candidate_slot=NULL")
    assert.ok(abortSmokeAt >= 0 && abortStopAt > abortSmokeAt && abortCommitAt > abortSmokeAt)
    assert.doesNotMatch(abortBody, /smoke[^\n]*\|\| echo/)

    const smokeBody = source.match(/smoke\(\) \{([\s\S]*?)\n\}\n\n# ─+ bootstrap/)?.[1] ?? ''
    assert.match(smokeBody, /\[\[ "\$leadership" == leader \]\]/)
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
        'stdin="$(cat)"',
        'if [[ "$stdin" == *"FROM deploy_state"* ]]; then',
        '  printf "%s\\n" "${MA_DS_ROW:-1|stable|A||/rel/a||A|A|0|salt|0||1|}"',
        '  exit 0',
        'fi',
        'case "$cmd" in',
        '  *schema_migrations*) printf "%s\\n" "${MA_DB_READY:-true}" ;;',
        "  *\"name='DATABASE_URL'\"*) printf \"%s\\\\n\" \"openclaude_app|${MA_APP_ROLE_READY:-true}\" ;;",
        "  *\"name='MODEL_CATALOG_ADMIN_DATABASE_URL'\"*) printf \"%s\\\\n\" \"openclaude_model_admin|${MA_ADMIN_ROLE_READY:-true}\" ;;",
        "  *\"name='MODEL_AUTHORITY_DEPLOY_DATABASE_URL'\"*) printf \"%s\\\\n\" \"openclaude_model_deploy|${MA_DEPLOY_ROLE_READY:-true}\" ;;",
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

    // ① DB:catalog + guards 任一迁移/关键对象未就绪
    const noDb = await maFixture({ MA_DB_READY: 'false' })
    assert.notEqual(noDb.status, 0)
    assert.match(noDb.stdout + noDb.stderr, /① DB:.*0143_model_catalog.*0144_model_authority_guards/)

    // ① DB 还必须证明 app/admin/deploy 三个独立角色的最小权限边界。
    const badAppRole = await maFixture({ MA_APP_ROLE_READY: 'false' })
    assert.notEqual(badAppRole.status, 0)
    assert.match(badAppRole.stdout + badAppRole.stderr, /① DB:/)

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
    // 地板挂在**全部**激活/回滚路径:传统激活、hotcfg tuple、tuple 回滚、P3 candidate。
    for (const fn of ['activate_release', 'activate_runtime_tuple', 'rollback_runtime_tuple', 'canary']) {
      const body = source.match(new RegExp(`(?:^|\\n)${fn}\\(\\) \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? ''
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

  test('model-authority operations pin the stable P3 active lane', async () => {
    const source = await readFile(deploy, 'utf8')
    const egressUnit = await readFile(path.join(root, 'deploy/v5/openclaude-v5-egress.service'), 'utf8')
    const preflight = source.match(/model_authority_preflight\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    assert.match(preflight, /assert_no_rollout_in_progress/)
    assert.match(preflight, /ACTIVE_PORT/)
    assert.doesNotMatch(preflight, /\$\{?V5_PORT\}?/)

    const enable = source.match(/enable_model_authority\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const enableSeed = source.match(/enable_seed_authority_by_rev\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const disable = source.match(/disable_model_authority\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    assert.match(enable, /systemctl restart '\$ACTIVE_UNIT'/)
    assert.match(enable, /smoke "\$ACTIVE_PORT"/)
    assert.match(enableSeed, /assert_no_rollout_in_progress/)
    assert.match(enableSeed, /systemctl restart '\$ACTIVE_UNIT'/)
    assert.doesNotMatch(enableSeed, /systemctl restart '\$V5_UNIT'/)
    assert.match(enableSeed, /cd '\$ACTIVE_SRC'/)
    assert.doesNotMatch(enableSeed, /cd '\$REMOTE_SRC'/)
    assert.match(enableSeed, /smoke "\$ACTIVE_PORT"/)
    assert.match(disable, /rollback_model_authority_before_cutover/)

    const activeB = await maFixture({
      MA_DS_ROW: '2|stable|B||/rel/b||B|B|0|salt|0||2|/rel/a',
    })
    assert.equal(activeB.status, 0, activeB.stdout + activeB.stderr)
    assert.match(activeB.stdout, /active lane:slot=B.*port=18795/)

    const rollout = await maFixture({
      MA_DS_ROW: '3|canary|A|B|/rel/a|/rel/b|A|A|10|salt|10|op|3|',
    })
    assert.notEqual(rollout.status, 0)
    assert.match(rollout.stdout + rollout.stderr, /cohort rollout\/候选状态未收敛/)

    // egress 是全局单实例：不得再永久从 slot A 工作目录启动。普通 --egress 必须把
    // 独立指针钉到本次 BUILT_RELEASE，并具备 cwd/capability 活体验证与旧 release 回切。
    assert.match(egressUnit, /^WorkingDirectory=\/opt\/openclaude\/openclaude-v5-egress$/m)
    assert.doesNotMatch(egressUnit, /^WorkingDirectory=\/opt\/openclaude\/openclaude-v5$/m)
    const egressStart = source.indexOf('egress_release_ready_once()')
    const deployStart = source.indexOf('\ndeploy()', egressStart)
    const egressActivate = source.slice(egressStart, deployStart)
    const deployEnd = source.indexOf('\n# ───────────────────────── offline recycle', deployStart)
    const deployBody = source.slice(deployStart, deployEnd)
    assert.ok(egressStart >= 0 && deployStart > egressStart)
    assert.match(egressActivate, /mv -T '\$tmplink' '\$V5_EGRESS_SRC'/)
    assert.match(egressActivate, /readlink -f .*\/proc\/.*pid.*\/cwd/)
    assert.match(egressActivate, /MODEL_AUTHORITY_EGRESS_CAP/)
    assert.match(egressActivate, /ln -s '\$prev' '\$tmplink'/)
    assert.match(egressActivate, /wait_for_egress_release_ready "\$reldir" "\$require_cap" 30/)
    assert.match(egressActivate, /wait_for_egress_release_ready "\$prev" 0 30/)
    assert.doesNotMatch(egressActivate, /run "sleep 3"/)
    assert.match(deployBody, /egress_prev_release=.*systemctl show -p MainPID/)
    assert.match(deployBody, /activate_egress_release "\$BUILT_RELEASE" "\$egress_prev_release"/)
    assert.doesNotMatch(deployBody, /systemctl restart openclaude-v5-egress/)
  })

  test('egress release readiness tolerates delayed startup and has a hard deadline', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-egress-ready-')); dirs.push(dir)
    const bin = path.join(dir, 'bin'); await mkdir(bin)
    const counter = path.join(dir, 'counter'); await writeFile(counter, '0')
    await writeFile(path.join(bin, 'ssh'), [
      '#!/bin/sh',
      'if [ "${SLOW_PROBE:-0}" = 1 ]; then sleep 3; exit 1; fi',
      'n=$(cat "$COUNTER"); n=$((n+1)); printf "%s" "$n" >"$COUNTER"',
      'state=active; pid=4321; cwd="$EXPECTED_RELEASE"',
      'health=\'{"ok":true,"role":"egress","capabilities":["model_authority_v1-egress"]}\'',
      'case "$n" in',
      '  1) state=activating; pid=0; cwd=""; health="" ;;',
      '  2) cwd=/release/wrong ;;',
      '  3) health=\'{"ok":true,"role":"egress","capabilities":[]}\' ;;',
      'esac',
      'printf "%s\\n%s\\n%s\\n" "$state" "$pid" "$cwd"',
      'printf "%s" "$health" | base64 -w0',
      'printf "\\n"',
    ].join('\n') + '\n')
    await chmod(path.join(bin, 'ssh'), 0o755)

    const delayed = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'sleep() { :; }',
      'wait_for_egress_release_ready "$EXPECTED_RELEASE" 1 5',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ALLOW_ANY_BRANCH: '1',
        PATH: `${bin}:${process.env.PATH}`,
        COUNTER: counter,
        EXPECTED_RELEASE: '/release/new',
      },
    })
    assert.equal(delayed.status, 0, delayed.stderr || delayed.stdout)
    assert.equal(await readFile(counter, 'utf8'), '4')
    assert.match(delayed.stdout, /egress ready\(state=active pid=4321 cwd=\/release\/new\)/)

    const started = Date.now()
    const timedOut = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'wait_for_egress_release_ready /release/new 1 1',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ALLOW_ANY_BRANCH: '1',
        PATH: `${bin}:${process.env.PATH}`,
        COUNTER: counter,
        EXPECTED_RELEASE: '/release/new',
        SLOW_PROBE: '1',
      },
    })
    const elapsed = Date.now() - started
    assert.notEqual(timedOut.status, 0)
    assert.ok(elapsed < 2500, `one-second egress deadline took ${elapsed}ms`)
    assert.match(timedOut.stderr, /last state=<empty> pid=<empty> cwd=<empty>/)
    assert.match(timedOut.stderr, /last egress health: <empty>/)
  })

  test('runtime release finalization propagates the full pinned capability list and rejects invalid metadata', async () => {
    async function runBuild(runtimeCapabilities: unknown) {
      const dir = await mkdtemp(path.join(tmpdir(), 'v5-runtime-caps-')); dirs.push(dir)
      const capture = path.join(dir, 'finalize.args')
      await writeFile(capture, '')
      const harness = [
        'set -euo pipefail',
        'export V5_DEPLOY_SOURCE_ONLY=1',
        `source '${deploy}'`,
        'DRY=0',
        'git() {',
        '  case "$*" in',
        '    *"rev-parse HEAD"*) printf "%s\\n" pinned-commit ;;',
        '    *"show pinned-commit:deploy/v5/release-metadata.json"*) printf "%s\\n" "$PINNED_METADATA" ;;',
        '    *"archive --format=tar pinned-commit"*) : ;;',
        '    *) return 97 ;;',
        '  esac',
        '}',
        'hotcfg_ship_lib() { :; }',
        'ssh() {',
        '  case "$*" in',
        '    *"grep \'^OC_RUNTIME_IMAGE=\'"*) printf "%s\\n" runtime:test ;;',
        '    *"docker image inspect"*) printf "%s\\n" sha256:test ;;',
        '    *"grep \'^OC_RUNTIME_RELEASE=\'"*) printf "%s\\n" /runtime/prev ;;',
        '    *) cat >/dev/null || true ;;',
        '  esac',
        '}',
        'hotcfg_rmt() { printf "%s\\n" "$@" >"$CAPTURE"; printf "%s\\n" "$OC_HOTCFG_RELEASES_ROOT/rel-test"; }',
        'build_runtime_release',
      ].join('\n')
      const result = spawnSync('bash', ['-c', harness], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ALLOW_ANY_BRANCH: '1',
          CAPTURE: capture,
          PINNED_METADATA: JSON.stringify({ runtimeCapabilities }),
        },
      })
      return {
        result,
        args: (await readFile(capture, 'utf8')).trim().split('\n').filter(Boolean),
      }
    }

    const valid = await runBuild(['model_authority_v1', 'future.runtime-cap'])
    assert.equal(valid.result.status, 0, valid.result.stderr || valid.result.stdout)
    assert.equal(valid.args[0], 'oc_hotcfg_finalize_release')
    assert.equal(valid.args[5], 'model_authority_v1 future.runtime-cap')

    for (const invalid of [
      'model_authority_v1',
      ['model_authority_v1', 'model_authority_v1'],
      ['future.runtime-cap'],
      ['model_authority_v1', 'bad token'],
    ]) {
      const rejected = await runBuild(invalid)
      assert.notEqual(rejected.result.status, 0, rejected.result.stdout + rejected.result.stderr)
      assert.deepEqual(rejected.args, [], 'invalid metadata must fail before finalize')
      assert.match(rejected.result.stderr, /runtimeCapabilities 非法或缺/)
    }
  })

  test('release metadata declares both authority migrations and both authority capabilities', async () => {
    const meta = JSON.parse(await readFile(path.join(root, 'deploy/v5/release-metadata.json'), 'utf8'))
    const source = await readFile(deploy, 'utf8')
    const buildRuntimeStart = source.indexOf('build_runtime_release()')
    const buildRuntimeEnd = source.indexOf('\n# ── 3. activate_runtime_tuple', buildRuntimeStart)
    assert.ok(meta.requiredMigrations.includes('0143_model_catalog'))
    assert.ok(meta.requiredMigrations.includes('0144_model_authority_guards'))
    assert.ok(meta.capabilities.includes('model_authority_v1'))
    assert.ok(meta.capabilities.includes('model_authority_v1-egress'))
    // 容器面单独一列:release MANIFEST 只声明容器实现的能力(digest 相同 ⇒ 声明相同)
    assert.deepEqual(meta.runtimeCapabilities, ['model_authority_v1'])
    assert.ok(buildRuntimeStart >= 0 && buildRuntimeEnd > buildRuntimeStart)
    assert.match(
      source.slice(buildRuntimeStart, buildRuntimeEnd),
      /oc_hotcfg_finalize_release "\$staging" "\$RUNTIME_IMAGE_ID" "\$full_sha" "\$\{prev:-\}" "\$runtime_caps"/,
    )
    // 既有 capability 不得被本批次挤掉(sessions 割接地板仍在)
    assert.ok(meta.capabilities.includes('sessions-store-pg-v1'))
  })

  test('model-authority readiness tolerates startup delay, rejects PID churn, and has a hard deadline', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-ma-ready-')); dirs.push(dir)
    const bin = path.join(dir, 'bin'); await mkdir(bin)
    const counter = path.join(dir, 'counter'); await writeFile(counter, '0')
    await writeFile(path.join(bin, 'ssh'), [
      '#!/bin/sh',
      'if [ "${SLOW_PROBE:-0}" = 1 ]; then sleep 3; exit 1; fi',
      'n=$(cat "$COUNTER"); n=$((n+1)); printf "%s" "$n" >"$COUNTER"',
      'master_health=$(printf %s \'{"ok":true,"runtime":{"leadership":{"state":"leader"}},"sessionsDb":"ok"}\' | base64 -w0)',
      'egress_health=$(printf %s \'{"ok":true,"role":"egress","modelAuthority":{"enforced":true}}\' | base64 -w0)',
      'case "$PROBE_MODE" in',
      '  master-delayed)',
      '    if [ "$n" -eq 1 ]; then printf "activating\\n0\\n\\n\\n\\n\\nactivating\\n0\\n"',
      '    elif [ "$n" -eq 2 ]; then printf "active\\n4321\\n1\\n1\\n0\\n%s\\nactive\\n4322\\n" "$master_health"',
      '    else printf "active\\n4321\\n1\\n1\\n0\\n%s\\nactive\\n4321\\n" "$master_health"; fi ;;',
      '  master-churn) printf "active\\n4321\\n1\\n1\\n0\\n%s\\nactive\\n4322\\n" "$master_health" ;;',
      '  master-invalid) printf "inactive\\n0\\n1\\n1\\n0\\n%s\\ninactive\\n0\\n" "$master_health" ;;',
      '  egress-delayed)',
      '    if [ "$n" -eq 1 ]; then printf "activating\\n0\\n\\nactivating\\n0\\n"',
      '    elif [ "$n" -eq 2 ]; then printf "active\\n5321\\n%s\\nactive\\n5322\\n" "$egress_health"',
      '    else printf "active\\n5321\\n%s\\nactive\\n5321\\n" "$egress_health"; fi ;;',
      '  egress-churn) printf "active\\n5321\\n%s\\nactive\\n5322\\n" "$egress_health" ;;',
      '  egress-invalid) printf "inactive\\n0\\n%s\\ninactive\\n0\\n" "$egress_health" ;;',
      '  *) exit 2 ;;',
      'esac',
    ].join('\n') + '\n')
    await chmod(path.join(bin, 'ssh'), 0o755)

    async function runProbe(body: string, mode: string, slow = false) {
      await writeFile(counter, '0')
      return spawnSync('bash', ['-c', [
        'export V5_DEPLOY_SOURCE_ONLY=1',
        `source '${deploy}'`,
        body,
      ].join('\n')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          ALLOW_ANY_BRANCH: '1',
          PATH: `${bin}:${process.env.PATH}`,
          KL_HOST: 'fake-v5',
          COUNTER: counter,
          PROBE_MODE: mode,
          SLOW_PROBE: slow ? '1' : '0',
        },
      })
    }

    const masterDelayed = await runProbe(
      'sleep() { :; }; wait_for_model_authority_master_ready openclaude-v5.service 1 1 - 5',
      'master-delayed',
    )
    assert.equal(masterDelayed.status, 0, masterDelayed.stderr || masterDelayed.stdout)
    assert.equal(await readFile(counter, 'utf8'), '3')
    assert.match(masterDelayed.stdout, /master ready\(pid=4321 authority=1 provision=1 seed=-\)/)

    for (const mode of ['master-churn', 'master-invalid']) {
      const rejected = await runProbe(
        'model_authority_master_ready_once openclaude-v5.service 1 1 - 2',
        mode,
      )
      assert.notEqual(rejected.status, 0, `${mode} must be rejected`)
    }

    const egressDelayed = await runProbe(
      'sleep() { :; }; wait_for_model_authority_egress_ready true 5',
      'egress-delayed',
    )
    assert.equal(egressDelayed.status, 0, egressDelayed.stderr || egressDelayed.stdout)
    assert.equal(await readFile(counter, 'utf8'), '3')
    assert.match(egressDelayed.stdout, /egress authority ready\(pid=5321 enforced=true\)/)

    for (const mode of ['egress-churn', 'egress-invalid']) {
      const rejected = await runProbe('model_authority_egress_ready_once true 2', mode)
      assert.notEqual(rejected.status, 0, `${mode} must be rejected`)
    }

    for (const [body, mode] of [
      ['wait_for_model_authority_master_ready openclaude-v5.service 1 1 - 1', 'master-delayed'],
      ['wait_for_model_authority_egress_ready true 1', 'egress-delayed'],
    ] as const) {
      const started = Date.now()
      const timedOut = await runProbe(body, mode, true)
      const elapsed = Date.now() - started
      assert.notEqual(timedOut.status, 0)
      assert.ok(elapsed < 2500, `one-second ${mode} deadline took ${elapsed}ms`)
    }
  })

  test('authority enable is fail-closed: egress enforces before master starts signing', async () => {
    const source = await readFile(deploy, 'utf8')
    const body = source.match(/enable_model_authority\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const egressRestart = body.indexOf("systemctl restart '$V5_EGRESS_UNIT'")
    const enforceProbe = body.indexOf('wait_for_model_authority_egress_ready true')
    const masterRestart = body.indexOf("systemctl restart '$ACTIVE_UNIT'")
    assert.ok(egressRestart >= 0, 'enable must restart egress')
    assert.ok(enforceProbe > egressRestart, 'enable must probe egress enforced=true after restart')
    assert.ok(masterRestart > enforceProbe, 'master may sign only after egress is enforcing')
  })

  test('authority enable readiness failures take the correct verified rollback path', async () => {
    async function enableHarness(failAt: 'egress-true' | 'master-ready') {
      const dir = await mkdtemp(path.join(tmpdir(), 'v5-ma-enable-')); dirs.push(dir)
      const log = path.join(dir, 'order.log')
      const body = [
        'set -u',
        'export V5_DEPLOY_SOURCE_ONLY=1',
        `source '${deploy}'`,
        'ACTIVE_UNIT=openclaude-v5.service; ACTIVE_PORT=18790',
        'record() { printf "%s\\n" "$1" >>"$ORDER_LOG"; }',
        'model_authority_preflight() { record preflight; return 0; }',
        'install_model_authority_canary() { record canary; return 0; }',
        'remote_env_set() { record "env:$1=$2"; return 0; }',
        'ssh() { record "ssh:$*"; return 0; }',
        'wait_for_model_authority_egress_ready() { record "egress-ready:$1"; [[ ! ( "$FAIL_AT" == egress-true && "$1" == true ) ]]; }',
        'wait_for_model_authority_master_ready() { record "master-ready:$2/$3/$4"; [[ "$FAIL_AT" != master-ready ]]; }',
        'rollback_model_authority_before_cutover() { record "full-rollback:$1"; return 0; }',
        'model_authority_rollback_diagnostics() { record "diagnostic:$1"; }',
        'smoke() { record smoke; return 0; }',
        'start_model_authority_observation() { record observation; return 0; }',
        'enable_model_authority',
      ].join('\n')
      const result = spawnSync('bash', ['-c', body], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ALLOW_ANY_BRANCH: '1', KL_HOST: 'fake-v5', ORDER_LOG: log, FAIL_AT: failAt },
      })
      return { result, order: (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean) }
    }

    const egressFailure = await enableHarness('egress-true')
    assert.notEqual(egressFailure.result.status, 0)
    assert.match(
      egressFailure.order.join('\n'),
      /openclaude-v5-egress[\s\S]*egress-ready:true[\s\S]*env:OC_MODEL_AUTHORITY=0[\s\S]*openclaude-v5-egress[\s\S]*egress-ready:false/,
    )
    assert.equal(egressFailure.order.some((line) => line.includes("restart 'openclaude-v5.service'")), false)

    const masterFailure = await enableHarness('master-ready')
    assert.notEqual(masterFailure.result.status, 0)
    assert.match(
      masterFailure.order.join('\n'),
      /egress-ready:true[\s\S]*restart 'openclaude-v5.service'[\s\S]*master-ready:1\/1\/-[\s\S]*full-rollback:post-enable master readiness failed/,
    )
    assert.doesNotMatch(masterFailure.order.join('\n'), /smoke|observation/)
  })

  async function modelAuthorityRollbackHarness(fail = '') {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-ma-rollback-')); dirs.push(dir)
    const log = path.join(dir, 'order.log')
    const body = [
      'set -u',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'ACTIVE_SLOT=A; ACTIVE_UNIT=openclaude-v5.service; ACTIVE_PORT=18790; ACTIVE_SRC=/rel/a',
      'authority_flag=1',
      'record() { printf "%s\\n" "$1" >>"$ORDER_LOG"; }',
      'assert_no_rollout_in_progress() { record stable; return 0; }',
      'remote_env_get() { [[ "$1" == "$MODEL_AUTHORITY_FLAG_KEY" ]] && printf "%s\\n" "$authority_flag"; }',
      'remote_env_set() { record "env:$1=$2"; [[ "$FAIL_AT" != "env:$1=$2" ]] || return 1; [[ "$1" == "$MODEL_AUTHORITY_FLAG_KEY" ]] && authority_flag="$2"; return 0; }',
      'ssh() {',
      '  record "ssh:$*"',
      '  if [[ "$*" == *"restart \'$ACTIVE_UNIT\'"* && "$FAIL_AT" == master_first && "$(grep -c "restart \'$ACTIVE_UNIT\'" "$ORDER_LOG")" == 1 ]]; then return 1; fi',
      '  return 0',
      '}',
      'wait_for_model_authority_master_ready() { record "master-ready:$2/$3/$4"; [[ "$FAIL_AT" != "master-ready:$2/$3/$4" ]]; }',
      'run_model_authority_container_rollback() { record census; [[ "$FAIL_AT" != census ]]; }',
      'wait_for_model_authority_egress_ready() { record "egress-ready:$1"; [[ "$FAIL_AT" != "egress-ready:$1" ]]; }',
      'smoke() { record smoke; [[ "$FAIL_AT" != smoke ]]; }',
      'model_authority_rollback_diagnostics() { record "diagnostic:$1"; }',
      'rollback_model_authority_before_cutover test',
    ].join('\n')
    const result = spawnSync('bash', ['-c', body], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', KL_HOST: 'fake-v5', ORDER_LOG: log, FAIL_AT: fail },
    })
    return { result, order: (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean) }
  }

  test('authority rollback behavior is provision-stop → census → master-first → egress, with full smoke', async () => {
    const { result, order } = await modelAuthorityRollbackHarness()
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const expected = [
      'stable',
      'env:OC_MODEL_AUTHORITY_PROVISION_REQUIRED=0',
      "ssh:fake-v5 systemctl restart 'openclaude-v5.service'",
      'master-ready:1/0/-',
      'census',
      'env:OC_MODEL_AUTHORITY=0',
      "ssh:fake-v5 systemctl restart 'openclaude-v5.service'",
      'master-ready:0/0/-',
      "ssh:fake-v5 systemctl restart 'openclaude-v5-egress.service'",
      'egress-ready:false',
      'smoke',
    ]
    assert.deepEqual(order, expected)
  })

  test('authority rollback short-circuits safely on env/master/census/smoke failures', async () => {
    const envFail = await modelAuthorityRollbackHarness('env:OC_MODEL_AUTHORITY=0')
    assert.notEqual(envFail.result.status, 0)
    const flagWrite = envFail.order.indexOf('env:OC_MODEL_AUTHORITY=0')
    assert.ok(flagWrite >= 0)
    assert.equal(envFail.order.slice(flagWrite + 1).some((v) => v.includes('restart')), false)

    const masterFail = await modelAuthorityRollbackHarness('master_first')
    assert.notEqual(masterFail.result.status, 0)
    assert.doesNotMatch(masterFail.order.join('\n'), /census|OC_MODEL_AUTHORITY=0|egress:false/)

    const masterReadinessFail = await modelAuthorityRollbackHarness('master-ready:1/0/-')
    assert.notEqual(masterReadinessFail.result.status, 0)
    assert.doesNotMatch(masterReadinessFail.order.join('\n'), /census|OC_MODEL_AUTHORITY=0|egress-ready:false/)

    const censusFail = await modelAuthorityRollbackHarness('census')
    assert.notEqual(censusFail.result.status, 0)
    assert.doesNotMatch(censusFail.order.join('\n'), /env:OC_MODEL_AUTHORITY=0|egress:false/)

    const smokeFail = await modelAuthorityRollbackHarness('smoke')
    assert.notEqual(smokeFail.result.status, 0)
    assert.match(smokeFail.order.join('\n'), /egress-ready:false[\s\S]*smoke[\s\S]*diagnostic:/)
  })

  test('authority rollback is resumable after flag0 when egress recovery previously failed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-ma-resume-')); dirs.push(dir)
    const log = path.join(dir, 'order.log')
    const body = [
      'set -u',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'ACTIVE_SLOT=A; ACTIVE_UNIT=openclaude-v5.service; ACTIVE_PORT=18790; ACTIVE_SRC=/rel/a',
      'authority_flag=1; egress_fail=1',
      'record() { printf "%s\\n" "$1" >>"$ORDER_LOG"; }',
      'assert_no_rollout_in_progress() { return 0; }',
      'remote_env_get() { printf "%s\\n" "$authority_flag"; }',
      'remote_env_set() { record "env:$1=$2"; [[ "$1" == "$MODEL_AUTHORITY_FLAG_KEY" ]] && authority_flag="$2"; return 0; }',
      'ssh() { record "ssh:$*"; if [[ "$*" == *"restart \'$V5_EGRESS_UNIT\'"* && "$egress_fail" == 1 ]]; then return 1; fi; return 0; }',
      'wait_for_model_authority_master_ready() { record "master-ready:$2/$3/$4"; [[ "$authority_flag" == "$2" ]]; }',
      'run_model_authority_container_rollback() { record census; return 0; }',
      'wait_for_model_authority_egress_ready() { record "egress-ready:$1"; return 0; }',
      'smoke() { record smoke; return 0; }',
      'model_authority_rollback_diagnostics() { record "diagnostic:$1"; }',
      'rollback_model_authority_before_cutover first || true',
      'record retry',
      'egress_fail=0',
      'rollback_model_authority_before_cutover retry',
    ].join('\n')
    const result = spawnSync('bash', ['-c', body], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', KL_HOST: 'fake-v5', ORDER_LOG: log },
    })
    const order = (await readFile(log, 'utf8')).trim().split('\n')
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const retryAt = order.indexOf('retry')
    const retried = order.slice(retryAt + 1).join('\n')
    assert.match(retried, /master-ready:0\/0\/-[\s\S]*census[\s\S]*openclaude-v5-egress[\s\S]*egress-ready:false[\s\S]*smoke/)
    assert.doesNotMatch(retried, /master-ready:1\/0\/-/)
  })

  test('seed authority failures compensate commit-unknown writes and verify live seed=0', async () => {
    async function seedHarness(failAt: 'write-unknown' | 'seed-ready' | 'comp-ready' | 'evidence-read') {
      const dir = await mkdtemp(path.join(tmpdir(), 'v5-ma-seed-')); dirs.push(dir)
      const log = path.join(dir, 'order.log')
      const body = [
        'set -u',
        'export V5_DEPLOY_SOURCE_ONLY=1',
        `source '${deploy}'`,
        'ACTIVE_UNIT=openclaude-v5.service; ACTIVE_PORT=18790; ACTIVE_SRC=/rel/a',
        'OC_HOTCFG_PLATFORM_ROOT=/platform; seed_state=0',
        'record() { printf "%s\\n" "$1" >>"$ORDER_LOG"; }',
        'assert_no_rollout_in_progress() { record stable; return 0; }',
        'remote_env_get() { case "$1" in OC_PLATFORM_BUNDLE) printf "%s\\n" /platform/bundles/aaaaaaaaaaaa ;; OC_SEED_AUTHORITY_BY_REV) printf "%s\\n" "$seed_state" ;; esac; }',
        'remote_env_set() { record "env:$1=$2"; if [[ "$1" == OC_SEED_AUTHORITY_BY_REV ]]; then seed_state="$2"; [[ ! ( "$FAIL_AT" == write-unknown && "$2" == 1 ) ]]; else return 0; fi; }',
        'ssh() { record "ssh:$*"; return 0; }',
        'model_authority_fleet_census() { printf "%s\\n" \'[{"id":"cid","name":"oc-v5-u1","status":"running","bundle_rev":"aaaaaaaaaaaa"}]\'; }',
        'wait_for_model_authority_master_ready() { record "master-ready:$2/$3/$4"; if [[ "$4" == 1 && ( "$FAIL_AT" == seed-ready || "$FAIL_AT" == comp-ready ) ]]; then return 1; fi; [[ ! ( "$4" == 0 && "$FAIL_AT" == comp-ready ) ]]; }',
        'smoke() { record smoke; return 0; }',
        'model_authority_release_sha() { record release-read; [[ "$FAIL_AT" != evidence-read ]] || return 1; printf %s release-sha; }',
        'model_authority_runtime_tuple() { record tuple-read; printf "%s\\n" \'{"image":"i","image_id":"id","release":"r","bundle":"b"}\'; }',
        'remote_model_authority_psql() { record psql; return 1; }',
        'enable_seed_authority_by_rev',
      ].join('\n')
      const result = spawnSync('bash', ['-c', body], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ALLOW_ANY_BRANCH: '1', KL_HOST: 'fake-v5', ORDER_LOG: log, FAIL_AT: failAt },
      })
      return {
        result,
        order: (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean),
        output: result.stdout + result.stderr,
      }
    }

    const commitUnknown = await seedHarness('write-unknown')
    assert.notEqual(commitUnknown.result.status, 0)
    assert.match(
      commitUnknown.order.join('\n'),
      /env:OC_SEED_AUTHORITY_BY_REV=1[\s\S]*env:OC_SEED_AUTHORITY_BY_REV=0[\s\S]*restart 'openclaude-v5.service'[\s\S]*master-ready:1\/1\/0/,
    )
    assert.doesNotMatch(commitUnknown.order.join('\n'), /psql/)
    assert.match(commitUnknown.output, /seed authority 已验证回滚/)
    assert.doesNotMatch(commitUnknown.output, /seed authority by rev 已开启并留证/)

    const readinessFailure = await seedHarness('seed-ready')
    assert.notEqual(readinessFailure.result.status, 0)
    assert.match(
      readinessFailure.order.join('\n'),
      /master-ready:1\/1\/1[\s\S]*env:OC_SEED_AUTHORITY_BY_REV=0[\s\S]*restart 'openclaude-v5.service'[\s\S]*master-ready:1\/1\/0/,
    )
    assert.match(readinessFailure.output, /seed authority 已验证回滚/)

    const evidenceReadFailure = await seedHarness('evidence-read')
    assert.notEqual(evidenceReadFailure.result.status, 0)
    assert.match(
      evidenceReadFailure.order.join('\n'),
      /master-ready:1\/1\/1[\s\S]*smoke[\s\S]*release-read[\s\S]*env:OC_SEED_AUTHORITY_BY_REV=0[\s\S]*restart 'openclaude-v5.service'[\s\S]*master-ready:1\/1\/0/,
    )
    assert.match(evidenceReadFailure.output, /seed authority 已验证回滚/)
    assert.doesNotMatch(evidenceReadFailure.output, /seed authority by rev 已开启并留证/)

    const compensationFailure = await seedHarness('comp-ready')
    assert.notEqual(compensationFailure.result.status, 0)
    assert.match(compensationFailure.order.join('\n'), /master-ready:1\/1\/1[\s\S]*master-ready:1\/1\/0/)
    assert.doesNotMatch(compensationFailure.output, /seed authority 已验证回滚/)
    assert.doesNotMatch(compensationFailure.output, /seed authority by rev 已开启并留证/)
  })

  test('authority cutover is evidence-bound and linearized on observation + epoch locks', async () => {
    const source = await readFile(deploy, 'utf8')
    const enableStart = source.indexOf('enable_model_authority()')
    const enableEnd = source.indexOf('disable_model_authority()', enableStart)
    const enableBody = source.slice(enableStart, enableEnd)
    assert.ok(enableBody.indexOf('install_model_authority_canary') < enableBody.indexOf('remote_env_set "$MODEL_AUTHORITY_FLAG_KEY" 1'))
    assert.ok(enableBody.indexOf('start_model_authority_observation') > enableBody.indexOf('smoke'))

    const cutoverStart = source.indexOf('model_authority_cutover()')
    const cutoverEnd = source.indexOf('activate_release()', cutoverStart)
    const cutoverBody = source.slice(cutoverStart, cutoverEnd)
    assert.match(cutoverBody, /MODEL_AUTHORITY_OBSERVATION_KEY[\s\S]*FOR UPDATE/)
    assert.match(cutoverBody, /model_security_epoch WHERE id FOR UPDATE/)
    assert.match(cutoverBody, /observation window shorter than.*MODEL_AUTHORITY_MIN_OBSERVE_SECONDS/)
    assert.match(cutoverBody, /signed request evidence.*MODEL_AUTHORITY_MIN_REQUESTS/)
    assert.match(cutoverBody, /catalog canary has no signed usage/)
    assert.match(cutoverBody, /updated_at-created_at >= interval '5 minutes'/)
    assert.match(cutoverBody, /emergency activate\/restore drill evidence missing/)
    assert.match(cutoverBody, /INSERT INTO model_authority_deploy_state\(key,value,description\)/)

    const censusStart = source.indexOf('enable_seed_authority_by_rev()')
    const censusEnd = source.indexOf('record_model_authority_emergency_drill()', censusStart)
    const censusBody = source.slice(censusStart, censusEnd)
    assert.match(censusBody, /docker ps -aq/)
    assert.match(censusBody, /fleet 含旧\/缺 bundle_rev 容器\(含 stopped\)/)
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

  test('P3 Caddy port keeps the production render golden and validates boundaries', () => {
    const production = run(caddyApply, ['--render', '--dry-run'], { CADDY_HTTP_PORT: undefined })
    assert.equal(production.status, 0, production.stderr)
    assert.equal(
      createHash('sha256').update(production.stdout).digest('hex'),
      '60c9853f4b3bca511bf9f2cd6fad50dade596b99fb2f487f7dd0227919cc9d7b',
    )
    assert.doesNotMatch(production.stdout, /\tbind /)

    const staging = run(caddyApply, ['--render', '--dry-run'], { CADDY_HTTP_PORT: '18081' })
    assert.equal(staging.status, 0, staging.stderr)
    assert.match(staging.stdout, /http:\/\/claudeai\.chat:18081 \{\n\tbind 127\.0\.0\.1\n/)

    for (const port of ['1', '65535']) {
      const valid = run(caddyApply, ['--render', '--dry-run'], { CADDY_HTTP_PORT: port })
      assert.equal(valid.status, 0, `port=${port}: ${valid.stderr}`)
    }
    for (const port of ['0', '65536', '08', 'not-a-port']) {
      const invalid = run(caddyApply, ['--render', '--dry-run'], { CADDY_HTTP_PORT: port })
      assert.notEqual(invalid.status, 0, `port=${port} should fail`)
      assert.match(invalid.stderr, /CADDY_HTTP_PORT 必须是 1\.\.65535/)
    }
  })

  test('P3 Caddy verify and reload probes honor the configured port', async () => {
    const fixture = await caddyRemoteFixture()
    const canaryRow = '42|canary|A|B|/rel/a|/rel/b|A|A|0|salt|10||7|'

    const defaultVerify = run(caddyApply, ['--verify'], {
      ...fixture.env,
      CADDY_HTTP_PORT: undefined,
      FAKE_DS_ROW: canaryRow,
    })
    assert.equal(defaultVerify.status, 0, defaultVerify.stderr || defaultVerify.stdout)
    let log = await readFile(fixture.sshLog, 'utf8')
    assert.match(log, /http:\/\/127\.0\.0\.1:80\/healthz/)
    assert.doesNotMatch(log, /:18081\/healthz/)

    await writeFile(fixture.sshLog, '')
    const stagingVerify = run(caddyApply, ['--verify'], {
      ...fixture.env,
      CADDY_HTTP_PORT: '18081',
      FAKE_DS_ROW: canaryRow,
    })
    assert.equal(stagingVerify.status, 0, stagingVerify.stderr || stagingVerify.stdout)
    log = await readFile(fixture.sshLog, 'utf8')
    assert.equal((log.match(/http:\/\/127\.0\.0\.1:18081\/healthz/g) ?? []).length, 2)

    await writeFile(fixture.sshLog, '')
    const apply = run(caddyApply, ['--apply'], {
      ...fixture.env,
      CADDY_HTTP_PORT: '18081',
      FAKE_DS_ROW: '42|stable|A||/rel/a||A|A|0|salt|0||7|',
    })
    assert.equal(apply.status, 0, apply.stderr || apply.stdout)
    log = await readFile(fixture.sshLog, 'utf8')
    assert.match(log, /for i in .*http:\/\/127\.0\.0\.1:18081\/healthz/)
  })

  test('planned-maintenance public probe receives the same staging Caddy port', async () => {
    const fixture = await caddyRemoteFixture()
    const harness = [
      'set -euo pipefail',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'begin_planned_maintenance deploy 0',
    ].join('\n')
    const result = spawnSync('bash', ['-c', harness], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...fixture.env,
        ALLOW_ANY_BRANCH: '1',
        CADDY_HTTP_PORT: '18081',
      },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const args = await readFile(fixture.sshLog, 'utf8')
    const remoteBody = await readFile(fixture.sshStdinLog, 'utf8')
    assert.match(args, /\/var\/lib\/openclaude-v5\/cutovers 18081\n$/)
    assert.match(remoteBody, /http:\/\/127\.0\.0\.1:\$\{caddy_http_port\}\/healthz/)
  })

  test('candidate readiness predicate is fail-closed for every required field', () => {
    const check = (payload: string) => spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'candidate_health_ready "$PAYLOAD"',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', PAYLOAD: payload },
    })
    const valid = '{"ok":true,"channel":"v5","leadership":{"state":"standby"},"vip":"released"}'
    assert.equal(check(valid).status, 0)
    for (const invalid of [
      '{"ok":false,"channel":"v5","leadership":{"state":"standby"},"vip":"released"}',
      '{"channel":"v5","leadership":{"state":"standby"},"vip":"released"}',
      '{"ok":true,"channel":"v3","leadership":{"state":"standby"},"vip":"released"}',
      '{"ok":true,"leadership":{"state":"standby"},"vip":"released"}',
      '{"ok":true,"channel":"v5","leadership":{"state":"leader"},"vip":"released"}',
      '{"ok":true,"channel":"v5","leadership":{},"vip":"released"}',
      '{"ok":true,"channel":"v5","leadership":{"state":"standby"},"vip":"owner"}',
      '{"ok":true,"channel":"v5","leadership":{"state":"standby"}}',
      '{not-json',
      '',
    ]) {
      assert.notEqual(check(invalid).status, 0, `payload must fail closed: ${invalid}`)
    }
  })

  test('candidate readiness polling supports delayed success and a hard wall-clock deadline', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-candidate-ready-')); dirs.push(dir)
    const counter = path.join(dir, 'counter'); await writeFile(counter, '0')
    const delayed = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'slot_priv_healthz() {',
      '  n=$(cat "$COUNTER"); n=$((n+1)); printf "%s" "$n" >"$COUNTER"',
      '  if [ "$n" -lt 3 ]; then echo \'{"ok":true,"channel":"v5","leadership":{"state":"acquiring"},"vip":"released"}\';',
      '  else echo \'{"ok":true,"channel":"v5","leadership":{"state":"standby"},"vip":"released"}\'; fi',
      '}',
      'sleep() { :; }',
      'wait_for_candidate_ready B 5',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', COUNTER: counter },
    })
    assert.equal(delayed.status, 0, delayed.stderr || delayed.stdout)
    assert.equal(await readFile(counter, 'utf8'), '3')
    assert.match(delayed.stdout, /candidate=B 已 standby\+VIP released/)

    const bin = path.join(dir, 'bin'); await mkdir(bin)
    await writeFile(path.join(bin, 'ssh'), '#!/bin/sh\nsleep 3\n')
    await chmod(path.join(bin, 'ssh'), 0o755)
    const started = Date.now()
    const transportTimedOut = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'wait_for_candidate_ready B 1',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', PATH: `${bin}:${process.env.PATH}` },
    })
    const elapsed = Date.now() - started
    assert.notEqual(transportTimedOut.status, 0)
    assert.ok(elapsed < 2500, `one-second deadline took ${elapsed}ms`)
    assert.match(transportTimedOut.stderr, /last private healthz: <empty>/)

    const diagnostic = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'slot_priv_healthz() { sleep 1; echo \'{"ok":false,"probe":"last-seen"}\'; }',
      'wait_for_candidate_ready B 1',
    ].join('\n')], { cwd: root, encoding: 'utf8', env: { ...process.env, ALLOW_ANY_BRANCH: '1' } })
    assert.notEqual(diagnostic.status, 0)
    assert.match(diagnostic.stderr, /last private healthz: .*last-seen/)
  })

  test('candidate readiness dry-run is immediate and canary failure retains pre-READY recovery', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'v5-candidate-dry-')); dirs.push(dir)
    const touched = path.join(dir, 'touched')
    const started = Date.now()
    const dry = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'DRY=1',
      'slot_priv_healthz() { touch "$TOUCHED"; return 1; }',
      'wait_for_candidate_ready B 90',
      'test ! -e "$TOUCHED"',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', TOUCHED: touched },
    })
    assert.equal(dry.status, 0, dry.stderr || dry.stdout)
    assert.ok(Date.now() - started < 1000)

    const recovery = path.join(dir, 'recovered')
    const failedStart = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'sshk() { :; }',
      'wait_for_candidate_ready() { return 1; }',
      'recover_canary_prep() { printf "%s" "$1" >"$RECOVERY"; }',
      'set +e; start_candidate_unit_and_wait B; rc=$?; set -e',
      'test "$rc" -ne 0',
      'test "$(cat "$RECOVERY")" = B',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', RECOVERY: recovery },
    })
    assert.equal(failedStart.status, 0, failedStart.stderr || failedStart.stdout)

    const startFailure = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'sshk() { return 42; }',
      'wait_for_candidate_ready() { touch "$WAITED"; return 0; }',
      'recover_canary_prep() { touch "$RECOVERED"; }',
      'set +e; start_candidate_unit_and_wait B; rc=$?; set -e',
      'test "$rc" -ne 0',
      'test ! -e "$WAITED"',
      'test ! -e "$RECOVERED"',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ALLOW_ANY_BRANCH: '1',
        WAITED: path.join(dir, 'waited'),
        RECOVERED: path.join(dir, 'recovered-after-start-failure'),
      },
    })
    assert.equal(startFailure.status, 0, startFailure.stderr || startFailure.stdout)

    const stopFailure = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'calls=0',
      'sshk() { calls=$((calls+1)); [ "$calls" -ne 2 ]; }',
      'wait_for_candidate_ready() { return 1; }',
      'ds_cas_or_die() { touch "$CASSED"; }',
      'set +e; start_candidate_unit_and_wait B; rc=$?; set -e',
      'test "$rc" -ne 0',
      'test "$calls" -eq 2',
      'test ! -e "$CASSED"',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', CASSED: path.join(dir, 'cassed-after-stop-failure') },
    })
    assert.equal(stopFailure.status, 0, stopFailure.stderr || stopFailure.stdout)

    const dispatcherStopFailure = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'ds_snapshot() { DS_phase=canary; DS_transition_step=2; DS_candidate_slot=B; DS_active_slot=A; DS_operation_id=op; DS_lock_version=7; }',
      'recover_canary_prep() { return 42; }',
      'ds_cas_or_die() { touch "$CASSED"; }',
      'set +e; recover; rc=$?; set -e',
      'test "$rc" -ne 0',
      'test ! -e "$CASSED"',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', CASSED: path.join(dir, 'dispatcher-cassed-after-stop-failure') },
    })
    assert.equal(dispatcherStopFailure.status, 0, dispatcherStopFailure.stderr || dispatcherStopFailure.stdout)

    const missingUnit = spawnSync('bash', ['-c', [
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'sshk() { eval "$*"; }',
      'systemctl() { touch "$SYSTEMCTL_CALLED"; return 42; }',
      'export -f systemctl',
      'ds_cas_or_die() { touch "$CASSED"; }',
      'recover_canary_prep B',
      'test ! -e "$SYSTEMCTL_CALLED"',
      'test -e "$CASSED"',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ALLOW_ANY_BRANCH: '1',
        SYSTEMCTL_CALLED: path.join(dir, 'systemctl-called-for-missing-unit'),
        CASSED: path.join(dir, 'cassed-for-missing-unit'),
      },
    })
    assert.equal(missingUnit.status, 0, missingUnit.stderr || missingUnit.stdout)

    const source = await readFile(deploy, 'utf8')
    const startBody = source.match(/start_candidate_unit_and_wait\(\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    assert.match(startBody, /wait_for_candidate_ready "\$cand" 90/)
    assert.doesNotMatch(startBody, /run "sleep 4"/)
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
  deployState?: { phase: string; step: number; active: string; candidate?: string } | 'error'
  healthyHttpPorts?: number[]
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
    deployState = { phase: 'stable', step: 0, active: 'A' },
    healthyHttpPorts = [],
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
    curl: `#!/bin/sh
case "$*" in
  ${egressBad ? '' : '*18892*) echo \'{"ok":true,"role":"egress"}\';;'}
  ${healthyHttpPorts.map((port) => `*${port}*) echo '{"ok":true,"channel":"v5"}';;`).join('\n  ')}
  *) echo refused >&2; exit 7;;
esac
`,
    psql: deployState === 'error'
      ? '#!/bin/sh\necho database-down >&2; exit 2\n'
      : `#!/bin/sh
case "$*" in
  *"FROM deploy_state"*) printf '%s\\n' '${deployState.phase}|${deployState.step}|${deployState.active}|${deployState.candidate ?? ''}' ;;
  *) exit 0 ;;
esac
`,
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

describe('v5 monitor deploy_state serving lanes', () => {
  test('stable follows active B instead of assuming A', async () => {
    const result = await monitorFixture({
      marker: schema1Marker({ schema: 3 }),
      deployState: { phase: 'stable', step: 0, active: 'B' },
      healthyHttpPorts: [18795],
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /svc_v5\s+ok\s+serving slot=B/)
    assert.match(result.stdout, /http_v5\s+ok\s+serving slot=B healthz 正常/)
    assert.match(result.stdout, /svc_candidate_v5\s+ok\s+candidate not-serving/)
  })

  test('canary READY monitors active and candidate independently', async () => {
    const result = await monitorFixture({
      marker: schema1Marker({ schema: 3 }),
      deployState: { phase: 'canary', step: 10, active: 'A', candidate: 'B' },
      healthyHttpPorts: [18790],
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /EVENT ❌ \*\*svc_v5\*\*/)
    assert.match(result.stdout, /EVENT ❌ \*\*http_candidate_v5\*\*/)
    assert.match(result.stdout, /serving candidate=B phase=canary step=10/)
  })

  test('canary preparation step below READY does not monitor candidate', async () => {
    const result = await monitorFixture({
      marker: schema1Marker({ schema: 3 }),
      deployState: { phase: 'canary', step: 5, active: 'A', candidate: 'B' },
      healthyHttpPorts: [18790],
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /svc_candidate_v5\s+ok\s+candidate not-serving\(phase=canary step=5/)
    assert.doesNotMatch(result.stdout, /serving candidate=B phase=canary step=5/)
  })

  test('finalizing step6 treats candidate as the generic sole serving lane', async () => {
    const result = await monitorFixture({
      marker: schema1Marker({ schema: 3 }),
      deployState: { phase: 'finalizing', step: 6, active: 'A', candidate: 'B' },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /EVENT ❌ \*\*http_v5\*\* serving slot=B/)
    assert.match(result.stdout, /http_candidate_v5\s+ok\s+candidate not-serving/)
  })

  test('aborting monitors both until Caddy restore is recorded, then old active only', async () => {
    const before = await monitorFixture({
      marker: schema1Marker({ schema: 3 }),
      deployState: { phase: 'aborting', step: 0, active: 'A', candidate: 'B' },
      healthyHttpPorts: [18790],
    })
    assert.match(before.stdout, /EVENT ❌ \*\*http_candidate_v5\*\*/)

    const after = await monitorFixture({
      marker: schema1Marker({ schema: 3 }),
      deployState: { phase: 'aborting', step: 2, active: 'A', candidate: 'B' },
      healthyHttpPorts: [18790],
    })
    assert.doesNotMatch(after.stdout, /EVENT ❌ \*\*http_candidate_v5\*\*/)
    assert.match(after.stdout, /http_candidate_v5\s+ok\s+candidate not-serving/)
  })

  test('PG failure is fail-open alert and never guesses slot A', async () => {
    const result = await monitorFixture({
      marker: schema1Marker({ schema: 3 }),
      deployState: 'error',
      conditions: true,
      state: {
        checks: {
          svc_v5: { status: 'ok', since: 0, last_alert: 0 },
          http_v5: { status: 'ok', since: 0, last_alert: 0 },
        },
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /EVENT ❌ \*\*deploy_state\*\* deploy_state 不可裁决:psql 失败/)
    assert.match(result.stdout, /svc_candidate_v5\s+ok\s+candidate not-serving\(state unavailable\)/)
    assert.doesNotMatch(result.stdout, /openclaude-v5 状态=/)
    assert.match(result.stdout, /write_alert_condition\('ops\.monitor:deploy_state','probe',true/)
    assert.doesNotMatch(result.stdout, /write_alert_condition\('ops\.monitor:(svc_v5|http_v5)'/)
  })
})
