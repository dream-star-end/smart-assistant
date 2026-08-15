import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const worker = path.join(root, 'scripts/v5-release-worker.sh')
const QUEUE_ID = 'rq-20260816T010000Z-abcdef123456'

function sh(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [worker, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function parseCard(stdout: string): { id: string; phase: string; card: Record<string, unknown> } {
  const marker = stdout.indexOf('OC_RELEASE_JOB_V1')
  assert.notEqual(marker, -1, `missing card marker: ${stdout}`)
  const jsonText = stdout.slice(marker + 'OC_RELEASE_JOB_V1'.length).trim()
  const job = JSON.parse(jsonText) as {
    id: string
    phase: string
    card: Record<string, unknown>
  }
  assert.match(job.id, /^rel-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/)
  assert.equal(job.card.kind, 'release_progress')
  assert.equal(job.card.runId, job.id)
  return job
}

function fakeBins(opts: {
  acquireRc?: number
  acquireOut?: string
  detachedRc?: number
  detachedOut?: string
  statusBlob?: string
  smokeOut?: string
}): { bin: string; dir: string; cleanup: () => void; queueLog: string; detachedLog: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-release-worker-'))
  const bin = path.join(dir, 'bin')
  spawnSync('mkdir', ['-p', bin])
  const queueLog = path.join(dir, 'queue.log')
  const detachedLog = path.join(dir, 'detached.log')
  writeFileSync(
    path.join(bin, 'v5-release-queue.sh'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"${queueLog}"
if [[ "\$1" == acquire ]]; then
  echo "${opts.acquireOut ?? QUEUE_ID}"
  exit ${opts.acquireRc ?? 0}
fi
exit 2
`,
  )
  writeFileSync(
    path.join(bin, 'v5-deploy-detached.sh'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"${detachedLog}"
if [[ "\$1" == start ]]; then
  if [[ "\$*" == *"--smoke"* && "\$*" != *"--with-dist"* ]]; then
    echo "${opts.smokeOut ?? 'openclaude-v5-deploy-20260816-010000-deadbeef-smoke.service'}"
    exit 0
  fi
  echo "${opts.detachedOut ?? 'openclaude-v5-deploy-20260816-010000-deadbeef-with-dist.service'}"
  exit ${opts.detachedRc ?? 0}
fi
if [[ "\$1" == status ]]; then
  printf '%s\\n' "${opts.statusBlob ?? 'LoadState=loaded\\nActiveState=inactive\\nSubState=exited\\nExecMainStatus=0'}"
  exit 0
fi
exit 2
`,
  )
  chmodSync(path.join(bin, 'v5-release-queue.sh'), 0o755)
  chmodSync(path.join(bin, 'v5-deploy-detached.sh'), 0o755)
  return {
    bin,
    dir,
    queueLog,
    detachedLog,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function envFor(fake: ReturnType<typeof fakeBins>, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const jobs = path.join(fake.dir, 'jobs')
  return {
    OC_V5_RELEASE_JOB_DIR: jobs,
    OC_V5_RELEASE_WORKER_RUN_DIR: path.join(fake.dir, 'run'),
    OC_V5_RELEASE_QUEUE_BIN: path.join(fake.bin, 'v5-release-queue.sh'),
    OC_V5_DEPLOY_DETACHED_BIN: path.join(fake.bin, 'v5-deploy-detached.sh'),
    OC_V5_RELEASE_SUPERVISE: '0',
    OC_V5_RELEASE_POLL_SECONDS: '1',
    OC_V5_RELEASE_STARTUP_POLLS: '2',
    ...extra,
  }
}

test('start refuses to bypass the release queue or official deploy args', () => {
  const fake = fakeBins({})
  try {
    const missing = sh(['start', '--owner', 'agent', '--', '--with-dist'], envFor(fake))
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /必须提供已存在的 --queue-id/)

    const skip = sh(
      ['start', '--owner', 'agent', '--queue-id', QUEUE_ID, '--skip-queue', '--', '--with-dist'],
      envFor(fake),
    )
    assert.equal(skip.status, 2)
    assert.match(skip.stderr, /拒绝绕过安全约束/)

    const unverified = sh(
      ['start', '--owner', 'agent', '--queue-id', QUEUE_ID, '--', '--allow-unverified-ci'],
      envFor(fake),
    )
    assert.equal(unverified.status, 2)
    assert.match(unverified.stderr, /拒绝绕过安全约束/)
  } finally {
    fake.cleanup()
  }
})

test('start acquires the queue with --daemon then hands off to detached deploy', () => {
  const fake = fakeBins({})
  try {
    const result = sh(
      ['start', '--owner', 'agent', '--queue-id', QUEUE_ID, '--title', 'canary-release', '--', '--with-dist'],
      envFor(fake),
    )
    assert.equal(result.status, 0, result.stderr)
    const job = parseCard(result.stdout)
    assert.equal(job.phase, 'deploying')
    assert.match(result.stderr, /发布已转入后台/)
    assert.match(readFileSync(fake.queueLog, 'utf8'), /acquire --id .* --owner agent --daemon/)
    assert.match(readFileSync(fake.detachedLog, 'utf8'), /start -- --with-dist/)
    const stored = JSON.parse(readFileSync(path.join(fake.dir, 'jobs', `${job.id}.json`), 'utf8'))
    assert.equal(stored.queueId, QUEUE_ID)
    assert.equal(stored.deployUnit, 'openclaude-v5-deploy-20260816-010000-deadbeef-with-dist.service')
    assert.equal(stored.card.kind, 'release_progress')
    assert.equal(stored.card._completed, false)
  } finally {
    fake.cleanup()
  }
})

test('start records acquire 75 as a failed job with a recall envelope', () => {
  const fake = fakeBins({ acquireRc: 75, acquireOut: 'stale foreign active' })
  const hookLog = path.join(fake.dir, 'hook.log')
  try {
    const result = sh(
      ['start', '--owner', 'agent', '--queue-id', QUEUE_ID, '--', '--with-dist'],
      envFor(fake, { OC_V5_RELEASE_RECALL_CMD: `echo hooked >>${hookLog}` }),
    )
    assert.equal(result.status, 75, result.stderr)
    const job = parseCard(result.stdout)
    assert.equal(job.phase, 'failed')
    assert.equal(job.card._isError, true)
    const recall = JSON.parse(readFileSync(path.join(fake.dir, 'jobs', `${job.id}.recall.json`), 'utf8'))
    assert.equal(recall.kind, 'release_recall')
    assert.equal(recall.reminderKind, 'task')
    assert.equal(recall.deliver, 'webchat')
    assert.match(recall.prompt, /abandon-active/)
    assert.equal(existsSync(hookLog), true)
    const listed = sh(['failed'], envFor(fake))
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, new RegExp(job.id))
  } finally {
    fake.cleanup()
  }
})

test('supervisor marks completed from an exited official unit without blocking the agent', () => {
  const fake = fakeBins({
    statusBlob: 'LoadState=loaded\nActiveState=inactive\nSubState=exited\nExecMainStatus=0',
  })
  try {
    const started = sh(
      ['start', '--owner', 'agent', '--queue-id', QUEUE_ID, '--', '--with-dist'],
      envFor(fake),
    )
    const job = parseCard(started.stdout)
    const supervised = sh(['__supervise', '--id', job.id], envFor(fake))
    assert.equal(supervised.status, 0, supervised.stderr)
    const stored = JSON.parse(readFileSync(path.join(fake.dir, 'jobs', `${job.id}.json`), 'utf8'))
    assert.equal(stored.phase, 'completed')
    assert.equal(stored.card._completed, true)
    assert.equal(stored.recallRequired, false)
  } finally {
    fake.cleanup()
  }
})

test('supervisor marks failed + recall when the official unit exits non-zero', () => {
  const fake = fakeBins({
    statusBlob: 'LoadState=loaded\nActiveState=inactive\nSubState=exited\nExecMainStatus=7',
  })
  try {
    const started = sh(
      ['start', '--owner', 'agent', '--queue-id', QUEUE_ID, '--', '--with-dist'],
      envFor(fake),
    )
    const job = parseCard(started.stdout)
    const supervised = sh(['__supervise', '--id', job.id], envFor(fake))
    assert.equal(supervised.status, 0, supervised.stderr)
    const stored = JSON.parse(readFileSync(path.join(fake.dir, 'jobs', `${job.id}.json`), 'utf8'))
    assert.equal(stored.phase, 'failed')
    assert.equal(stored.exitCode, 7)
    assert.equal(stored.recallRequired, true)
    assert.match(stored.nextStep, /官方 --abort|--rollback/)
    assert.equal(existsSync(path.join(fake.dir, 'jobs', `${job.id}.recall.json`)), true)
  } finally {
    fake.cleanup()
  }
})

test('supervisor records official --rollback success as rolled_back', () => {
  const fake = fakeBins({
    statusBlob: 'LoadState=loaded\nActiveState=inactive\nSubState=exited\nExecMainStatus=0',
  })
  try {
    const started = sh(
      ['start', '--owner', 'agent', '--queue-id', QUEUE_ID, '--', '--rollback'],
      envFor(fake),
    )
    const job = parseCard(started.stdout)
    const supervised = sh(['__supervise', '--id', job.id], envFor(fake))
    assert.equal(supervised.status, 0, supervised.stderr)
    const stored = JSON.parse(readFileSync(path.join(fake.dir, 'jobs', `${job.id}.json`), 'utf8'))
    assert.equal(stored.phase, 'rolled_back')
  } finally {
    fake.cleanup()
  }
})

test('illegal phase transitions fail closed', () => {
  const fake = fakeBins({})
  try {
    const started = sh(
      ['start', '--owner', 'agent', '--queue-id', QUEUE_ID, '--', '--with-dist'],
      envFor(fake),
    )
    const job = parseCard(started.stdout)
    const jump = sh(['__transition', '--id', job.id, '--to', 'queued'], envFor(fake))
    assert.equal(jump.status, 2)
    assert.match(jump.stderr, /非法状态转移:deploying → queued/)
    const ok = sh(['__transition', '--id', job.id, '--to', 'smoking', '--text', '冒烟'], envFor(fake))
    assert.equal(ok.status, 0, ok.stderr)
    const stored = JSON.parse(readFileSync(path.join(fake.dir, 'jobs', `${job.id}.json`), 'utf8'))
    assert.equal(stored.phase, 'smoking')
  } finally {
    fake.cleanup()
  }
})

test('status is a non-blocking snapshot and refuses a second overlapping start', () => {
  const fake = fakeBins({})
  try {
    const first = sh(
      ['start', '--owner', 'agent', '--queue-id', QUEUE_ID, '--', '--with-dist'],
      envFor(fake),
    )
    const job = parseCard(first.stdout)
    const status = sh(['status', '--id', job.id, '--json'], envFor(fake))
    assert.equal(status.status, 0, status.stderr)
    assert.doesNotMatch(status.stdout, /sleep/)
    const parsed = JSON.parse(status.stdout)
    assert.equal(parsed.id, job.id)
    const second = sh(
      ['start', '--owner', 'agent', '--queue-id', QUEUE_ID, '--', '--smoke'],
      envFor(fake),
    )
    assert.equal(second.status, 2)
    assert.match(second.stderr, /已有未完成发布任务/)
  } finally {
    fake.cleanup()
  }
})
