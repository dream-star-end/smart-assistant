/**
 * codexLazyMigrate.test.ts — v1.0.120 feat/codex-disable-rebind 单测。
 *
 * 覆盖:
 *   1. acquireAndPickInTx —— 8 个 outcome:
 *      vanished / state_inactive / user_mismatch / no_bound_account /
 *      target_changed / already_active / pool_empty / rebound
 *   2. fetchSnapshotAndWriteContainerAuth —— host 路由(本地 / 远端 / 缺
 *      writeRemote 抛错)+ snapshot 缺失抛错 + Buffer 清零。
 *
 * Mock 策略:用一个支持"按顺序消费"的 query stub 喂 PoolClient,绕开真 PG。
 */

import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { PoolClient } from 'pg'

import {
  type WriteAuthDeps,
  acquireAndPickInTx,
  commitCodexRebindInTx,
  fetchSnapshotAndWriteContainerAuth,
} from '../account-pool/codexLazyMigrate.js'
import { pickCodexAccountForBindingInTx } from '../account-pool/scheduler.js'

const SELF_HOST = '11111111-1111-1111-1111-111111111111'
const REMOTE_HOST = '22222222-2222-2222-2222-222222222222'
const CONTAINER_ID = 7
const USER_ID = 42n

interface ScriptedResponse {
  rows: Array<Record<string, unknown>>
  rowCount?: number
}

function makeClient(scripts: ScriptedResponse[]): PoolClient {
  let idx = 0
  const query = async (..._args: unknown[]): Promise<ScriptedResponse> => {
    const s = scripts[idx]
    if (!s) {
      throw new Error(`fake client: unexpected query #${idx + 1}`)
    }
    idx += 1
    return s
  }
  return { query } as unknown as PoolClient
}

// ─── acquireAndPickInTx ─────────────────────────────────────────────────────

describe('acquireAndPickInTx', () => {
  test('vanished — container row not found', async () => {
    const client = makeClient([{ rows: [] }])
    const out = await acquireAndPickInTx(client, CONTAINER_ID, USER_ID)
    assert.deepEqual(out, { kind: 'vanished' })
  })

  test('state_inactive — ac.state != active', async () => {
    const client = makeClient([
      {
        rows: [
          {
            account_id: '100',
            account_status: 'active',
            state: 'error',
            user_id: '42',
            host_uuid: SELF_HOST,
          },
        ],
      },
    ])
    const out = await acquireAndPickInTx(client, CONTAINER_ID, USER_ID)
    assert.deepEqual(out, { kind: 'state_inactive' })
  })

  test('user_mismatch — row.user_id != expectedUserId', async () => {
    const client = makeClient([
      {
        rows: [
          {
            account_id: '100',
            account_status: 'active',
            state: 'active',
            user_id: '99',
            host_uuid: SELF_HOST,
          },
        ],
      },
    ])
    const out = await acquireAndPickInTx(client, CONTAINER_ID, USER_ID)
    assert.deepEqual(out, { kind: 'user_mismatch' })
  })

  test('user_mismatch skipped when expectedUserId is null (M2 fanout)', async () => {
    const client = makeClient([
      {
        rows: [
          {
            account_id: '100',
            account_status: 'active',
            state: 'active',
            user_id: '99',
            host_uuid: SELF_HOST,
          },
        ],
      },
    ])
    const out = await acquireAndPickInTx(client, CONTAINER_ID, null)
    assert.equal(out.kind, 'already_active')
  })

  test('no_bound_account — codex_account_id IS NULL', async () => {
    const client = makeClient([
      {
        rows: [
          {
            account_id: null,
            account_status: null,
            state: 'active',
            user_id: '42',
            host_uuid: SELF_HOST,
          },
        ],
      },
    ])
    const out = await acquireAndPickInTx(client, CONTAINER_ID, USER_ID)
    assert.deepEqual(out, { kind: 'no_bound_account' })
  })

  test('target_changed — fanout sees row already migrated', async () => {
    const client = makeClient([
      {
        rows: [
          {
            account_id: '999', // NOT the expected old account
            account_status: 'active',
            state: 'active',
            user_id: '42',
            host_uuid: SELF_HOST,
          },
        ],
      },
    ])
    const out = await acquireAndPickInTx(client, CONTAINER_ID, null, /* old */ 100n)
    assert.deepEqual(out, { kind: 'target_changed' })
  })

  test('already_active — current account is still active', async () => {
    const client = makeClient([
      {
        rows: [
          {
            account_id: '100',
            account_status: 'active',
            state: 'active',
            user_id: '42',
            host_uuid: SELF_HOST,
          },
        ],
      },
    ])
    const out = await acquireAndPickInTx(client, CONTAINER_ID, USER_ID)
    assert.equal(out.kind, 'already_active')
    if (out.kind === 'already_active') {
      assert.equal(out.currentAccountId, 100n)
      assert.equal(out.hostUuidUnderLock, SELF_HOST)
    }
  })

  test('pool_empty — current disabled, no active codex account', async () => {
    const client = makeClient([
      {
        // SELECT row: bound to disabled account
        rows: [
          {
            account_id: '100',
            account_status: 'disabled',
            state: 'active',
            user_id: '42',
            host_uuid: SELF_HOST,
          },
        ],
      },
      // pickCodexAccountForBindingInTx: claude_accounts is empty
      { rows: [] },
    ])
    const out = await acquireAndPickInTx(client, CONTAINER_ID, USER_ID)
    assert.deepEqual(out, { kind: 'pool_empty' })
  })

  test('rebound — current disabled, picker returns a fresh active account', async () => {
    const client = makeClient([
      {
        rows: [
          {
            account_id: '100',
            account_status: 'disabled',
            state: 'active',
            user_id: '42',
            host_uuid: SELF_HOST,
          },
        ],
      },
      // pickCodexAccountForBindingInTx SELECT — one candidate.
      {
        rows: [
          { id: '200', plan: 'pro', health_score: 50 },
        ],
      },
    ])
    const out = await acquireAndPickInTx(client, CONTAINER_ID, USER_ID)
    assert.equal(out.kind, 'rebound')
    if (out.kind === 'rebound') {
      assert.equal(out.newAccountId, 200n)
      assert.equal(out.plan, 'pro')
      assert.equal(out.hostUuidUnderLock, SELF_HOST)
    }
  })
})

// ─── commitCodexRebindInTx ──────────────────────────────────────────────────

describe('commitCodexRebindInTx', () => {
  test('issues UPDATE agent_containers SET codex_account_id', async () => {
    let observed: { sql?: string; params?: unknown[] } = {}
    const client = {
      query: async (sql: string, params: unknown[]) => {
        observed = { sql, params }
        return { rows: [], rowCount: 1 }
      },
    } as unknown as PoolClient
    await commitCodexRebindInTx(client, CONTAINER_ID, 200n)
    assert.match(observed.sql ?? '', /UPDATE\s+agent_containers/i)
    assert.match(observed.sql ?? '', /codex_account_id\s*=\s*\$1/i)
    // P1d/0098 channel 纪律:rebind UPDATE 必须带 runtime_channel(默认测试环境 'v3')。
    assert.match(observed.sql ?? '', /runtime_channel = \$3/)
    assert.deepEqual(observed.params, ['200', CONTAINER_ID, 'v3'])
  })
})

// ─── fetchSnapshotAndWriteContainerAuth ─────────────────────────────────────

describe('fetchSnapshotAndWriteContainerAuth', () => {
  const TOKEN = 'eyFRESHfake.payload.sig'

  function snapshotBuf() {
    return Buffer.from(TOKEN, 'utf8')
  }

  function makeDeps(over: Partial<WriteAuthDeps> = {}): WriteAuthDeps {
    return {
      selfHostId: SELF_HOST,
      containerUid: 1000,
      containerGid: 1000,
      codexContainerDir: '/tmp/codex-test',
      snapshotFn: async () => ({
        id: 200n,
        token: snapshotBuf(),
        refresh: Buffer.from('r'),
        expires_at: new Date(Date.now() + 3600_000),
      }),
      writeLocalFn: async () => undefined,
      ...over,
    }
  }

  test('selfHostId null → local write (single-host monolith)', async () => {
    let localCalled = 0
    const deps = makeDeps({
      selfHostId: null,
      writeLocalFn: async () => {
        localCalled += 1
      },
      putRemoteCodexAuth: async () => {
        throw new Error('must not be called')
      },
    })
    await fetchSnapshotAndWriteContainerAuth({
      accountId: 200n,
      containerId: CONTAINER_ID,
      hostUuidUnderLock: REMOTE_HOST, // even remote -> still local because self=null
      deps,
    })
    assert.equal(localCalled, 1)
  })

  test('hostUuidUnderLock == selfHostId → local write', async () => {
    let localCalled = 0
    const deps = makeDeps({
      writeLocalFn: async () => {
        localCalled += 1
      },
    })
    await fetchSnapshotAndWriteContainerAuth({
      accountId: 200n,
      containerId: CONTAINER_ID,
      hostUuidUnderLock: SELF_HOST,
      deps,
    })
    assert.equal(localCalled, 1)
  })

  test('hostUuidUnderLock null → local write (legacy row)', async () => {
    let localCalled = 0
    const deps = makeDeps({
      writeLocalFn: async () => {
        localCalled += 1
      },
    })
    await fetchSnapshotAndWriteContainerAuth({
      accountId: 200n,
      containerId: CONTAINER_ID,
      hostUuidUnderLock: null,
      deps,
    })
    assert.equal(localCalled, 1)
  })

  test('hostUuidUnderLock != selfHostId → remote write', async () => {
    let remoteCalled = 0
    const deps = makeDeps({
      writeLocalFn: async () => {
        throw new Error('must not be called')
      },
      putRemoteCodexAuth: async (hostUuid, cid, _token, _iso) => {
        assert.equal(hostUuid, REMOTE_HOST)
        assert.equal(cid, String(CONTAINER_ID))
        remoteCalled += 1
      },
    })
    await fetchSnapshotAndWriteContainerAuth({
      accountId: 200n,
      containerId: CONTAINER_ID,
      hostUuidUnderLock: REMOTE_HOST,
      deps,
    })
    assert.equal(remoteCalled, 1)
  })

  test('remote needed but putRemoteCodexAuth not wired → throws', async () => {
    const deps = makeDeps({
      writeLocalFn: async () => {
        throw new Error('not local')
      },
      putRemoteCodexAuth: undefined,
    })
    await assert.rejects(
      fetchSnapshotAndWriteContainerAuth({
        accountId: 200n,
        containerId: CONTAINER_ID,
        hostUuidUnderLock: REMOTE_HOST,
        deps,
      }),
      /remote host .* putRemoteCodexAuth not wired/,
    )
  })

  test('snapshot missing → throws (and never writes)', async () => {
    let localCalled = 0
    const deps = makeDeps({
      snapshotFn: async () => null,
      writeLocalFn: async () => {
        localCalled += 1
      },
    })
    await assert.rejects(
      fetchSnapshotAndWriteContainerAuth({
        accountId: 200n,
        containerId: CONTAINER_ID,
        hostUuidUnderLock: SELF_HOST,
        deps,
      }),
      /snapshot missing/,
    )
    assert.equal(localCalled, 0)
  })

  test('token Buffer is zeroed in finally', async () => {
    const buf = snapshotBuf()
    const before = Buffer.from(buf) // copy of original bytes
    const deps = makeDeps({
      snapshotFn: async () => ({
        id: 200n,
        token: buf,
        refresh: Buffer.from('refresh-bytes'),
        expires_at: new Date(),
      }),
    })
    await fetchSnapshotAndWriteContainerAuth({
      accountId: 200n,
      containerId: CONTAINER_ID,
      hostUuidUnderLock: SELF_HOST,
      deps,
    })
    // 全 0 后 SHA 不变,直接断 bytes。
    assert.equal(buf.every((b) => b === 0), true, 'token buffer must be zeroed')
    assert.notEqual(before.compare(buf), 0, 'original bytes must have changed')
  })

  test('client passed → uses snapshotInTxFn (in-tx variant)', async () => {
    let inTxCalled = 0
    let outOfTxCalled = 0
    const deps = makeDeps({
      snapshotFn: async () => {
        outOfTxCalled += 1
        return null
      },
      snapshotInTxFn: async () => {
        inTxCalled += 1
        return {
          id: 200n,
          token: snapshotBuf(),
          refresh: Buffer.from('r'),
          expires_at: new Date(),
        }
      },
    })
    const fakeClient = { query: async () => ({ rows: [] }) } as unknown as PoolClient
    await fetchSnapshotAndWriteContainerAuth({
      accountId: 200n,
      containerId: CONTAINER_ID,
      hostUuidUnderLock: SELF_HOST,
      deps,
      client: fakeClient,
    })
    assert.equal(inTxCalled, 1)
    assert.equal(outOfTxCalled, 0)
  })
})


// ─── pickCodexAccountForBindingInTx group filter ───────────────────────────

describe('pickCodexAccountForBindingInTx', () => {
  test('filters active codex candidates by groupId when provided', async () => {
    let observed: { sql?: string; params?: unknown[] } = {}
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        observed = { sql, params }
        return { rows: [{ id: '200', plan: 'pro', health_score: 50 }] }
      },
    } as unknown as PoolClient

    const out = await pickCodexAccountForBindingInTx(client, 'container-1', {
      groupId: '42',
      hash: () => 1n,
    })

    assert.equal(out?.account_id, 200n)
    // 0098 channel 划分:picker 恒带 runtime_channel 过滤($1),groupId 顺延为 $2。
    assert.match(observed.sql ?? '', /runtime_channel = \$1/)
    assert.match(observed.sql ?? '', /group_id = \$2/)
    assert.deepEqual(observed.params, ['v3', '42'])
  })
})
