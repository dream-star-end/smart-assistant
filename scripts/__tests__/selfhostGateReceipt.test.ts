import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { functionCommands, runsIn } from '../check-release-gate-parity.ts'
import { BASE_REF, MANIFEST, POLICY, QUEUE_REF, WORKFLOW, attestationArgs, extractReceipt,
  fetchReceipt, inputs, makeReceipt, validateReceipt, validateRun,
  type Gh, type Identity, type Run } from '../lib/selfhostGateReceipt.js'

const ROOT = join(import.meta.dirname, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const data = inputs(ROOT)
const sha = 'a'.repeat(40)
const repository = 'owner/selfhost'
const repositoryId = 4321
const identity: Identity = { repository, sourceSha: sha,
  sourceRef: `${QUEUE_REF}pr-123-${sha}`, runId: 1234, runAttempt: 2 }
const outcomes = Object.fromEntries(data.gates.map(id => [
  `gate_${id.replaceAll('-', '_')}`, { outcome: 'success', conclusion: 'success' },
]))
const good = () => makeReceipt(identity, data, outcomes)
const run = (): Run => ({ id: identity.runId, run_attempt: identity.runAttempt, head_sha: sha,
  head_branch: identity.sourceRef.replace('refs/heads/', ''), path: WORKFLOW, event: 'merge_group',
  status: 'completed', conclusion: 'success', repository: { id: repositoryId, full_name: repository },
  head_repository: { id: repositoryId, full_name: repository } })
const artifactName = `selfhost-gate-receipt-${sha}-${identity.runAttempt}`
const artifact = () => ({ id: 987, name: artifactName, expired: false, size_in_bytes: 1024,
  workflow_run: { id: identity.runId, repository_id: repositoryId, head_repository_id: repositoryId,
    head_sha: sha, head_branch: run().head_branch } })
const certificate = () => ({ buildTrigger: 'merge_group',
  runInvocationURI: `https://github.com/${repository}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}` })
const verified = (cert: unknown = certificate()) => [{ verificationResult: { signature: { certificate: cert } } }]
const zip = (body: string, filename = 'receipt.json') => execFileSync('python3', ['-c', `
import io, sys, zipfile
b = io.BytesIO()
with zipfile.ZipFile(b, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr(sys.argv[1], sys.stdin.buffer.read())
sys.stdout.buffer.write(b.getvalue())
`, filename], { input: body })

function fixture(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'selfhost-receipt-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('receipt exactly binds commit, repo, run/attempt, manifest, subset and successful gates', () => {
  validateReceipt(good(), identity, data)
  const changes = [
    { sourceSha: 'b'.repeat(40) }, { repository: 'attacker/fork' }, { baseRef: 'refs/heads/main' },
    { sourceRef: 'refs/pull/123/merge' }, { schema: 'unknown' }, { event: 'pull_request' },
    { workflow: '.github/workflows/other.yml' }, { runId: 2345 }, { runAttempt: 1 },
    { manifestSha256: '0'.repeat(64) }, { policySha256: '0'.repeat(64) },
    { workflowSha256: '0'.repeat(64) }, { gates: [] }, { gates: data.gates.slice(1) },
    { gates: [...data.gates, 'box-success-recovery'] }, { gates: [...data.gates, data.gates[0]] },
    { gates: [...data.gates].reverse() }, { results: [] },
    { results: good().results.map(g => ({ ...g, conclusion: 'skipped' })) }, { unexpected: true },
  ]
  for (const change of changes) assert.throws(() => validateReceipt({ ...good(), ...change }, identity, data))
  for (const change of [{ gates: data.gates.slice(1) }, { policySha256: '1'.repeat(64) }]) {
    assert.throws(() => validateReceipt(good(), identity, { ...data, ...change }))
  }
  assert.throws(() => validateReceipt(null, identity, data))
})

test('issuance rejects missing, skipped, failed or masked outcomes', () => {
  const key = Object.keys(outcomes)[0]!
  for (const outcome of ['skipped', 'failure', 'cancelled', 'timed_out']) {
    assert.throws(() => makeReceipt(identity, data, { ...outcomes,
      [key]: { outcome, conclusion: 'success' } }))
  }
  assert.throws(() => makeReceipt(identity, data, {}))
})

test('GitHub run must itself be an exact successful selfhost merge-group attempt', () => {
  assert.deepEqual(validateRun(run(), repository, sha), identity)
  for (const change of [
    { head_sha: 'b'.repeat(40) }, { path: '.github/workflows/untrusted.yml' },
    { event: 'push' }, { event: 'pull_request' }, { status: 'in_progress' },
    { conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: 'skipped' },
    { head_branch: 'gh-readonly-queue/feat/v5-aurora-rewrite/pr-123' },
    { repository: { id: repositoryId, full_name: 'other/repo' } },
    { head_repository: { id: repositoryId, full_name: 'fork/repo' } },
    { repository: { id: 0, full_name: repository } },
    { head_repository: { id: repositoryId + 1, full_name: repository } },
    { id: -1 }, { run_attempt: 0 },
  ]) assert.throws(() => validateRun({ ...run(), ...change }, repository, sha))
})

test('identity rejects dot-segment repositories and invalid or empty queue refs', () => {
  for (const repo of ['../selfhost', 'owner/..', 'owner/.']) {
    assert.throws(() => makeReceipt({ ...identity, repository: repo }, data, outcomes), repo)
  }
  for (const suffix of ['', '../pr-1', '.hidden', 'pr-1/../pr-2', 'pr-1//nested', 'pr-1/', 'pr-1.', 'pr-1.lock']) {
    assert.throws(() => makeReceipt({ ...identity, sourceRef: `${QUEUE_REF}${suffix}` }, data, outcomes), suffix)
  }
})

test('archive reader rejects wrong paths and oversized expanded content', () => {
  assert.equal(extractReceipt(zip('receipt')).toString(), 'receipt')
  assert.equal(extractReceipt(zip('x'.repeat(32 * 1024))).length, 32 * 1024)
  for (const name of ['../receipt.json', '/receipt.json', 'other.json']) {
    assert.throws(() => extractReceipt(zip('{}', name)))
  }
  assert.throws(() => extractReceipt(zip('x'.repeat(33 * 1024))))
  assert.throws(() => extractReceipt(zip('x'.repeat(32 * 1024 + 1))))
  assert.throws(() => extractReceipt(Buffer.from('not zip')))
  assert.throws(() => extractReceipt(Buffer.alloc(129 * 1024)))
  const encrypted = zip('{}')
  encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 1, 6)
  const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  assert.ok(central > 0, 'ZIP fixture must have a central directory')
  encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8)
  assert.throws(() => extractReceipt(encrypted))
})

function mockGithub(overrides: { receipt?: unknown; signatureFails?: boolean; run?: Run;
  fresh?: Run; artifacts?: unknown; apiFails?: boolean; attestation?: unknown;
  archive?: Buffer; runs?: unknown } = {}): { gh: Gh; calls: string[][] } {
  const calls: string[][] = []
  const gh: Gh = args => {
    calls.push(args)
    if (overrides.apiFails) throw new Error('timeout')
    if (args[0] === 'attestation') {
      // Independent contract: do not derive the expectation from the production helper.
      assert.deepEqual(args, ['attestation', 'verify', args[2], '--hostname', 'github.com',
        '--repo', repository, '--signer-workflow', `${repository}/${WORKFLOW}`,
        '--signer-digest', sha, '--source-digest', sha, '--source-ref', identity.sourceRef,
        '--deny-self-hosted-runners', '--predicate-type', 'https://slsa.dev/provenance/v1', '--format', 'json'])
      assert.deepEqual(JSON.parse(readFileSync(args[2]!, 'utf8')), good())
      if (overrides.signatureFails) throw new Error('bad signature')
      return Buffer.from(JSON.stringify('attestation' in overrides ? overrides.attestation : verified()))
    }
    const path = args.at(-1)!
    let result: unknown
    if (path.includes('/workflows/')) result = overrides.runs ?? { workflow_runs: [overrides.run ?? run()] }
    else if (path.includes('/artifacts?')) result = overrides.artifacts ?? { total_count: 1,
      artifacts: [artifact()] }
    else if (path.endsWith('/zip')) return overrides.archive ?? zip(JSON.stringify(overrides.receipt ?? good()))
    else result = overrides.fresh ?? run()
    return Buffer.from(JSON.stringify(result))
  }
  return { gh, calls }
}

test('fetch validates downloaded bytes AND signature identity; leaves no acceptance cache', t => {
  const dir = fixture(t)
  const { gh, calls } = mockGithub()
  assert.deepEqual(fetchReceipt(ROOT, repository, sha, dir, gh), good())
  assert.equal(calls.filter(c => c[0] === 'attestation').length, 1)
  assert.ok(calls[0]!.at(-1)!.includes(`head_sha=${sha}&event=merge_group`))
  assert.deepEqual(readdirSync(dir), [])
})

test('certificate run, attempt and event must match even after gh exits successfully', t => {
  const dir = fixture(t)
  for (const attestation of [null, {}, [], 'verified', verified(null), verified({}),
    verified({ ...certificate(), buildTrigger: 'pull_request' }),
    verified({ ...certificate(), runInvocationURI: certificate().runInvocationURI.replace('/1234/', '/5678/') }),
    verified({ ...certificate(), runInvocationURI: certificate().runInvocationURI.replace('/attempts/2', '/attempts/1') }),
    verified({ ...certificate(), runInvocationURI: `${certificate().runInvocationURI}/extra` }),
    verified({ ...certificate(), runInvocationURI: certificate().runInvocationURI.replace(repository, 'fork/selfhost') }),
    [{ verificationResult: { statement: { predicate: certificate() } } }],
    [...verified(), ...verified({ ...certificate(), buildTrigger: 'push' })],
  ]) {
    const { gh, calls } = mockGithub({ attestation })
    assert.throws(() => fetchReceipt(ROOT, repository, sha, dir, gh))
    assert.deepEqual(readdirSync(dir), [])
    assert.equal(calls.at(-1)![0], 'attestation', 'reject before final API recheck')
  }
})

test('artifact metadata is tied to the authenticated workflow run before downloading', t => {
  const dir = fixture(t)
  const changes = [
    { id: 0 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { size_in_bytes: 0 }, { size_in_bytes: 131073 },
    { name: `${artifactName}-other` }, { expired: 'false' }, { workflow_run: undefined },
    ...Object.entries({ id: identity.runId + 1, repository_id: repositoryId + 1,
      head_repository_id: repositoryId + 1, head_sha: 'b'.repeat(40), head_branch: 'main' })
      .map(([key, value]) => ({ workflow_run: { ...artifact().workflow_run, [key]: value } })),
  ]
  for (const change of changes) {
    const { gh, calls } = mockGithub({ artifacts: { total_count: 1, artifacts: [{ ...artifact(), ...change }] } })
    assert.throws(() => fetchReceipt(ROOT, repository, sha, dir, gh))
    assert.equal(calls.length, 2, 'invalid metadata must not download or invoke verification')
    assert.deepEqual(readdirSync(dir), [])
  }
})

test('missing or ambiguous run pages and malformed downloads fail without acceptance state', t => {
  const dir = fixture(t)
  for (const override of [
    { runs: {} }, { runs: { workflow_runs: [] } }, { runs: { workflow_runs: [run(), run()] } },
    { runs: { workflow_runs: { 0: run() } } }, { archive: zip('invalid JSON') },
    { archive: Buffer.from('invalid zip') },
    { fresh: { ...run(), repository: { id: repositoryId + 1, full_name: repository },
      head_repository: { id: repositoryId + 1, full_name: repository } } },
  ]) {
    assert.throws(() => fetchReceipt(ROOT, repository, sha, dir, mockGithub(override).gh))
    assert.deepEqual(readdirSync(dir), [])
  }
  assert.deepEqual(attestationArgs('/tmp/receipt.json', identity).slice(-2), ['--format', 'json'])
})

test('archive reader rejects duplicate, directory, symlink and special-device entries', () => {
  for (const kind of ['duplicate', 'directory', 'symlink', 'device']) {
    const bytes = execFileSync('python3', ['-c', `
import io, stat, sys, zipfile, warnings
warnings.simplefilter('ignore', UserWarning)
b = io.BytesIO()
with zipfile.ZipFile(b, 'w') as z:
    f = zipfile.ZipInfo('receipt.json')
    f.create_system = 3
    f.external_attr = {'directory': stat.S_IFDIR, 'symlink': stat.S_IFLNK,
                       'device': stat.S_IFCHR, 'duplicate': stat.S_IFREG}[sys.argv[1]] << 16
    z.writestr(f, '{}')
    if sys.argv[1] == 'duplicate': z.writestr('receipt.json', '{}')
sys.stdout.buffer.write(b.getvalue())
`, kind])
    assert.throws(() => extractReceipt(bytes), kind)
  }
})

test('missing/malformed evidence, verifier errors and rerun races never return acceptance', t => {
  const dir = fixture(t)
  for (const override of [
    { signatureFails: true }, { apiFails: true }, { receipt: { ...good(), sourceSha: 'b'.repeat(40) } },
    { artifacts: { total_count: 0, artifacts: [] } },
    { artifacts: { total_count: 1, artifacts: [{ id: 987, name: artifactName, expired: true, size_in_bytes: 1024 }] } },
    { artifacts: { total_count: 2, artifacts: [] } },
    { fresh: { ...run(), run_attempt: 3 } }, { fresh: { ...run(), status: 'in_progress' } },
    { run: { ...run(), conclusion: 'failure' } },
  ]) {
    assert.throws(() => fetchReceipt(ROOT, repository, sha, dir, mockGithub(override).gh))
    assert.deepEqual(readdirSync(dir), [])
  }
  assert.throws(() => fetchReceipt(ROOT, '../untrusted/repo', sha, dir, mockGithub().gh))
})

const shell = read('scripts/lib/v5-selfhost-gate-receipts.sh')
const master = read('scripts/v5-selfhost-master-release-lib.sh')
// P3 moves P8's receipt decision to parent admission; workers never write summary notes.
const receiptJobs = [...master.matchAll(/^ {4}(C\.[a-z-]+):(master_job_\w+):([a-z-]+) \\$/gm)]
const admission = master.match(/^ {4}IFS=: read -r job_id job_fn gate_id[\s\S]*?^ {2}done/m)![0]
function jobFunction(name: string) {
  const body = master.match(new RegExp(`^ {2}${name}\\(\\) \\{[\\s\\S]*?^ {2}\\}`, 'm'))
  assert.ok(body, name)
  return body[0]
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
function bash(body: string, dir: string) {
  return spawnSync('bash', ['-eu', '-o', 'pipefail', '-c', `${shell}\n${body}`], {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, TMPDIR: dir, MASTER_GATE_RECEIPT_SHA: sha,
      MASTER_GATE_RECEIPT_IDS: data.gates.join('\n') },
  })
}

test('all real parent admissions rerun misses, propagate failure, and accept verified evidence', t => {
  const dir = fixture(t)
  assert.deepEqual(receiptJobs.map(m => m[3]).sort(), [...data.gates].sort())
  for (const job of receiptJobs) {
    for (const state of ['miss', 'hit', 'wrong-sha']) {
      for (const rc of [0, 41]) {
        const setup = `
mlog() { :; }
tsum_note() { :; }
cleanup_master_staging() { :; }
die() { exit 42; }
npx() { echo LOCAL; return ${rc}; }
node() { echo LOCAL; return ${rc}; }
bash() { echo LOCAL; return ${rc}; }
master_build_jobs_poll() { return 0; }
master_build_job_start() { shift; "$@"; }
full_sha=${sha}
staging=${quote(dir)}
MASTER_GATE_TMPDIR=${quote(dir)}
mkdir -p "$staging/scripts"
touch "$staging/scripts/v5-selfhost-watch-gate.sh"
${state === 'miss' ? '' : `MASTER_GATE_RECEIPT_IDS=${quote(data.gates.join('\n'))}\nMASTER_GATE_RECEIPT_SHA=${state === 'hit' ? sha : 'b'.repeat(40)}`}
${jobFunction(job[2]!)}
for job in ${quote(`${job[1]}:${job[2]}:${job[3]}`)}; do
${admission}
echo COMPLETE`
        const result = bash(setup, dir)
        assert.equal(result.status, state === 'hit' || rc === 0 ? 0 : 42, result.stderr)
        assert.equal(result.stdout.includes('LOCAL'), state !== 'hit')
      }
    }
  }
})

test('prepare is default off and clears inherited/previous-build acceptance on every miss', t => {
  const dir = fixture(t)
  for (const mode of ['off', 'cli-failure', 'malformed']) {
    const result = bash(`
mlog() { echo "$*"; }
tsum_note() { :; }
MASTER_GATE_RECEIPT_IDS=${quote(data.gates.join('\n'))}
MASTER_GATE_RECEIPT_SHA=${sha}
MASTER_GATE_TMPDIR=${quote(dir)}
OC_SELFHOST_GATE_RECEIPTS=${mode === 'off' ? '0' : '1'}
timeout() { ${mode === 'off' ? 'echo SHOULD_NOT_RUN; return 1' : mode === 'cli-failure' ? 'return 1' : 'echo broken-json'}; }
master_gate_receipt_prepare ${quote(dir)} ${sha}
test -z "$MASTER_GATE_RECEIPT_IDS"
test -z "$MASTER_GATE_RECEIPT_SHA"
! master_gate_receipt_has watch-gate ${sha}
`, dir)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(!result.stdout.includes('SHOULD_NOT_RUN'))
  }
})

test('prepare accepts a verified CLI hit then drops every gate on a later failed or disabled lookup', t => {
  const dir = fixture(t)
  for (const next of ['off', 'failed-with-output', 'malformed']) {
    const result = bash(`
mlog() { :; }
tsum_note() { echo "NOTE $1=$2"; }
MASTER_GATE_TMPDIR=${quote(dir)}
OC_SELFHOST_GATE_RECEIPTS=1
timeout() { printf '%s' ${quote(JSON.stringify(good()))}; }
master_gate_receipt_prepare ${quote(dir)} ${sha}
test "$MASTER_GATE_RECEIPT_SHA" = ${sha}
test "$MASTER_GATE_RECEIPT_IDS" = ${quote(data.gates.join('\n'))}
master_gate_receipt_has watch-gate ${sha}
! master_gate_receipt_has box-success-recovery ${sha}
! master_gate_receipt_has watch ${sha}
${next === 'off' ? 'OC_SELFHOST_GATE_RECEIPTS=0'
  : next === 'failed-with-output' ? `timeout() { printf '%s' ${quote(JSON.stringify(good()))}; return 1; }`
    : 'timeout() { echo broken-json; }'}
master_gate_receipt_prepare ${quote(dir)} ${'b'.repeat(40)}
test -z "$MASTER_GATE_RECEIPT_SHA"
test -z "$MASTER_GATE_RECEIPT_IDS"
! master_gate_receipt_has watch-gate ${sha}
! master_gate_receipt_has watch-gate ${'b'.repeat(40)}
`, dir)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /NOTE gateReceipt.run=1234\/2/)
    assert.match(result.stdout, /NOTE gateEvidence.watch-gate=merge-queue-receipt/)
    assert.match(result.stdout, /NOTE gateEvidence.box-success-recovery=local/)
    assert.match(result.stdout, /NOTE gateEvidence.watch-gate=local/)
  }
})

test('producer, train and policy agree; host gates remain local and parity coverage stays literal', () => {
  const workflow = parse(read(WORKFLOW))
  assert.deepEqual(workflow.on.merge_group, { types: ['checks_requested'] })
  assert.deepEqual(workflow.on.pull_request.branches, ['feat/v5-selfhost'])
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  const job = workflow.jobs.gates
  assert.equal(job['runs-on'], 'ubuntu-latest')
  assert.equal(job.needs, 'receipt-tests')
  assert.equal(job.if, `github.event_name == 'merge_group' && github.event.merge_group.base_ref == '${BASE_REF}'`)
  assert.deepEqual(job.permissions, { contents: 'read' })
  assert.equal(job['continue-on-error'], undefined)
  const manifest = JSON.parse(read(MANIFEST))
  const steps = job.steps.filter((s: { id?: string }) => s.id?.startsWith('gate_'))
  assert.deepEqual(steps.map((s: { id: string }) => s.id),
    data.gates.map(id => `gate_${id.replaceAll('-', '_')}`))
  for (const [index, id] of data.gates.entries()) {
    const step = steps[index]
    const gate = manifest.gates.find((g: { id: string }) => g.id === id)
    assert.equal(step.if, undefined)
    assert.equal(step['continue-on-error'], undefined)
    const command = gate.script.endsWith('.ts') ? `npx --no-install tsx ${gate.script}`
      : gate.script.endsWith('.mjs') ? `node ${gate.script}`
      : `bash ${gate.script} --log-dir "$RUNNER_TEMP/watch-gate"`
    assert.equal(step.run, command)
    const queued = receiptJobs.find(m => m[3] === id)
    assert.ok(queued, id)
    assert.ok(jobFunction(queued[2]!).includes(gate.script))
  }
  for (const host of ['box-success-recovery', 'box-continuation', 'box-incident-proofs', 'ccb-mcp-availability',
    'cursor-sand-inference', 'host-log-policy', 'architecture', 'web-react-production-build',
    'oc-memory-mcp-build', 'fix-trailers']) assert.ok(!data.gates.includes(host), host)
  const calls = runsIn(functionCommands(master, 'build_master_release'))
  for (const gate of manifest.gates.filter((g: { stage?: string }) => !g.stage)) {
    assert.ok(gate.script ? calls.scripts.has(gate.script) : calls.npm.has(gate.command), gate.id)
  }
  const signer = workflow.jobs.attest
  assert.equal(signer.needs, 'gates')
  assert.equal(signer.if, job.if)
  assert.equal(signer['runs-on'], 'ubuntu-latest')
  assert.equal(signer.permissions['id-token'], 'write')
  assert.equal(signer['continue-on-error'], undefined)
  assert.equal(signer.steps.length, 3)
  for (const s of signer.steps) {
    assert.match(s.uses, /^actions\/(download-artifact|attest-build-provenance|upload-artifact)@[0-9a-f]{40}$/)
    assert.equal(s.run, undefined)
    assert.equal(s.if, undefined)
    assert.equal(s['continue-on-error'], undefined)
  }
  assert.match(master, /build_master_release\(\) \{\n[^\n]*\n {2}MASTER_GATE_RECEIPT_IDS=""\n {2}MASTER_GATE_RECEIPT_SHA=""/)
  assert.ok(master.indexOf('master_gate_receipt_prepare "$staging" "$full_sha"') > master.indexOf('if ! create_master_gate_tmpdir;'))
  assert.equal(JSON.parse(read(POLICY)).schema, 'oc.v5.selfhost.gate-receipt-policy/1')
})
