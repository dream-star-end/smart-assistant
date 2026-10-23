import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const lib = path.join(root, 'scripts/lib/v5-host-admission.sh')
const deploy = path.join(root, 'scripts/deploy-v5.sh')

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'oc-v5-host-admission-'))
  const load = path.join(dir, 'loadavg')
  const locks = path.join(dir, 'locks')
  const proc = path.join(dir, 'proc')
  await Promise.all([mkdir(locks), mkdir(proc), writeFile(load, '0.00 0.00 0.00 1/1 1\n')])
  const env = {
    ...process.env,
    V5_HOST_ADMISSION_LOADAVG: load,
    V5_HOST_ADMISSION_LOCK_DIR: locks,
    V5_HOST_ADMISSION_PROC_ROOT: proc,
    V5_HOST_ADMISSION_TIMEOUT_S: '0',
    V5_HOST_ADMISSION_POLL_S: '0.02',
    MODE: 'deploy', DRY: '0', CANARY_RELEASE: '',
  }
  const run = (body = 'v5_host_admission_for_mode', extra = {}) => spawnSync(
    'bash', ['-c', 'set -Eeuo pipefail; source "$1"; ' + body, 'admission-test', lib],
    { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 10_000 },
  )
  return { dir, load, locks, proc, env, run }
}

function status(result: ReturnType<typeof spawnSync>, expected: number) {
  assert.equal(result.status, expected, String(result.stdout) + String(result.stderr))
}

test('host admission accepts an idle host without creating lock files', async () => {
  const f = await fixture()
  const lock = path.join(f.locks, 'oc-test-commercial.lock')
  await writeFile(lock, 'existing lock metadata\n')
  const before = await readdir(f.locks)
  status(f.run(), 0)
  assert.deepEqual(await readdir(f.locks), before)
  assert.equal(await readFile(lock, 'utf8'), 'existing lock metadata\n')
})

test('host admission rejects threshold load and unreadable load in strict shells', async () => {
  const f = await fixture()
  for (const value of ['8.00', '12.3', 'invalid']) {
    await writeFile(f.load, value + ' 0 0\n')
    status(f.run(), 1)
  }
  status(f.run(undefined, { V5_HOST_ADMISSION_LOADAVG: path.join(f.dir, 'absent') }), 1)
  await writeFile(f.load, '7.99 0 0\n')
  status(f.run(), 0)
})

test('host admission detects a real held lock and accepts it after release', async () => {
  const f = await fixture()
  const lock = path.join(f.locks, 'oc-test-commercial.lock')
  await writeFile(lock, '')
  const holder = spawn('flock', ['-x', lock, 'bash', '-c', 'echo READY; read -r release'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(holder, 'exit')
  try {
    await once(holder.stdout, 'data')
    const blocked = f.run()
    status(blocked, 1)
    assert.match(String(blocked.stderr), /test-mutex:commercial/)
  } finally {
    holder.stdin.end('release\n')
    await exited
  }
  status(f.run(), 0)
})

test('host admission detects npm tests and v5 checks without rejecting builds', async () => {
  const f = await fixture()
  const procDir = path.join(f.proc, '999999')
  await mkdir(procDir)
  for (const args of [
    ['npm', 'test'], ['npm', 'run', 'test:web-react'],
    ['/usr/bin/node', '/usr/lib/node_modules/npm/bin/npm-cli.js', 'run', 'check:v5:incidents'],
  ]) {
    await writeFile(path.join(procDir, 'cmdline'), args.join('\0') + '\0')
    status(f.run(), 1)
  }
  for (const args of [['npm', 'run', 'build'], ['node', '--test', 'isolated.node-test.mjs']]) {
    await writeFile(path.join(procDir, 'cmdline'), args.join('\0') + '\0')
    status(f.run(), 0)
  }
})

test('host admission waits for a busy host to become idle', async () => {
  const f = await fixture()
  await writeFile(f.load, '8.00 0 0\n')
  const child = spawn('bash', ['-c', 'set -Eeuo pipefail; source "$1"; v5_host_admission_for_mode', 'wait-test', lib], {
    env: { ...f.env, V5_HOST_ADMISSION_TIMEOUT_S: '5' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  let output = ''
  child.stderr.on('data', data => { output += data })
  await once(child.stderr, 'data')
  await writeFile(f.load, '0.00 0 0\n')
  const [code] = await exited
  assert.equal(code, 0, output)
  assert.match(output, /主机繁忙/)
  assert.match(output, /主机空闲/)
})

test('host admission mode matrix waits only for candidate builds and never for dry-run', async () => {
  const f = await fixture()
  await writeFile(f.load, '8.00 0 0\n')
  for (const MODE of ['deploy', 'dist', 'canary']) status(f.run(undefined, { MODE }), 1)
  for (const MODE of ['smoke', 'rollback', 'finalize', 'recover', 'knowledge-planet-verify']) status(f.run(undefined, { MODE }), 0)
  status(f.run(undefined, { MODE: 'canary', CANARY_RELEASE: 'rel-existing' }), 0)
  for (const MODE of ['deploy', 'dist', 'canary']) status(f.run(undefined, { MODE, DRY: '1' }), 0)
})

test('deploy admission rejection occurs after CI and before lease acquisition or build', async () => {
  const f = await fixture()
  const source = await readFile(deploy, 'utf8')
  assert.ok(source.includes('source "$SCRIPT_DIR/lib/v5-host-admission.sh"'))
  const begin = source.indexOf('\nmaybe_run_ci_green_gate_for_mode || exit 1\n')
  const end = source.indexOf('\n# B1 持锁后廉价复核', begin)
  assert.ok(begin > 0 && end > begin)
  const flow = source.slice(begin, end)
  assert.ok(flow.indexOf('v5_host_admission_for_mode || exit 1') > flow.indexOf('assert_egress_surface_covered || exit 1'))
  assert.ok(flow.indexOf('v5_host_admission_for_mode || exit 1') < flow.indexOf('acquire_production_mutation_lease || exit 3'))
  const invoke = `
    maybe_run_ci_green_gate_for_mode() { echo CI; }
    assert_egress_surface_covered() { echo EGRESS; }
    acquire_production_mutation_lease() { echo LEASE; }
    ${flow}
    echo BUILD
  `
  await writeFile(f.load, '8.00 0 0\n')
  const blocked = f.run(invoke)
  status(blocked, 1)
  assert.equal(String(blocked.stdout), 'CI\nEGRESS\n')
  await writeFile(f.load, '0.00 0 0\n')
  const idle = f.run(invoke)
  status(idle, 0)
  assert.equal(String(idle.stdout), 'CI\nEGRESS\nLEASE\nBUILD\n')
})
