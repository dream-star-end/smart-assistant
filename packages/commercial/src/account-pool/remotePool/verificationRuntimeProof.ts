/**
 * Container runtime parity proof & container stop/sentinel verification (`OCV5-749`, R12).
 *
 * Mirrors `codexCommissioning.ts`'s `proveRuntime` / `proveContainer` security invariants for
 * generic `remote-driver-v4` verification (`verificationWorker.js` + `remotePool` dist modules).
 */
import { execFile } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { evidenceHash } from '../codexCommissioningEvidence.js'

const exec = promisify(execFile)
const CODE_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

export const V4_VERIFICATION_WORKER_DIST = 'packages/gateway/dist/remotePool/verificationWorker.js'
const PINNED_V4_RUNTIME_FILES = [
  V4_VERIFICATION_WORKER_DIST,
  'packages/gateway/dist/remotePool/remoteEngineAdapter.js',
  'packages/gateway/dist/remotePool/containerLane.js',
  'packages/gateway/dist/remotePool/observationGate.js',
  'packages/gateway/dist/remotePool/resumeId.js',
  'packages/gateway/dist/remotePool/types.js',
  'packages/gateway/dist/cc5ToolHost.js',
  'packages/gateway/dist/codexCommissioningWire.js',
  'scripts/agent-remote/cc5-toolhost-supervisor.py',
  'scripts/ocv5-289/box_keeper.py',
  'claude-code-best/dist/cli-node.js',
] as const

function need(condition: unknown, code = 'REMOTE_VERIFICATION_RUNTIME_INVALID'): asserts condition {
  if (!condition) throw new Error(code)
}

async function runDocker(args: string[], maxBuffer = 4 * 1024 * 1024): Promise<string> {
  return (await exec('/usr/bin/docker', args, { timeout: 30_000, maxBuffer })).stdout
}

export interface VerificationRuntimeProof {
  readonly dockerId: string
  readonly imageId: string
  readonly manifestSha256: string
  readonly verifiedFiles: Readonly<Record<string, string>>
}

export async function proveVerificationRuntime(
  dockerId: string,
): Promise<VerificationRuntimeProof> {
  const inspectRaw = await runDocker(['inspect', dockerId])
  const info = (JSON.parse(inspectRaw) as Array<Record<string, any>>)[0]
  need(
    info?.Id === dockerId &&
      info.Name === '/oc-v5-u3' &&
      info.State?.Running === true &&
      Array.isArray(info.Mounts) &&
      info.Mounts.some(
        (m: Record<string, any>) => m.Destination === '/opt/openclaude' && m.RW === false,
      ),
    'REMOTE_VERIFICATION_RUNTIME_IDENTITY',
  )
  const mount = info.Mounts.find((m: Record<string, any>) => m.Destination === '/opt/openclaude')!
  need(
    typeof mount.Source === 'string' && realpathSync(mount.Source) === mount.Source,
    'REMOTE_VERIFICATION_RUNTIME_MOUNT',
  )
  for (let p = mount.Source as string; p !== '/'; p = join(p, '..')) {
    const st = lstatSync(p)
    need(
      st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0,
      'REMOTE_VERIFICATION_RUNTIME_OWNER',
    )
  }

  const manifestRaw = readFileSync(join(mount.Source, 'MANIFEST.json'))
  const manifest = JSON.parse(manifestRaw.toString('utf8')) as {
    files?: Array<{ path: string; sha256: string }>
  }
  const expected: Record<string, string> = {}
  for (const name of PINNED_V4_RUNTIME_FILES) {
    const record = manifest.files?.find((f) => f.path === name)
    const actual = evidenceHash(readFileSync(join(mount.Source, name)))
    need(record?.sha256 === actual, 'REMOTE_VERIFICATION_RUNTIME_MANIFEST')
    if (name.includes('/dist/')) {
      const source = name.replace('/dist/', '/src/').replace(/\.js$/, '.ts')
      if (name !== 'claude-code-best/dist/cli-node.js') {
        need(
          evidenceHash(readFileSync(join(CODE_ROOT, source))) ===
            evidenceHash(readFileSync(join(mount.Source, source))),
          'REMOTE_VERIFICATION_RUNTIME_REBUILD_REQUIRED',
        )
      }
    } else {
      need(
        evidenceHash(readFileSync(join(CODE_ROOT, name))) === actual,
        'REMOTE_VERIFICATION_RUNTIME_REBUILD_REQUIRED',
      )
    }
    expected[name] = actual
  }

  const pyScript =
    'import hashlib,json,pathlib,sys; files=json.loads(sys.argv[1]); ' +
    "print(json.dumps({p:hashlib.sha256((pathlib.Path('/opt/openclaude')/p).read_bytes()).hexdigest() for p in files}))"
  const actualRaw = await runDocker([
    'exec',
    '--user',
    '1000',
    dockerId,
    '/usr/bin/python3',
    '-I',
    '-B',
    '-c',
    pyScript,
    JSON.stringify(PINNED_V4_RUNTIME_FILES),
  ])
  const inContainer = JSON.parse(actualRaw) as Record<string, string>
  for (const name of PINNED_V4_RUNTIME_FILES) {
    need(inContainer[name] === expected[name], 'REMOTE_VERIFICATION_RUNTIME_PARITY')
  }

  return {
    dockerId,
    imageId: String(info.Image ?? ''),
    manifestSha256: evidenceHash(manifestRaw),
    verifiedFiles: expected,
  }
}

export interface VerificationContainerAuditInput {
  readonly runId: string
  readonly laneId: string
  readonly proofs: ReadonlyArray<{
    readonly root: string
    readonly lifecycleId: string
  }>
  readonly expectedFiles?: ReadonlyArray<{
    readonly path: string
    readonly content: string
  }>
  readonly absentFiles?: ReadonlyArray<string>
}

export interface VerificationContainerProofResult {
  readonly laneId: string
  readonly localStopped: true
  readonly checkedSupervisors: ReadonlyArray<number>
  readonly checkedSentinels: ReadonlyArray<string>
}

export async function proveVerificationContainer(
  dockerId: string,
  input: VerificationContainerAuditInput,
): Promise<VerificationContainerProofResult> {
  const py = [
    'import json, os, pathlib, stat, sys',
    'spec = json.loads(sys.argv[1])',
    'pids = []',
    'for item in spec["proofs"]:',
    '    p = pathlib.Path(item["root"]) / "stopped.json"',
    '    st = p.lstat()',
    '    assert stat.S_ISREG(st.st_mode) and st.st_uid == 1000 and (st.st_mode & 0o077) == 0',
    '    data = json.loads(p.read_text("utf-8"))',
    '    assert data.get("version") == 1 and data.get("lifecycleId") == item["lifecycleId"] and data.get("localStopped") is True',
    '    pid = int(data["supervisorPid"])',
    '    assert not pathlib.Path(f"/proc/{pid}").exists(), f"supervisor still alive: {pid}"',
    '    pids.append(pid)',
    'checked_files = []',
    'for ef in spec.get("expectedFiles", []):',
    '    fp = pathlib.Path(ef["path"])',
    '    assert fp.exists(), f"missing sentinel: {fp}"',
    '    assert fp.read_text("utf-8") == ef["content"], f"sentinel content mismatch: {fp}"',
    '    checked_files.append(str(fp))',
    'for af in spec.get("absentFiles", []):',
    '    assert not pathlib.Path(af).exists(), f"unexpected file present: {af}"',
    'print(json.dumps({"ok": True, "pids": pids, "checkedFiles": checked_files}))',
  ].join('\n')

  const outRaw = await runDocker([
    'exec',
    '--user',
    '1000',
    dockerId,
    '/usr/bin/python3',
    '-I',
    '-B',
    '-c',
    py,
    JSON.stringify(input),
  ])
  const parsed = JSON.parse(outRaw) as {
    ok?: boolean
    pids?: number[]
    checkedFiles?: string[]
  }
  need(parsed.ok === true, 'REMOTE_VERIFICATION_CONTAINER_PROOF_FAILED')
  return {
    laneId: input.laneId,
    localStopped: true,
    checkedSupervisors: parsed.pids ?? [],
    checkedSentinels: parsed.checkedFiles ?? [],
  }
}
