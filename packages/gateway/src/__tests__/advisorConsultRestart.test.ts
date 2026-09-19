/**
 * M4f: existing consult recovery requires current HMAC or the exact stored
 * token receipt. Direct-insert rows without a receipt are 401 after key
 * rotation. Billing 2xx projection is unchanged.
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
  hashConsultTurnToken,
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

function mintToken() {
  return issueConsultTurnToken({
    agentId: 'main',
    sessionKey: SESSION,
    depth: 0,
    turnKey: TURN,
    turnIndex: 1,
    collabMode: 'advisor',
    configVersion: 'v1:advisor:gpt-6-astra',
  })
}

function forgeToken(token: string, mutate?: (claims: Record<string, unknown>) => void): string {
  const payloadB64 = token.slice(0, token.lastIndexOf('.'))
  const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >
  mutate?.(claims)
  return `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.invented-signature`
}

describe('advisor consult restart recovery', () => {
  it('direct-insert settled row without receipt is 401 after HMAC rotation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-adv-restart-'))
    const store = new AdvisorConsultStore(join(dir, 'advisor.db'))
    store.insertNew(settledRow())
    const token = mintToken()
    store.close()
    resetDelegateContextKeyForTests()
    assert.equal(inspectConsultTurnToken(token)?.hmacOk, false)
    const got = await replay({ dir, token })
    assert.equal(got.status, 401, JSON.stringify(got.body))
    assert.equal(got.recordState, 'settled')
  })

  it('current HMAC still presents a no-receipt old row; remint after receipt is 401', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-adv-hmac-live-'))
    const store = new AdvisorConsultStore(join(dir, 'advisor.db'))
    store.insertNew(settledRow())
    const token = mintToken()
    store.close()
    const live = await replay({ dir, token })
    assert.equal(live.status, 200, JSON.stringify(live.body))
    assert.equal(live.body.advice, 'ORIGINAL_ADVICE')

    const withReceipt = await mkdtemp(join(tmpdir(), 'oc-adv-receipt-live-'))
    const stored = new AdvisorConsultStore(join(withReceipt, 'advisor.db'))
    const original = mintToken()
    stored.insertNew(settledRow({ tokenReceipt: hashConsultTurnToken(original) }))
    stored.close()
    const reminted = mintToken()
    assert.equal(inspectConsultTurnToken(reminted)?.hmacOk, true)
    assert.notEqual(hashConsultTurnToken(reminted), hashConsultTurnToken(original))
    const remintGot = await replay({ dir: withReceipt, token: reminted })
    assert.equal(remintGot.status, 401, JSON.stringify(remintGot.body))
    const originalGot = await replay({ dir: withReceipt, token: original })
    assert.equal(originalGot.status, 200, JSON.stringify(originalGot.body))
    assert.equal(originalGot.body.advice, 'ORIGINAL_ADVICE')
  })

  it('rejects signature-only, exp-extend, missing receipt, wrong receipt, other user', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-adv-neg-'))
    const store = new AdvisorConsultStore(join(dir, 'advisor.db'))
    const token = mintToken()
    store.insertNew(settledRow())
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
    assert.equal(inspectConsultTurnToken(token)?.hmacOk, false)

    const missingReceipt = await replay({ dir, token })
    assert.equal(missingReceipt.status, 401)

    const sigOnly = await replay({ dir, token: forgeToken(token) })
    assert.equal(sigOnly.status, 401)

    const expExtended = await replay({
      dir,
      token: forgeToken(token, (claims) => {
        claims.exp = Date.now() + 3_600_000
      }),
    })
    assert.equal(expExtended.status, 401)

    const other = await replay({ dir, token, userId: '9' })
    assert.equal(other.status, 401)

    const unknown = await replay({ dir, token, invocation: 'cinv-not-registered' })
    assert.equal(unknown.status, 401)

    const sessionForged = await replay({
      dir,
      token: forgeToken(token, (claims) => {
        claims.sessionKey = 'agent:main:webchat:dm:forged'
      }),
    })
    assert.equal(sessionForged.status, 401)

    const expiredGot = await replay({ dir, token: expired })
    assert.equal(expiredGot.status, 401)

    const wrongDir = await mkdtemp(join(tmpdir(), 'oc-adv-wrong-receipt-'))
    const wrongStore = new AdvisorConsultStore(join(wrongDir, 'advisor.db'))
    wrongStore.insertNew(settledRow({ tokenReceipt: hashConsultTurnToken('not-the-original-token') }))
    wrongStore.close()
    const wrongReceipt = await replay({ dir: wrongDir, token })
    assert.equal(wrongReceipt.status, 401)

    const exactDir = await mkdtemp(join(tmpdir(), 'oc-adv-exact-receipt-'))
    const exactStore = new AdvisorConsultStore(join(exactDir, 'advisor.db'))
    exactStore.insertNew(settledRow({ tokenReceipt: hashConsultTurnToken(token) }))
    exactStore.close()
    const exactOk = await replay({ dir: exactDir, token })
    assert.equal(exactOk.status, 200, JSON.stringify(exactOk.body))
    assert.equal(exactOk.body.advice, 'ORIGINAL_ADVICE')
    const exactConflict = await replay({ dir: exactDir, token, question: 'a different question' })
    assert.equal(exactConflict.status, 409)
    const exactForged = await replay({
      dir: exactDir,
      token: forgeToken(token, (claims) => {
        claims.exp = Date.now() + 3_600_000
      }),
    })
    assert.equal(exactForged.status, 401)
  })

  it('two real processes: direct-insert without receipt is 401, no shared test key', async () => {
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
    assert.equal(replayed.status, 401, JSON.stringify(replayed))
    assert.equal(replayed.hmacOk, false)
    assert.equal(replayed.parentPresent, false)
  })

  it('child process exit with spawned empty advice is not consumer success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-adv-crash-child-'))
    const child = fileURLToPath(new URL('./advisorConsultRestartChild.ts', import.meta.url))
    const minted = spawnSync(process.execPath, ['--import', 'tsx', child, 'mint'], {
      env: {
        ...process.env,
        OC_ADVISOR_RESTART_HOME: dir,
        OC_SELFHOST_ENGINE_LOCAL_TURNS: '1',
        OC_ADVISOR_CRASH_WINDOW: '1',
      },
      encoding: 'utf8',
      timeout: 45_000,
    })
    if (minted.status !== 0) throw new Error(minted.stderr || minted.stdout)
    const store = new AdvisorConsultStore(join(dir, 'advisor.db'))
    const rec = store.findByInvocation({
      userId: '3',
      originTurnKey: TURN,
      invocationId: INVOCATION,
    })
    assert.equal(rec?.state, 'spawned')
    assert.equal(rec?.advice, null)
    store.markSettledFromBilling(REQUEST_ID)
    assert.equal(store.findById(rec!.consultId)?.state, 'spawned')
    store.close()
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

  it('first SQLITE_BUSY projection retries in-process without hand-calling projectConsults', async () => {
    setDelegateEngineBillingSettledHook(undefined)
    const dir = await mkdtemp(join(tmpdir(), 'oc-adv-busy-retry-'))
    const db = new AdvisorConsultStore(join(dir, 'consults.db'))
    const record = db.insertNew({ ...settledRow(), state: 'settle_pending' }).record
    const queuePath = join(dir, 'queue.json')
    await writeFile(
      queuePath,
      `${JSON.stringify({
        schemaVersion: 1,
        pending: [],
        settledReceipts: [{ requestId: REQUEST_ID, at: Date.now() }],
      })}\n`,
    )
    const orig = db.projectOneReceipt.bind(db)
    let calls = 0
    db.projectOneReceipt = ((id: string) => {
      calls += 1
      if (calls === 1) throw new Error('SQLITE_BUSY')
      return orig(id)
    }) as typeof db.projectOneReceipt
    const client = createDelegateEngineBillingClient({
      env: {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:9',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'tok',
      },
      queuePath,
      startupRecovery: false,
      fetcher: (async () => {
        throw new Error('network forbidden')
      }) as never,
    })
    const gw = Object.create(Gateway.prototype) as any
    gw._advisorConsults = db
    gw._delegateEngineBilling = client
    gw._consultBillingRetryMs = 20
    gw.log = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} }
    gw.advisorConsultStore()
    const deadline = Date.now() + 1_000
    let queue: { pending: unknown[]; settledReceipts: unknown[] } = {
      pending: [],
      settledReceipts: [{ requestId: REQUEST_ID }],
    }
    while (Date.now() < deadline) {
      if (db.findById(record.consultId)?.state === 'settled') {
        queue = JSON.parse(await readFile(queuePath, 'utf8')) as typeof queue
        if ((queue.settledReceipts ?? []).length === 0) break
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(db.findById(record.consultId)?.state, 'settled')
    assert.equal(db.findById(record.consultId)?.advice, 'ORIGINAL_ADVICE')
    assert.ok(calls >= 2, `projection calls=${calls}`)
    assert.equal(queue.pending.length, 0)
    assert.equal(queue.settledReceipts.length, 0)
    db.close()
  })

  it('spawned without advice after reopen is not consumer success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-adv-empty-settle-'))
    const dbPath = join(dir, 'advisor.db')
    const store = new AdvisorConsultStore(dbPath)
    store.insertNew(
      settledRow({
        state: 'spawned',
        advice: null,
        billingRequestId: REQUEST_ID,
      }),
    )
    store.markSettledFromBilling(REQUEST_ID)
    store.close()
    const reopened = new AdvisorConsultStore(dbPath)
    assert.equal(reopened.findByInvocation({
      userId: '3',
      originTurnKey: TURN,
      invocationId: INVOCATION,
    })?.state, 'spawned')
    const gw = Object.create(Gateway.prototype) as any
    gw._advisorConsults = reopened
    gw._advisorConsultWaitMs = 20
    gw._delegateJobs = { get: () => undefined, wait: async () => ({ status: 'expired' }) }
    gw._ensureDelegateJobStore = () => gw._delegateJobs
    const presented = await gw._presentExistingConsult({
      record: reopened.findByInvocation({
        userId: '3',
        originTurnKey: TURN,
        invocationId: INVOCATION,
      }),
      question: 'why red?',
      concern: '',
    })
    assert.notEqual(presented.body.status, 'settled')
    assert.ok(!presented.body.advice)
    reopened.close()
  })
})
