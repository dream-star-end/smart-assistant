/**
 * M4e: original consult token survives process restart without shared HMAC keys.
 * Billing 2xx receipts project settle_pending without a manual Gateway hook.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CONSULT_INVOCATION_HEADER } from '@openclaude/protocol'

import { AdvisorConsultStore, hashEvidence, mintConsultId } from '../advisorConsultStore.js'
import {
  DELEGATE_CONTEXT_HEADER,
  inspectConsultTurnToken,
  issueConsultTurnToken,
  resetDelegateContextKeyForTests,
} from '../delegateContext.js'
import {
  createDelegateEngineBillingClient,
  setDelegateEngineBillingSettledHook,
} from '../delegateEngineBilling.js'
import { Gateway } from '../server.js'

const SESSION = 'agent:main:webchat:dm:restart-probe'
const TURN = 'a'.repeat(64)
const REQUEST_ID = 'ab'.repeat(16)
const INVOCATION = 'cinv-restart-m4e'

process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
process.env.OC_MODEL_AUTHORITY = '0'

afterEach(() => {
  setDelegateEngineBillingSettledHook(undefined)
  resetDelegateContextKeyForTests()
})
after(() => {
  setDelegateEngineBillingSettledHook(undefined)
  resetDelegateContextKeyForTests()
})

function settledRow(over: Record<string, unknown> = {}) {
  return {
    consultId: mintConsultId(),
    invocationId: INVOCATION,
    userId: '3',
    sessionKey: SESSION,
    clientSessionId: 'restart-probe',
    originTurnKey: TURN,
    originTurnIndex: 1,
    configVersion: 'v1:advisor:gpt-6-astra',
    evidenceVersion: hashEvidence('{}'),
    advisorModel: 'gpt-6-astra',
    question: 'why red?',
    concern: '',
    snapshotJson: '{}',
    jobId: null,
    billingRequestId: REQUEST_ID,
    advice: 'ORIGINAL_ADVICE',
    state: 'settled' as const,
    ...over,
  }
}

async function replay(opts: {
  dir: string
  token: string
  userId?: string
  sessions?: unknown
  question?: string
  invocation?: string
}) {
  const store = new AdvisorConsultStore(join(opts.dir, 'advisor.db'))
  const gw = Object.create(Gateway.prototype) as any
  gw._advisorConsults = store
  gw.getUserId = () => opts.userId ?? '3'
  gw.readBody = async () => JSON.stringify({ question: opts.question ?? 'why red?' })
  gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  gw.sessions = opts.sessions ?? { getByKey: () => undefined }
  let status = 0
  let raw = ''
  await gw.handleConsultAdvisor(
    {
      method: 'POST',
      headers: {
        [DELEGATE_CONTEXT_HEADER]: opts.token,
        [CONSULT_INVOCATION_HEADER]: opts.invocation ?? INVOCATION,
      },
    },
    {
      writeHead: (code: number) => {
        status = code
      },
      end: (chunk?: unknown) => {
        raw = String(chunk ?? '')
      },
    },
  )
  const body = raw ? JSON.parse(raw) : {}
  const rec = store.findByInvocation({
    userId: '3',
    originTurnKey: TURN,
    invocationId: INVOCATION,
  })
  store.close()
  return { status, body, recordState: rec?.state }
}

describe('advisor consult restart recovery', () => {
  it('original token rereads settled advice after HMAC key rotation without a parent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-adv-restart-'))
    const store = new AdvisorConsultStore(join(dir, 'advisor.db'))
    store.insertNew(settledRow())
    const token = issueConsultTurnToken({
      agentId: 'main',
      sessionKey: SESSION,
      depth: 0,
      turnKey: TURN,
      turnIndex: 1,
      collabMode: 'advisor',
      configVersion: 'v1:advisor:gpt-6-astra',
    })
    store.close()
    resetDelegateContextKeyForTests()
    assert.equal(inspectConsultTurnToken(token)?.hmacOk, false)
    const got = await replay({ dir, token })
    assert.equal(got.status, 200, JSON.stringify(got.body))
    assert.equal(got.body.advice, 'ORIGINAL_ADVICE')
    assert.equal(got.recordState, 'settled')
  })

  it('rejects expired, forged, other-user, unknown invocation, and new consults without HMAC', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-adv-neg-'))
    const store = new AdvisorConsultStore(join(dir, 'advisor.db'))
    store.insertNew(settledRow())
    const token = issueConsultTurnToken({
      agentId: 'main',
      sessionKey: SESSION,
      depth: 0,
      turnKey: TURN,
      turnIndex: 1,
      collabMode: 'advisor',
      configVersion: 'v1:advisor:gpt-6-astra',
    })
    const expired = issueConsultTurnToken({
      agentId: 'main',
      sessionKey: SESSION,
      depth: 0,
      turnKey: TURN,
      turnIndex: 1,
      collabMode: 'advisor',
      configVersion: 'v1:advisor:gpt-6-astra',
      ttlMs: 1,
    })
    store.close()
    await new Promise((r) => setTimeout(r, 5))
    resetDelegateContextKeyForTests()

    const other = await replay({ dir, token, userId: '9' })
    assert.equal(other.status, 401)

    const conflict = await replay({ dir, token, question: 'a different question' })
    assert.equal(conflict.status, 409)

    const unknown = await replay({ dir, token, invocation: 'cinv-not-registered' })
    assert.equal(unknown.status, 401)

    const parts = token.split('.')
    const payload = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'))
    payload.sessionKey = 'agent:main:webchat:dm:forged'
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[1]}`
    const forgedGot = await replay({ dir, token: forged })
    assert.equal(forgedGot.status, 401)

    const expiredGot = await replay({ dir, token: expired })
    assert.equal(expiredGot.status, 401)
  })

  it('two real processes: original token, no shared test key, no parent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-adv-proc-restart-'))
    const child = fileURLToPath(new URL('./advisorConsultRestartChild.ts', import.meta.url))
    const run = (mode: string) => {
      const r = spawnSync(process.execPath, ['--import', 'tsx', child, mode], {
        env: { ...process.env, OC_ADVISOR_RESTART_HOME: dir, OC_SELFHOST_ENGINE_LOCAL_TURNS: '1' },
        encoding: 'utf8',
        timeout: 45_000,
      })
      if (r.status !== 0) throw new Error(r.stderr || r.stdout)
      const line = r.stdout
        .trim()
        .split('\n')
        .filter((row) => row.startsWith('{'))
        .at(-1)
      if (!line) throw new Error(r.stdout)
      return JSON.parse(line)
    }
    run('mint')
    const replayed = run('replay')
    assert.equal(replayed.status, 200, JSON.stringify(replayed))
    assert.equal(replayed.body.advice, 'ORIGINAL_ADVICE')
    assert.equal(replayed.hmacOk, false)
    assert.equal(replayed.parentPresent, false)
  })
})

describe('advisor consult billing startup projection', () => {
  it('retryPending 2xx projects open store before Gateway lazy bind, without a manual hook', async () => {
    setDelegateEngineBillingSettledHook(undefined)
    const dir = await mkdtemp(join(tmpdir(), 'oc-adv-bill-proj-'))
    const db = new AdvisorConsultStore(join(dir, 'billing-consults.db'))
    const record = db.insertNew({ ...settledRow(), state: 'settle_pending' }).record
    const queuePath = join(dir, 'billing-queue.json')
    const billing = {
      requestId: REQUEST_ID,
      engineSessionId: `oceng-${'b'.repeat(48)}`,
      status: 'success' as const,
      durationMs: 12,
      usage: { input_tokens: 8, output_tokens: 3 },
      delegateAgentId: 'advisor',
      parentSessionId: 'restart-probe',
    }
    await writeFile(queuePath, `${JSON.stringify({ schemaVersion: 1, pending: [billing] })}\n`)
    let posts = 0
    const client = createDelegateEngineBillingClient({
      env: {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:9',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'tok',
      },
      queuePath,
      startupRecovery: false,
      fetcher: (async () => {
        posts += 1
        return {
          statusCode: 200,
          body: (async function* () {
            yield Buffer.from('{"settled":true}')
          })(),
        }
      }) as never,
    })
    await client.retryPending?.()
    assert.equal(posts, 1)
    assert.equal(db.findById(record.consultId)?.state, 'settled')
    const queue = JSON.parse(await readFile(queuePath, 'utf8')) as { pending: unknown[] }
    assert.equal(queue.pending.length, 0)
    const gw = Object.create(Gateway.prototype) as any
    gw._advisorConsults = db
    gw.log = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} }
    gw.advisorConsultStore()
    assert.equal(db.findById(record.consultId)?.state, 'settled')
    db.close()
  })

  it('local consult.update failure after 2xx still converges from settled receipt', async () => {
    setDelegateEngineBillingSettledHook(undefined)
    const dir = await mkdtemp(join(tmpdir(), 'oc-adv-upd-fail-'))
    const db = new AdvisorConsultStore(join(dir, 'consults.db'))
    const record = db.insertNew({
      ...settledRow(),
      state: 'spawned',
      advice: 'ORIGINAL_ADVICE',
    }).record
    const orig = db.update.bind(db)
    let fails = 0
    db.update = ((id: string, patch: { state?: string }) => {
      if (patch.state === 'settled' && fails === 0) {
        fails += 1
        throw new Error('injected local write failure')
      }
      return orig(id, patch as Parameters<typeof orig>[1])
    }) as typeof db.update
    const queuePath = join(dir, 'queue.json')
    const client = createDelegateEngineBillingClient({
      env: {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:9',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'tok',
      },
      queuePath,
      startupRecovery: false,
      fetcher: (async () => ({
        statusCode: 200,
        body: (async function* () {
          yield Buffer.from('{"settled":true}')
        })(),
      })) as never,
    })
    await client.settle({
      requestId: REQUEST_ID,
      engineSessionId: `oceng-${'b'.repeat(48)}`,
      status: 'success',
      durationMs: 3,
      delegateAgentId: 'advisor',
    })
    assert.equal(fails, 1)
    assert.equal(db.findById(record.consultId)?.state, 'spawned')
    const queue = JSON.parse(await readFile(queuePath, 'utf8')) as {
      pending: unknown[]
      settledReceipts: Array<{ requestId: string }>
    }
    assert.equal(queue.pending.length, 0)
    assert.equal(queue.settledReceipts.some((row) => row.requestId === REQUEST_ID), true)
    await client.projectConsults?.(db)
    assert.equal(db.findById(record.consultId)?.state, 'settled')
    assert.equal(db.findById(record.consultId)?.advice, 'ORIGINAL_ADVICE')
    db.close()
  })
})
