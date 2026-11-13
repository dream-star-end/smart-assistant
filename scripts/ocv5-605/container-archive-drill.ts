/** Explicit isolated Docker proof. Default is read-only preview. Never targets platform containers. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Docker from 'dockerode'
import {
  containerLogArchiveStats,
  removeContainerSavingLogs,
  saveContainerLogs,
} from '../../packages/commercial/src/compute-pool/containerLogArchive.js'
import { createLogger } from '../../packages/commercial/src/logging/logger.js'

const LABEL = 'ocv5-605-proof'
const REPO = fileURLToPath(new URL('../../', import.meta.url))
const IMAGE = 'sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9'
const LIMIT = 5

type ProofInspect = {
  Id: string
  Name: string
  Config: { Labels: Record<string, string> }
  State: { Running: boolean; Pid: number; ExitCode: number; OOMKilled: boolean }
}
export function assertOwnedProof(info: ProofInspect, id: string, runId: string): void {
  assert.match(id, /^[0-9a-f]{64}$/)
  assert.equal(info.Id, id)
  assert.ok(info.Name.startsWith(`/ocv5-605-proof-${runId}-`))
  assert.equal(info.Config.Labels[LABEL], runId)
  assert.equal(info.Config.Labels['proof-ticket'], 'OCV5-605')
  assert.equal(info.Config.Labels['proof-uid'], '765')
  assert.equal(info.Config.Labels['oc.user_id'], undefined)
  assert.equal(info.Config.Labels['openclaude.user-id'], undefined)
}

async function run(): Promise<void> {
  const args = process.argv.slice(2)
  const execute = args.includes('--execute')
  if (
    args.some(
      (arg) =>
        !['--execute', '--preview', '--out'].includes(arg) &&
        args[args.indexOf(arg) - 1] !== '--out',
    )
  )
    throw new Error('unknown option')
  const outArg = args[args.indexOf('--out') + 1]
  if (!args.includes('--out') || !outArg || outArg.startsWith('--'))
    throw new Error('--out absolute evidence directory required')
  if (!outArg.startsWith('/')) throw new Error('absolute --out required')
  const output = resolve(outArg)
  const docker = new Docker()
  const image = await docker.getImage(IMAGE).inspect()
  assert.equal(image.Id, IMAGE)
  if (!execute) {
    process.stdout.write(
      `${JSON.stringify({
        mode: 'read-only-preview',
        image: IMAGE,
        maxContainers: LIMIT,
        uid: 765,
        events: ['normal-recycle', 'rebuild-old-and-new', 'pid1-crash', 'cgroup-oom'],
        output,
        network: 'none',
        memoryMiB: 128,
        userVolumes: 0,
        removesOnlyCreatedFullIds: true,
      })}\n`,
    )
    return
  }
  const runId = randomBytes(6).toString('hex')
  const runDir = join(output, `run-${runId}`)
  const archives = join(runDir, 'archives')
  const emptyHostLogs = join(runDir, 'empty-host-logs')
  await mkdir(archives, { recursive: true, mode: 0o700 })
  await mkdir(emptyHostLogs, { mode: 0o700 })
  const ledger: Array<Record<string, unknown>> = []
  const results: Array<Record<string, unknown>> = []
  const warnings: Array<Record<string, unknown>> = []
  const log = createLogger({ level: 'debug', out: (line) => warnings.push(JSON.parse(line)) })
  const persist = () =>
    writeFile(
      join(runDir, 'ledger.json'),
      `${JSON.stringify(
        {
          runId,
          uid: 765,
          synthetic: true,
          image: IMAGE,
          ledger,
          results,
          counters: containerLogArchiveStats(),
          warnings,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
  const verify = async (container: Docker.Container) => {
    const info = await container.inspect()
    assertOwnedProof(info as ProofInspect, container.id, runId)
    const row = ledger.find((entry) => entry.id === container.id)
    assert.ok(row, 'identity evidence must belong to this run ledger')
    row.lastIdentityCheck = {
      verifiedAt: new Date().toISOString(),
      fullId: info.Id,
      name: info.Name,
      labels: {
        [LABEL]: info.Config.Labels[LABEL],
        'proof-ticket': info.Config.Labels['proof-ticket'],
        'proof-uid': info.Config.Labels['proof-uid'],
      },
      running: info.State.Running,
    }
    await persist()
    return info
  }
  const create = async (event: string, oom = false) => {
    assert.ok(ledger.length < LIMIT, 'hard maximum five new proof containers')
    const traceId = randomBytes(16).toString('hex')
    const code = `OCV5_605_DRILL_${event.toUpperCase().replace(/-/g, '_')}`
    const program =
      `console.log(JSON.stringify({ts:new Date().toISOString(),level:'warn',traceId:${JSON.stringify(traceId)},code:${JSON.stringify(code)},msg:'synthetic OCV5-605 archive proof'}));${oom
        ? 'const retained=[];setInterval(()=>retained.push(Buffer.alloc(8*1024*1024,1)),10);'
        : "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);"}`
    const container = await docker.createContainer({
      name: `ocv5-605-proof-${runId}-${event}`,
      Image: IMAGE,
      Entrypoint: ['node'],
      Cmd: ['-e', program],
      Labels: { [LABEL]: runId, 'proof-ticket': 'OCV5-605', 'proof-uid': '765' },
      HostConfig: {
        NetworkMode: 'none',
        Memory: 128 * 1024 * 1024,
        MemorySwap: 128 * 1024 * 1024,
        NanoCpus: 250_000_000,
        PidsLimit: 32,
        RestartPolicy: { Name: 'no' },
        AutoRemove: false,
        LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
      },
    })
    ledger.push({ id: container.id, event, traceId, code, phase: 'created' })
    await persist()
    await verify(container)
    await container.start()
    // Inspect and logs are read-only; wait until the fixture line reached Docker's log stream.
    const end = Date.now() + 20_000
    while (Date.now() < end) {
      const bytes = await container.logs({ stdout: true, stderr: true, tail: 10 })
      if (Buffer.from(bytes as Buffer).includes(Buffer.from(traceId)))
        return { container, traceId, code }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('proof marker did not reach Docker logs')
  }
  const waitStopped = async (container: Docker.Container) => {
    const end = Date.now() + 60_000
    while (Date.now() < end) {
      const info = await verify(container)
      if (!info.State.Running) return info
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('proof container did not stop within bound')
  }
  const archiveAndRemove = async (
    proof: Awaited<ReturnType<typeof create>>,
    event: string,
    failSave = false,
  ) => {
    const info = await verify(proof.container)
    assert.equal(info.State.Running, false)
    if (failSave) {
      assert.ok(
        await saveContainerLogs(proof.container, `${event}-before-failure`, { dir: archives, log }),
      )
      const badDir = join(runDir, 'not-a-directory')
      await writeFile(badDir, 'synthetic filesystem failure fixture\n', { mode: 0o600 })
      const before = containerLogArchiveStats().failed
      await verify(proof.container)
      await removeContainerSavingLogs(proof.container, event, { dir: badDir, log, force: false })
      assert.equal(containerLogArchiveStats().failed, before + 1)
      assert.ok(warnings.some((line) => line.msg === 'container logs not saved before removal'))
    } else {
      await removeContainerSavingLogs(proof.container, event, { dir: archives, log, force: false })
    }
    await assert.rejects(proof.container.inspect(), (err: any) => err.statusCode === 404)
    const files = (await readdir(archives)).filter((name) =>
      name.startsWith(`${proof.container.id.slice(0, 12)}-`),
    )
    assert.equal(files.length, 1)
    assert.equal((await stat(join(archives, files[0]!))).mode & 0o777, 0o600)
    assert.ok((await readFile(join(archives, files[0]!), 'utf8')).includes(proof.traceId))
    const started = performance.now()
    const raw = execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/oc-trace.ts', proof.traceId, '--json'],
      {
        cwd: REPO,
        encoding: 'utf8',
        timeout: 65_000,
        env: {
          ...process.env,
          OC_TRACE_LOG_DIR: emptyHostLogs,
          OC_TRACE_CONTAINER_LOG_DIR: archives,
        },
      },
    )
    const wallSeconds = (performance.now() - started) / 1000
    const trace = JSON.parse(raw)
    await writeFile(join(runDir, `${event}-oc-trace.json`), raw, { mode: 0o600 })
    assert.ok(wallSeconds <= 60)
    assert.equal(trace.firstError?.code, proof.code)
    assert.equal(trace.firstError?.source, 'container-log')
    assert.equal(trace.incomplete?.length ?? 0, 0)
    assert.equal(trace.truncated?.length ?? 0, 0)
    results.push({
      event,
      id: proof.container.id,
      syntheticTraceId: proof.traceId,
      exitCode: info.State.ExitCode,
      oomKilled: info.State.OOMKilled,
      wallSeconds,
      archive: files[0],
      saveFailedAsExpected: failSave,
    })
    ledger.find((row) => row.id === proof.container.id)!.phase = 'removed-with-evidence'
    await persist()
  }
  const normal = await create('normal-recycle')
  await verify(normal.container)
  await normal.container.stop({ t: 2 })
  await waitStopped(normal.container)
  await archiveAndRemove(normal, 'normal-recycle')
  const old = await create('rebuild-old')
  await verify(old.container)
  await old.container.stop({ t: 2 })
  await waitStopped(old.container)
  await archiveAndRemove(old, 'rebuild-old')
  const replacement = await create('rebuild-new')
  assert.notEqual(replacement.container.id, old.container.id)
  assert.ok(
    (await readdir(archives)).some((name) => name.startsWith(old.container.id.slice(0, 12))),
  )
  await verify(replacement.container)
  await replacement.container.stop({ t: 2 })
  await waitStopped(replacement.container)
  await archiveAndRemove(replacement, 'rebuild-new-save-failure', true)
  const crash = await create('pid1-crash')
  const running = await verify(crash.container)
  assert.equal(running.State.Running, true)
  const pid = running.State.Pid
  assert.ok(pid > 1)
  assert.ok((await readFile(`/proc/${pid}/cgroup`, 'utf8')).includes(crash.container.id))
  process.kill(pid, 'SIGKILL')
  const crashed = await waitStopped(crash.container)
  assert.equal(crashed.State.OOMKilled, false)
  assert.equal(crashed.State.ExitCode, 137)
  ledger.find((row) => row.id === crash.container.id)!.killedHostPid = pid
  await archiveAndRemove(crash, 'pid1-crash')
  const oom = await create('cgroup-oom', true)
  const killed = await waitStopped(oom.container)
  assert.equal(killed.State.OOMKilled, true, 'exit137 alone is not OOM proof')
  await archiveAndRemove(oom, 'cgroup-oom')
  assert.equal(ledger.length, LIMIT)
  process.stdout.write(
    `${JSON.stringify({
      status: 'PASS',
      runDir,
      synthetic: true,
      uid: 765,
      containers: ledger.length,
      results,
      counters: containerLogArchiveStats(),
    })}\n`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    process.stderr.write(
      `archive drill failed: ${err instanceof Error ? err.message : 'unknown'}; retain ledger and containers for exact-ID recovery\n`,
    )
    process.exitCode = 1
  })
}
