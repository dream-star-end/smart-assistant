import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { BASE_REF, MANIFEST, POLICY, QUEUE_REF, WORKFLOW, inputs } from '../lib/selfhostGateReceipt.js'

const ROOT = join(import.meta.dirname, '../..')
const CLI = join(ROOT, 'scripts/v5-selfhost-gate-receipts.ts')
const ERROR = '[gate-receipt] unavailable or invalid; local gates required\n'
const SECRET = 'fixture-private-value-must-not-leak'

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'candidate')
  const bin = join(dir, 'bin')
  const scratch = join(dir, 'scratch')
  for (const p of [root, bin, scratch]) mkdirSync(p)
  for (const path of [MANIFEST, POLICY, WORKFLOW]) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), readFileSync(join(ROOT, path)))
  }
  // Tiny disposable fixture repository, not a worktree or a checkout of application code.
  const env = { PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'receipt fixture')
  const sha = git('rev-parse', 'HEAD')
  const ref = `${QUEUE_REF}pr-1-${sha}`
  const event = { action: 'checks_requested', merge_group: { base_ref: BASE_REF, head_sha: sha, head_ref: ref } }
  const eventPath = join(dir, 'event.json')
  writeFileSync(eventPath, JSON.stringify(event))
  const outcomes = Object.fromEntries(inputs(root).gates.map(id => [
    `gate_${id.replaceAll('-', '_')}`, { outcome: 'success', conclusion: 'success', outputs: {} },
  ]))
  const ciEnv = { ...env, GITHUB_EVENT_NAME: 'merge_group', GITHUB_EVENT_PATH: eventPath,
    GITHUB_SHA: sha, GITHUB_REF: ref, GITHUB_REPOSITORY: 'owner/selfhost', GITHUB_RUN_ID: '1234',
    GITHUB_RUN_ATTEMPT: '2', GATE_RESULTS: JSON.stringify(outcomes) }
  const invoke = (mode: string, output: string, overrides: Record<string, string> = {}, source = sha) =>
    spawnSync(process.execPath, ['--import', 'tsx', CLI, mode, root, source, output], {
      cwd: ROOT, env: { ...ciEnv, ...overrides }, encoding: 'utf8', timeout: 25_000,
    })
  return { dir, root, bin, scratch, sha, ref, event, eventPath, outcomes, invoke }
}

test('issue CLI pins actual checkout/event and writes exactly once', t => {
  const f = fixture(t)
  const output = join(f.dir, 'receipt.json')
  const result = f.invoke('issue', output)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  const bytes = readFileSync(output, 'utf8')
  const receipt = JSON.parse(bytes)
  assert.equal(receipt.sourceSha, f.sha)
  assert.equal(receipt.sourceRef, f.ref)
  assert.equal(receipt.runId, 1234)
  assert.equal(receipt.runAttempt, 2)
  assert.deepEqual(receipt.gates, inputs(f.root).gates)
  assert.equal(f.invoke('issue', output).status, 1)
  assert.equal(readFileSync(output, 'utf8'), bytes)
})

test('issue CLI rejects invalid event, checkout, identity and masked gate outcomes without output', t => {
  const f = fixture(t)
  const output = join(f.dir, 'rejected.json')
  const key = Object.keys(f.outcomes)[0]!
  const failures: Record<string, string>[] = [
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ATTEMPT: '1.5' }, { GATE_RESULTS: SECRET },
    { GATE_RESULTS: JSON.stringify({ ...f.outcomes, [key]: { outcome: 'failure', conclusion: 'success' } }) },
    { GATE_RESULTS: '{}' },
  ]
  const rejected = (result: ReturnType<typeof f.invoke>) => {
    assert.equal(result.status, 1, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, ERROR)
    assert.equal(existsSync(output), false)
  }
  for (const env of failures) rejected(f.invoke('issue', output, env))
  for (const event of [
    { ...f.event, action: 'destroyed' },
    { ...f.event, merge_group: { ...f.event.merge_group, base_ref: 'refs/heads/main' } },
    { ...f.event, merge_group: { ...f.event.merge_group, head_sha: 'b'.repeat(40) } },
    { ...f.event, merge_group: { ...f.event.merge_group, head_ref: `${f.ref}-other` } },
  ]) {
    writeFileSync(f.eventPath, JSON.stringify(event))
    rejected(f.invoke('issue', output))
  }
  // Both event and GITHUB_SHA agree, but actual git HEAD does not.
  writeFileSync(f.eventPath, JSON.stringify({ ...f.event,
    merge_group: { ...f.event.merge_group, head_sha: 'b'.repeat(40) } }))
  rejected(f.invoke('issue', output, { GITHUB_SHA: 'b'.repeat(40) }, 'b'.repeat(40)))
})

test('fetch CLI invokes real gh adapter and fails closed on invalid JSON, signature failure or timeout', t => {
  const f = fixture(t)
  const receiptPath = join(f.dir, 'receipt.json')
  assert.equal(f.invoke('issue', receiptPath).status, 0)
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  const run = { id: 1234, run_attempt: 2, head_sha: f.sha,
    head_branch: f.ref.slice('refs/heads/'.length), path: WORKFLOW, event: 'merge_group',
    status: 'completed', conclusion: 'success', repository: { id: 4321, full_name: 'owner/selfhost' },
    head_repository: { id: 4321, full_name: 'owner/selfhost' } }
  writeFileSync(join(f.dir, 'run.json'), JSON.stringify(run))
  writeFileSync(join(f.bin, 'gh'), `#!/usr/bin/env python3
import io, json, os, pathlib, sys, time, zipfile
p = pathlib.Path(os.environ['FIXTURE_DIR'])
args = sys.argv[1:]
with (p / 'calls.jsonl').open('a') as log: log.write(json.dumps(args) + '\\n')
mode = os.environ.get('FIXTURE_MODE', 'valid')
if mode == 'api-invalid' and args[0] == 'api':
    print('${SECRET}'); sys.exit(0)
if args[0] == 'attestation':
    if mode == 'timeout': time.sleep(20)
    if mode == 'signature-failure':
        print('${SECRET}', file=sys.stderr); sys.exit(1)
    if mode == 'verifier-invalid': print('${SECRET}'); sys.exit(0)
    certificate = {'buildTrigger': 'merge_group',
      'runInvocationURI': 'https://github.com/owner/selfhost/actions/runs/1234/attempts/' + ('1' if mode == 'old-attempt' else '2')}
    print(json.dumps([{'verificationResult': {'signature': {'certificate': certificate}}}]))
else:
    run = json.loads((p / 'run.json').read_text())
    if '/workflows/' in args[-1]: print(json.dumps({'workflow_runs': [run]}))
    elif '/artifacts?' in args[-1]:
        print(json.dumps({'total_count': 1, 'artifacts': [{'id': 987,
          'name': 'selfhost-gate-receipt-' + run['head_sha'] + '-2', 'expired': False, 'size_in_bytes': 1024,
          'workflow_run': {'id': 1234, 'repository_id': 4321, 'head_repository_id': 4321,
            'head_sha': run['head_sha'], 'head_branch': run['head_branch']}}]}))
    elif args[-1].endswith('/zip'):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as z: z.writestr('receipt.json', (p / 'receipt.json').read_bytes())
        sys.stdout.buffer.write(buf.getvalue())
    else: print(json.dumps(run))
`, { mode: 0o700 })
  const enabled = { OC_SELFHOST_GATE_RECEIPTS: '1', OC_SELFHOST_GATE_RECEIPT_REPO: 'owner/selfhost', FIXTURE_DIR: f.dir }
  const good = f.invoke('fetch', f.scratch, enabled)
  assert.equal(good.status, 0, good.stderr)
  assert.deepEqual(JSON.parse(good.stdout), receipt)
  assert.equal(good.stderr, '')
  assert.deepEqual(readdirSync(f.scratch), [])
  const calls = readFileSync(join(f.dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(calls.length, 5)
  assert.ok(calls.every(args => args.includes('--hostname') && args.includes('github.com')))
  assert.deepEqual(calls[3].slice(-2), ['--format', 'json'])
  for (const mode of ['api-invalid', 'verifier-invalid', 'signature-failure', 'old-attempt', 'timeout']) {
    const result = f.invoke('fetch', f.scratch, { ...enabled, FIXTURE_MODE: mode })
    assert.equal(result.status, 1, mode)
    assert.equal(result.stdout, '', mode)
    assert.equal(result.stderr, ERROR, mode)
    assert.deepEqual(readdirSync(f.scratch), [], mode)
  }
  for (const env of [{ OC_SELFHOST_GATE_RECEIPTS: '0' }, { OC_SELFHOST_GATE_RECEIPT_REPO: '' }]) {
    const result = f.invoke('fetch', f.scratch, { ...enabled, ...env })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, ERROR)
  }
})
