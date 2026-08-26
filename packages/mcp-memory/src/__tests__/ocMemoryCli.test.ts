import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

type RunResult = { code: number | null; stdout: string; stderr: string }

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const TSX = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const ENTRY = join(REPO_ROOT, 'packages/mcp-memory/src/ocMemoryCli.ts')

function runCli(
  home: string,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<RunResult> {
  return new Promise((done, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      OPENCLAUDE_HOME: home,
      OC_AGENT_ID: 'cli-test-agent',
    }
    delete env.OPENCLAUDE_DELEGATE_CONTEXT_FILE
    delete env.OPENCLAUDE_AGENT_ID
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
    const child = spawn(process.execPath, [TSX, ENTRY, ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.once('error', reject)
    child.once('close', (code) => done({ code, stdout, stderr }))
  })
}

test('oc-memory covers help, retired Core, Recall and all Archival operations', async () => {
  const home = mkdtempSync(join(tmpdir(), 'oc-memory-cli-'))
  try {
    let result = await runCli(home, ['--help'])
    assert.equal(result.code, 0, result.stderr)
    for (const command of [
      'session-search',
      'archival-add',
      'archival-search',
      'archival-delete',
      'delegate-wait',
      'delegate',
      'request-review',
    ]) {
      assert.match(result.stdout, new RegExp(command))
    }

    result = await runCli(home, ['delegate-wait'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /delegate-wait requires at least one/)

    result = await runCli(home, ['delegate'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /OPENCLAUDE_DELEGATE_CONTEXT_FILE/)

    result = await runCli(home, ['memory', '--action', 'read'])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /子命令已退役/)
    assert.match(result.stderr, /agents\/cli-test-agent\/memory/)

    result = await runCli(home, ['session-search', 'no-such-session', '--limit', '2'])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /No past sessions match/)

    result = await runCli(home, [
      'archival-add',
      'unique oc-memory cli coverage entry',
      '--tags',
      'cli,coverage',
    ])
    assert.equal(result.code, 0, result.stderr)
    const id = /id=(arc-[a-z0-9-]+)/i.exec(result.stdout)?.[1]
    assert.ok(id, result.stdout)

    result = await runCli(home, ['archival-search', '*', '--limit', '1'])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, new RegExp(id))
    assert.match(result.stdout, /unique oc-memory cli coverage entry/)

    result = await runCli(home, ['archival-add', 'pending heartbeat item'])
    assert.equal(result.code, 0, result.stderr)
    const pendingId = /id=(arc-[a-z0-9-]+)/i.exec(result.stdout)?.[1]
    assert.ok(pendingId, result.stdout)

    result = await runCli(home, [
      'archival-search',
      'pending OR reminder OR TODO OR deadline',
      '--limit',
      '3',
    ])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, new RegExp(pendingId))
    assert.match(result.stdout, /pending heartbeat item/)

    result = await runCli(home, ['archival-delete', pendingId])
    assert.equal(result.code, 0, result.stderr)

    result = await runCli(home, [
      'archival-search',
      'unique oc-memory cli coverage entry',
      '--limit',
      '3',
    ])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, new RegExp(id))
    assert.match(result.stdout, /tags=cli,coverage/)

    result = await runCli(home, ['archival-delete', id])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, new RegExp(id))

    result = await runCli(home, ['archival-search', id])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /No archival entries match/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('oc-memory delegate rejects self-delegate', async () => {
  const home = mkdtempSync(join(tmpdir(), 'oc-memory-cli-self-'))
  const ctx = join(home, 'delegate-context')
  writeFileSync(ctx, 'tok-self-delegate\n')
  try {
    let result = await runCli(
      home,
      ['delegate', '--goal', '自诊断', '--agent-id', 'cli-test-agent'],
      { OPENCLAUDE_DELEGATE_CONTEXT_FILE: ctx },
    )
    assert.equal(result.code, 1)
    assert.match(result.stderr, /oc-memory:/)
    assert.match(result.stderr, /不能把任务委派给自己/)

    result = await runCli(home, ['delegate', '--goal', '缺省自身'], {
      OPENCLAUDE_DELEGATE_CONTEXT_FILE: ctx,
      OC_AGENT_ID: 'main',
      OPENCLAUDE_AGENT_ID: undefined,
    })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /oc-memory:/)
    assert.match(result.stderr, /不能把任务委派给自己/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
