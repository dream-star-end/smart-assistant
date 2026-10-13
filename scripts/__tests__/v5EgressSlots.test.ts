/**
 * OCV5-391: scripts/v5-egress-slots.sh (commercial egress blue-green slots) against fake
 * systemctl/curl/ss/sysctl/sleep. The shared port is a real local TCP listener so the
 * "port answers" checks run for real. Asserts the flip order that keeps the port open
 * (new slot ready → old .socket closed → old service stopped without blocking), the one-time
 * legacy migration with its bounded pre-drain, and that failures leave the serving slot alone.
 *
 * Run: npx tsx --test scripts/__tests__/v5EgressSlots.test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const script = path.join(root, 'scripts/v5-egress-slots.sh')
let server: Server
let port = 0
const dirs: string[] = []

before(async () => {
  server = createServer((s) => s.end())
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
})
after(async () => {
  server.close()
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

interface World {
  active?: string[]          // units active at start
  ts?: Record<string, number> // ActiveEnterTimestampMonotonic
  slotHealthy?: boolean      // new slot's private health answers
  inflight?: number[]        // successive legacy in-flight readings
  ssOwner?: 'node' | 'systemd'
  templates?: boolean
  migrate?: string           // tcp_migrate_req value
  failStart?: string[]       // units whose start fails
}

async function run(world: World, ...args: string[]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'egress-slots-')); dirs.push(dir)
  const bin = path.join(dir, 'bin'); await mkdir(bin)
  const state = path.join(dir, 'state'); await mkdir(state)
  for (const u of world.active ?? []) await writeFile(path.join(state, u), 'active')
  await writeFile(path.join(dir, 'ts.json'), JSON.stringify(world.ts ?? {}))
  await writeFile(path.join(dir, 'inflight'), (world.inflight ?? [0]).join('\n'))
  const log = path.join(dir, 'calls.log')
  const sh = (name: string, body: string) => writeFile(path.join(bin, name), `#!/bin/bash\n${body}\n`).then(() => chmod(path.join(bin, name), 0o755))
  await sh('systemctl', `
echo "systemctl $*" >> '${log}'
S='${state}'
case "$1" in
  is-active) [[ -f "$S/$2" ]] && { cat "$S/$2"; [[ "$(cat "$S/$2")" == active ]]; exit $?; } || { echo inactive; exit 3; } ;;
  show) u="\${@: -1}"; case "$*" in
    *ActiveEnterTimestampMonotonic*) node -e 'const t=require("${dir}/ts.json"); console.log(t[process.argv[1]]??0)' "$u" ;;
    *MainPID*) [[ -f "$S/$u" ]] && echo $$ || echo 0 ;; esac ;;
  start) for u in "\${@:2}"; do case " ${(world.failStart ?? []).join(' ')} " in *" $u "*) exit 1 ;; esac; echo active > "$S/$u"; done ;;
  stop) nb=0; [[ " $* " == *" --no-block "* ]] && nb=1
    for u in "$@"; do [[ "$u" == -* || "$u" == stop ]] && continue
      # systemd: a --no-block stop of a service leaves it deactivating while it drains.
      if (( nb )) && [[ "$u" == *.service ]]; then echo deactivating > "$S/$u"; else rm -f "$S/$u"; fi; done ;;
  *) : ;;
esac`)
  await sh('curl', `
echo "curl $*" >> '${log}'
case "$*" in
  *egress-slot-health*) ${world.slotHealthy === false ? 'exit 7' : `s=$(grep -oE '1889[89]' <<<"$*"); [[ "$s" == 18898 ]] && sl=A || sl=B; echo "{\\"ok\\":true,\\"slot\\":\\"$sl\\",\\"listenMode\\":\\"sd_activation\\"}"`} ;;
  *egress-stats*) v=$(head -1 '${dir}/inflight'); sed -i 1d '${dir}/inflight'; [[ -s '${dir}/inflight' ]] || echo "\${v}" > '${dir}/inflight'; echo "{\\"ok\\":true,\\"inflight\\":{\\"total_current\\":\${v}}}" ;;
esac`)
  await sh('ss', `echo "LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:* users:((\\"${world.ssOwner ?? 'node'}\\",pid=42,fd=3))"`)
  await sh('sysctl', `echo "sysctl $*" >> '${log}'; [[ "$1" == -n ]] && echo '${world.migrate ?? '1'}'; exit 0`)
  await sh('sleep', 'exit 0')
  const etc = path.join(dir, 'etc'); await mkdir(etc)
  const shim = (world.templates ?? true)
    ? `cp '${script}' '${dir}/s.sh'; sed -i "s#/etc/systemd/system/#${etc}/#g" '${dir}/s.sh'`
    : `cp '${script}' '${dir}/s.sh'; sed -i "s#/etc/systemd/system/#${etc}/missing/#g" '${dir}/s.sh'`
  spawnSync('bash', ['-c', shim])
  if (world.templates ?? true) {
    await writeFile(path.join(etc, 'openclaude-v5-egress@.service'), '')
    await writeFile(path.join(etc, 'openclaude-v5-egress@.socket'), '')
  }
  const res = spawnSync('bash', [path.join(dir, 's.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OC_EGRESS_SLOTS_BIND: '127.0.0.1', OC_EGRESS_SLOTS_PORT: String(port) },
    timeout: 60_000,
  })
  const calls = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((l) => l.startsWith('systemctl ') && !/is-active|show/.test(l))
  return { ...res, calls }
}

describe('v5-egress-slots.sh (OCV5-391)', () => {
  test('flip A→B: B ready before A closes; A listener closed before A service stops without blocking', async () => {
    const r = await run({ active: ['openclaude-v5-egress@A.service', 'openclaude-v5-egress@A.socket'] }, 'flip')
    assert.equal(r.status, 0, r.stderr)
    const i = (s: string) => r.calls.findIndex((c) => c === s)
    const startSock = i('systemctl start openclaude-v5-egress@B.socket')
    const startSvc = i('systemctl start openclaude-v5-egress@B.service')
    const closeOld = i('systemctl stop --job-mode=ignore-dependencies openclaude-v5-egress@A.socket')
    const stopOld = i('systemctl stop --no-block openclaude-v5-egress@A.service')
    assert.ok(startSock >= 0 && startSvc > startSock, r.calls.join('\n'))
    assert.ok(closeOld > startSvc, 'old listener closes only after the new slot is up')
    assert.ok(stopOld > closeOld, 'old service drains in the background after its listener is gone')
    assert.equal(r.calls.some((c) => /stop openclaude-v5-egress@A.socket openclaude-v5-egress@A.service/.test(c)), false)
    assert.match(r.stdout, /serving from slot B, slot A draining/)
  })

  test('first flip from the legacy unit waits for its in-flight streams, then migrates to slot A', async () => {
    const r = await run({ active: ['openclaude-v5-egress.service'], inflight: [2, 1, 0] }, 'flip', '600')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /legacy in-flight=2[\s\S]*legacy in-flight=1[\s\S]*migrating legacy → slot A \(stopping openclaude-v5-egress.service, in-flight=0\)/)
    const stopLegacy = r.calls.indexOf('systemctl stop openclaude-v5-egress.service')
    const startA = r.calls.indexOf('systemctl start openclaude-v5-egress@A.socket')
    assert.ok(stopLegacy >= 0 && startA > stopLegacy, r.calls.join('\n'))
  })

  test('the legacy pre-drain is bounded', async () => {
    const r = await run({ active: ['openclaude-v5-egress.service'], inflight: [3] }, 'flip', '10')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /in-flight=3, waiting \(5s\/10s\)[\s\S]*migrating legacy → slot A .*in-flight=3/)
  })

  test('a new slot that never gets ready is withdrawn and the serving slot is not touched', async () => {
    const r = await run({ active: ['openclaude-v5-egress@B.service', 'openclaude-v5-egress@B.socket'], slotHealthy: false }, 'flip')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /slot A failed to start; slot B still serving/)
    assert.equal(r.calls.some((c) => /stop .*openclaude-v5-egress@B/.test(c)), false, r.calls.join('\n'))
  })

  test('a failed first slot during the legacy migration brings the legacy unit back (Codex r1 P1)', async () => {
    const r = await run({ active: ['openclaude-v5-egress.service'], slotHealthy: false }, 'flip', '0')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /slot A failed to start; legacy unit restored and serving/)
    const stopLegacy = r.calls.indexOf('systemctl stop openclaude-v5-egress.service')
    const withdrawA = r.calls.indexOf('systemctl stop openclaude-v5-egress@A.service')
    const startLegacy = r.calls.indexOf('systemctl start openclaude-v5-egress.service')
    assert.ok(stopLegacy >= 0 && withdrawA > stopLegacy && startLegacy > withdrawA, r.calls.join('\n'))
  })

  test('legacy with both slots active (killed flip) settles the older slot first, so a failed legacy can restore it (Codex r3 P1)', async () => {
    const r = await run({ active: ['openclaude-v5-egress@A.service', 'openclaude-v5-egress@B.service'],
      ts: { 'openclaude-v5-egress@A.service': 100, 'openclaude-v5-egress@B.service': 200 },
      failStart: ['openclaude-v5-egress.service'] }, 'legacy')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /closing the older slot A first[\s\S]*legacy egress failed to start; slot A restored and serving/)
    const settleA = r.calls.indexOf('systemctl stop openclaude-v5-egress@A.service')
    const termB = r.calls.indexOf('systemctl stop --no-block openclaude-v5-egress@B.service')
    assert.ok(settleA >= 0 && termB > settleA, r.calls.join('\n'))
  })

  test('refuses to flip without templates or tcp_migrate_req=1', async () => {
    const noTpl = await run({ active: ['openclaude-v5-egress.service'], templates: false }, 'flip')
    assert.notEqual(noTpl.status, 0); assert.match(noTpl.stderr, /slot templates not installed/)
    const noSysctl = await run({ active: ['openclaude-v5-egress.service'], migrate: '0' }, 'flip')
    assert.notEqual(noSysctl.status, 0); assert.match(noSysctl.stderr, /tcp_migrate_req is not 1/)
    assert.equal(noSysctl.calls.length, 0, 'nothing is stopped or started')
  })

  test('a listener held only by systemd (black hole) fails the flip', async () => {
    const r = await run({ active: ['openclaude-v5-egress@A.service'], ssOwner: 'systemd' }, 'flip')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /without a node owner/)
  })

  test('both slots active (earlier flip killed): the older slot is closed first', async () => {
    const r = await run({ active: ['openclaude-v5-egress@A.service', 'openclaude-v5-egress@B.service'],
      ts: { 'openclaude-v5-egress@A.service': 100, 'openclaude-v5-egress@B.service': 200 } }, 'flip')
    assert.equal(r.status, 0, r.stderr)
    assert.ok(r.calls.indexOf('systemctl stop openclaude-v5-egress@A.service') >= 0, r.calls.join('\n'))
    assert.ok(r.calls.indexOf('systemctl start openclaude-v5-egress@A.socket') > r.calls.indexOf('systemctl stop openclaude-v5-egress@A.service'))
  })

  test('active names the newest active unit; legacy closes slot listeners before restarting the legacy unit', async () => {
    const a = await run({ active: ['openclaude-v5-egress@A.service', 'openclaude-v5-egress@B.service'],
      ts: { 'openclaude-v5-egress@A.service': 300, 'openclaude-v5-egress@B.service': 200 } }, 'active')
    assert.equal(a.status, 0, a.stderr)
    assert.match(a.stdout, /^openclaude-v5-egress@A\.service \d+ /)
    const l = await run({ active: ['openclaude-v5-egress@A.service', 'openclaude-v5-egress@A.socket'] }, 'legacy')
    assert.equal(l.status, 0, l.stderr)
    const closeA = l.calls.indexOf('systemctl stop --job-mode=ignore-dependencies openclaude-v5-egress@A.socket')
    const termA = l.calls.indexOf('systemctl stop --no-block openclaude-v5-egress@A.service')
    const legacyOn = l.calls.indexOf('systemctl start openclaude-v5-egress.service')
    assert.ok(closeA >= 0 && termA > closeA && legacyOn > termA, l.calls.join('\n'))
    // Codex r2 P1: the legacy unit must not wait for the slot's drain (no blocking slot stop).
    assert.equal(l.calls.includes('systemctl stop openclaude-v5-egress@A.service'), false, l.calls.join('\n'))
  })

  test('legacy that fails to start puts an idle slot back instead of leaving the port closed (Codex r2 P1)', async () => {
    const r = await run({ active: ['openclaude-v5-egress@A.service', 'openclaude-v5-egress@A.socket'],
      failStart: ['openclaude-v5-egress.service'] }, 'legacy')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /legacy egress failed to start; slot B restored and serving/)
    const restoreB = r.calls.indexOf('systemctl start openclaude-v5-egress@B.socket')
    assert.ok(restoreB > r.calls.indexOf('systemctl start openclaude-v5-egress.service'), r.calls.join('\n'))
  })
})

describe('deploy-v5.sh master smoke accepts a serving egress slot (OCV5-411)', () => {
  const deploy = path.join(root, 'scripts/deploy-v5.sh')
  // Real failure 2026-10-13 15:59Z: the first --egress deploy migrated legacy → slot A, then the
  // master smoke still asked `systemctl is-active openclaude-v5-egress` and compensated a good release.
  const probe = async (active: string[]) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-egress-smoke-'))
    dirs.push(dir)
    await writeFile(path.join(dir, 'systemctl'),
      '#!/usr/bin/env bash\n[ "$1" = is-active ] && [ "$2" = --quiet ] || exit 3\n' +
      'for u in $ACTIVE_UNITS; do [ "$u" = "$3" ] && exit 0; done\nexit 3\n')
    await chmod(path.join(dir, 'systemctl'), 0o755)
    return spawnSync('bash', ['-c', [
      'set -uo pipefail',
      'export V5_DEPLOY_SOURCE_ONLY=1',
      `source '${deploy}'`,
      'KL_HOST=fake',
      'ssh() { shift; bash -c "$1"; }',
      'egress_serving_unit_active',
    ].join('\n')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLOW_ANY_BRANCH: '1', PATH: `${dir}:${process.env.PATH}`, ACTIVE_UNITS: active.join(' ') },
    })
  }

  test('legacy unit, slot A or slot B serving passes; nothing serving fails', async () => {
    assert.equal((await probe(['openclaude-v5-egress.service'])).status, 0)
    assert.equal((await probe(['openclaude-v5-egress@A.service'])).status, 0)
    assert.equal((await probe(['openclaude-v5-egress@B.service'])).status, 0)
    assert.notEqual((await probe([])).status, 0)
    assert.notEqual((await probe(['openclaude-v5-egress@A.socket'])).status, 0)
  })

  test('smoke uses the slot-aware check, not the legacy unit alone', async () => {
    const source = await readFile(deploy, 'utf8')
    const start = source.indexOf('\nsmoke() {')
    const body = source.slice(start, source.indexOf('\n}\n', start))
    assert.ok(start >= 0 && body.includes('egress_serving_unit_active'), 'smoke must call egress_serving_unit_active')
    assert.equal(body.includes('is-active --quiet openclaude-v5-egress"'), false)
  })
})
