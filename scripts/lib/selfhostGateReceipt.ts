import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const WORKFLOW = '.github/workflows/v5-selfhost-gate-receipts.yml'
export const MANIFEST = 'deploy/v5/selfhost-release-gates.json'
export const POLICY = 'deploy/v5/selfhost-gate-receipt-policy.json'
export const BASE_REF = 'refs/heads/feat/v5-selfhost'
export const QUEUE_REF = 'refs/heads/gh-readonly-queue/feat/v5-selfhost/'
const SCHEMA = 'oc.v5.selfhost.gate-receipt/1'
const SHA = /^[0-9a-f]{40}$/
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/
const MAX_JSON = 32 * 1024
const MAX_ZIP = 128 * 1024

export interface Inputs {
  manifestSha256: string
  policySha256: string
  workflowSha256: string
  gates: string[]
}
export interface Identity {
  repository: string
  sourceSha: string
  sourceRef: string
  runId: number
  runAttempt: number
}
export interface Receipt extends Identity, Inputs {
  schema: string
  event: string
  baseRef: string
  workflow: string
  results: { id: string; conclusion: string }[]
}
export interface Run {
  id: number
  run_attempt: number
  head_sha: string
  head_branch: string
  path: string
  event: string
  status: string
  conclusion: string | null
  repository: { id: number; full_name: string }
  head_repository: { id: number; full_name: string }
}

export function inputs(root: string): Inputs {
  const bytes = (p: string) => readFileSync(join(root, p))
  const hash = (p: string) => createHash('sha256').update(bytes(p)).digest('hex')
  const manifest = JSON.parse(bytes(MANIFEST).toString())
  const policy = JSON.parse(bytes(POLICY).toString())
  assert.equal(manifest.schema, 'oc.v5.selfhost.release-gates/1')
  assert.equal(policy.schema, 'oc.v5.selfhost.gate-receipt-policy/1')
  assert.ok(Array.isArray(policy.gates) && policy.gates.length > 0, 'nonempty gate policy required')
  assert.equal(new Set(policy.gates).size, policy.gates.length)
  for (const id of policy.gates) {
    assert.ok(typeof id === 'string' && /^[a-z][a-z0-9-]+$/.test(id), 'invalid gate ID')
    const gate = manifest.gates.find((g: { id: string }) => g.id === id)
    assert.ok(gate?.script && !gate.stage && gate.ci, 'only build gates with existing CI')
  }
  return { manifestSha256: hash(MANIFEST), policySha256: hash(POLICY),
    workflowSha256: hash(WORKFLOW), gates: policy.gates }
}

function validIdentity(i: Identity): void {
  assert.match(i.repository, REPO)
  assert.match(i.sourceSha, SHA)
  assert.ok(i.sourceRef.startsWith(QUEUE_REF) && /^[A-Za-z0-9/_.-]+$/.test(i.sourceRef), 'invalid queue ref')
  assert.ok(i.sourceRef.split('/').every(part => part.length > 0 && !part.startsWith('.')
    && !part.endsWith('.') && !part.endsWith('.lock') && !part.includes('..')), 'invalid git ref segment')
  assert.ok(Number.isSafeInteger(i.runId) && i.runId > 0, 'invalid run ID')
  assert.ok(Number.isSafeInteger(i.runAttempt) && i.runAttempt > 0, 'invalid run attempt')
}

export function makeReceipt(i: Identity, data: Inputs,
  outcomes: Record<string, { outcome: string; conclusion: string }>): Receipt {
  validIdentity(i)
  for (const id of data.gates) {
    assert.deepEqual(outcomes[`gate_${id.replaceAll('-', '_')}`],
      { outcome: 'success', conclusion: 'success' }, `gate did not pass: ${id}`)
  }
  return { schema: SCHEMA, ...i, event: 'merge_group', baseRef: BASE_REF, workflow: WORKFLOW,
    ...data, results: data.gates.map(id => ({ id, conclusion: 'success' })) }
}

export function validateRun(run: Run, repository: string, sha: string): Identity {
  const identity = { repository, sourceSha: sha, sourceRef: `refs/heads/${run.head_branch}`,
    runId: run.id, runAttempt: run.run_attempt }
  validIdentity(identity)
  assert.equal(run.repository.full_name, repository)
  assert.equal(run.head_repository.full_name, repository)
  assert.ok(Number.isSafeInteger(run.repository.id) && run.repository.id > 0, 'invalid repository ID')
  assert.equal(run.head_repository.id, run.repository.id)
  assert.equal(run.head_sha, sha)
  assert.equal(run.path, WORKFLOW)
  assert.equal(run.event, 'merge_group')
  assert.equal(run.status, 'completed')
  assert.equal(run.conclusion, 'success')
  return identity
}

export function validateReceipt(receipt: unknown, i: Identity, data: Inputs): asserts receipt is Receipt {
  const outcomes = Object.fromEntries(data.gates.map(id => [
    `gate_${id.replaceAll('-', '_')}`, { outcome: 'success', conclusion: 'success' },
  ]))
  // Exact object equality rejects extra/missing/duplicate gates and non-success results too.
  assert.deepEqual(receipt, makeReceipt(i, data, outcomes))
}

// No shell, no user-provided executable or URL. Never return gh's stderr (it can contain secrets).
export type Gh = (args: string[], maxBytes?: number) => Buffer
export const github: Gh = (args, maxBytes = 1024 * 1024) => {
  const result = spawnSync('gh', args, { timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: maxBytes,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' } })
  if (result.error || result.signal || result.status !== 0) {
    throw new Error('GitHub request or attestation verification unavailable')
  }
  return result.stdout
}

export function attestationArgs(path: string, i: Identity): string[] {
  return ['attestation', 'verify', path, '--hostname', 'github.com', '--repo', i.repository,
    '--signer-workflow', `${i.repository}/${WORKFLOW}`, '--signer-digest', i.sourceSha,
    '--source-digest', i.sourceSha, '--source-ref', i.sourceRef, '--deny-self-hosted-runners',
    '--predicate-type', 'https://slsa.dev/provenance/v1', '--format', 'json']
}

function validateAttestation(output: Buffer, i: Identity): void {
  const verified: unknown = JSON.parse(output.toString())
  assert.ok(Array.isArray(verified) && verified.length > 0, 'missing verified attestations')
  for (const result of verified) {
    // These are OIDC-derived certificate fields, not the user-controlled predicate or receipt.
    // gh has already verified the signature, subject bytes and all attestationArgs constraints.
    const cert = result?.verificationResult?.signature?.certificate
    assert.equal(cert?.runInvocationURI,
      `https://github.com/${i.repository}/actions/runs/${i.runId}/attempts/${i.runAttempt}`)
    assert.equal(cert?.buildTrigger, 'merge_group')
  }
}

export function extractReceipt(zip: Buffer): Buffer {
  assert.ok(zip.length <= MAX_ZIP, 'receipt archive too large')
  // Read one bounded regular entry into memory; never extract paths or execute downloaded code.
  const result = spawnSync('python3', ['-c', `
import io, stat, sys, zipfile
z = zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
entries = z.infolist()
assert len(entries) == 1
f = entries[0]
assert f.filename == 'receipt.json' and f.file_size <= ${MAX_JSON}
assert not f.is_dir() and not (f.flag_bits & 1)
# ZIP writers may omit the Unix type bits; when present they must identify a regular file.
assert stat.S_IFMT(f.external_attr >> 16) in (0, stat.S_IFREG)
sys.stdout.buffer.write(z.read(f))
`], { input: zip, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: MAX_JSON,
    stdio: ['pipe', 'pipe', 'pipe'] })
  if (result.error || result.signal || result.status !== 0) throw new Error('invalid receipt archive')
  return result.stdout
}

export function fetchReceipt(root: string, repository: string, sha: string, scratch: string,
  gh: Gh = github): Receipt {
  assert.match(repository, REPO)
  assert.match(sha, SHA)
  const data = inputs(root)
  const api = (path: string) => JSON.parse(gh(['api', '--hostname', 'github.com', path]).toString())
  const prefix = `repos/${repository}/actions`
  // No waiting for CI while holding a release lock. An unavailable or unfinished run is a miss.
  const runs = api(`${prefix}/workflows/${WORKFLOW.split('/').at(-1)}/runs?head_sha=${sha}&event=merge_group&per_page=1`)
  assert.ok(Array.isArray(runs.workflow_runs) && runs.workflow_runs.length === 1, 'expected one latest run')
  const run: Run = runs.workflow_runs[0]
  const identity = validateRun(run, repository, sha)
  const name = `selfhost-gate-receipt-${sha}-${identity.runAttempt}`
  const artifacts = api(`${prefix}/runs/${identity.runId}/artifacts?name=${name}&per_page=100`)
  assert.equal(artifacts.total_count, 1)
  assert.equal(artifacts.artifacts.length, 1)
  const artifact = artifacts.artifacts[0]
  assert.equal(artifact.name, name)
  assert.equal(artifact.expired, false)
  assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0, 'invalid artifact ID')
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0
    && artifact.size_in_bytes <= MAX_ZIP, 'invalid artifact size')
  assert.equal(artifact.workflow_run.id, identity.runId)
  assert.equal(artifact.workflow_run.head_sha, sha)
  assert.equal(artifact.workflow_run.head_branch, run.head_branch)
  assert.equal(artifact.workflow_run.repository_id, run.repository.id)
  assert.equal(artifact.workflow_run.head_repository_id, run.head_repository.id)
  const bytes = extractReceipt(gh(['api', '--hostname', 'github.com',
    `${prefix}/artifacts/${artifact.id}/zip`], MAX_ZIP))
  const receipt: unknown = JSON.parse(bytes.toString())
  validateReceipt(receipt, identity, data)
  const dir = mkdtempSync(join(scratch, 'receipt-'))
  try {
    const file = join(dir, 'receipt.json')
    writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
    validateAttestation(gh(attestationArgs(file, identity)), identity)
    // Reject a rerun that changed the attempt or invalidated success while we downloaded/verified.
    const freshRun: Run = api(`${prefix}/runs/${identity.runId}`)
    const fresh = validateRun(freshRun, repository, sha)
    assert.deepEqual(fresh, identity)
    assert.equal(freshRun.repository.id, run.repository.id)
    return receipt
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
