import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { describe, test } from 'node:test'
import type { QueryResult, QueryResultRow } from 'pg'

import {
  type PluginAccountEnvelopeV1,
  PluginAccountError,
  type PluginAccountRow,
  commitPluginAccountState,
  decryptPluginAccountEnvelope,
  markPluginAccountRelinkRequiredFenced,
  migrateManagedBrowserPluginAccountVersionFenced,
  validateBrowserStorageState,
} from './accounts.js'
import type { ManagedBrowserPluginContractV1 } from './contracts.js'

const env = { OPENCLAUDE_KMS_KEY: randomBytes(32).toString('base64') }
const contract: ManagedBrowserPluginContractV1 = {
  schemaVersion: 1,
  pluginType: 'managed-browser',
  artifactHash: 'a'.repeat(64),
  id: 'browser-reader',
  version: '1.0.0',
  account: { mode: 'required', contractVersion: 1 },
  actions: [],
  runtime: {
    driverId: 'browser-reader',
    driverVersion: '1.0.0',
    network: {
      origins: ['https://example.com:443'],
      methods: ['GET'],
      forbiddenChannels: [
        'background-network',
        'doh',
        'proxy',
        'quic',
        'websocket',
        'webrtc',
        'worker',
      ],
      redirects: 'revalidate-every-hop',
      ipv4PinsRequired: true,
    },
    accountState: {
      cookieDomains: ['example.com'],
      origins: ['https://example.com:443'],
    },
  },
}

function state(secret = 'secret-cookie') {
  return {
    cookies: [
      {
        name: 'session',
        value: secret,
        domain: '.example.com',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    origins: [{ origin: 'https://example.com', localStorage: [{ name: 'k', value: 'v' }] }],
  }
}

function queryResult<Row extends QueryResultRow>(
  rows: Row[],
  rowCount = rows.length,
): QueryResult<Row> {
  return { command: 'UPDATE', rowCount, oid: 0, fields: [], rows }
}

describe('managed-browser Plugin accounts', () => {
  test('canonical state accepts only exact signed HTTPS domains', () => {
    const parsed = validateBrowserStorageState(state(), contract)
    assert.equal(parsed.origins[0]!.origin, 'https://example.com:443')
    assert.equal(parsed.cookies[0]!.domain, '.example.com')
    assert.throws(
      () =>
        validateBrowserStorageState(
          { ...state(), origins: [{ origin: 'https://evil.example', localStorage: [] }] },
          contract,
        ),
      /outside the signed Plugin contract/,
    )
    assert.throws(
      () =>
        validateBrowserStorageState(
          { ...state(), cookies: [{ ...state().cookies[0], secure: false }] },
          contract,
        ),
      /must be secure/,
    )
  })

  test('account state domains are independent from the narrower action network', () => {
    const splitContract: ManagedBrowserPluginContractV1 = {
      ...contract,
      runtime: {
        ...contract.runtime,
        network: { ...contract.runtime.network, origins: ['https://api.example.com:443'] },
      },
    }
    assert.doesNotThrow(() => validateBrowserStorageState(state(), splitContract))
  })

  test('rejects unknown/prototype fields and bounded-state overflow', () => {
    assert.throws(() => validateBrowserStorageState(undefined, contract), /not serializable/)
    assert.throws(
      () => validateBrowserStorageState({ ...state(), extra: true }, contract),
      /unknown fields/,
    )
    const polluted = JSON.parse('{"cookies":[],"origins":[],"__proto__":{"x":1}}')
    assert.throws(() => validateBrowserStorageState(polluted, contract), /forbidden property/)
    assert.throws(
      () =>
        validateBrowserStorageState(
          {
            cookies: [],
            origins: [
              {
                origin: 'https://example.com',
                localStorage: [{ name: 'x', value: 'z'.repeat(300_000) }],
              },
            ],
          },
          contract,
        ),
      /byte limit/,
    )
    assert.throws(
      () =>
        validateBrowserStorageState(
          { ...state(), cookies: [state().cookies[0], state().cookies[0]] },
          contract,
        ),
      /cookies must be unique/,
    )
  })

  test('decrypt validation fails closed on cross-user AAD and state CAS pins every generation', async () => {
    const accountInstanceId = randomUUID()
    const envelope: PluginAccountEnvelopeV1 = {
      schemaVersion: 1,
      pluginType: 'managed-browser',
      driverId: 'browser-reader',
      driverVersion: '1.0.0',
      accountInstanceId,
      storageState: validateBrowserStorageState(state(), contract),
    }
    // Exercise encryption through the final CAS and capture the generated ciphertext.
    let params: readonly unknown[] = []
    let statement = ''
    const runner = {
      async query<Row extends QueryResultRow>(
        sql: string,
        p?: readonly unknown[],
      ): Promise<QueryResult<Row>> {
        statement = sql
        params = p ?? []
        return queryResult([{ secret_generation: '3' } as unknown as Row])
      },
    }
    const row: PluginAccountRow = {
      id: '41',
      user_id: 7,
      provider: 'browser-reader',
      display_name: '',
      account_key: 'a'.repeat(64),
      aad_seed: randomUUID(),
      secret_enc: Buffer.from('x'),
      secret_nonce: Buffer.alloc(12),
      revision: 1,
      secret_generation: '2',
      connector_version_id: '51',
      spec_hash: Buffer.from('a'.repeat(64), 'hex'),
      exec_contract_hash: Buffer.from('b'.repeat(64), 'hex'),
      auth_contract_version: 1,
      plugin_write_enabled: false,
      plugin_write_disclaimer_version: null,
      plugin_write_disclaimer_accepted_at: null,
      status: 'active',
      meta: {},
      revoked_at: null,
    }
    const verified = {
      slug: 'browser-reader',
      versionId: 51,
      pluginType: 'managed-browser' as const,
      artifactHash: 'a'.repeat(64),
      execContractHash: 'b'.repeat(64),
      contract,
      compiled: {
        pluginType: 'managed-browser' as const,
        artifactHash: 'a'.repeat(64),
        execContractHash: 'b'.repeat(64),
        execContract: contract,
      },
    }
    assert.equal(await commitPluginAccountState({ row, verified, envelope, runner, env }), '3')
    assert.match(statement, /EXISTS/)
    assert.match(statement, /current_approved_version_id = v\.id/)
    assert.equal(params[12], verified.artifactHash)
    const encryptedRow: PluginAccountRow = {
      ...row,
      aad_seed: String(params[10]),
      secret_enc: params[8] as Buffer,
      secret_nonce: params[9] as Buffer,
    }
    assert.equal(
      decryptPluginAccountEnvelope(encryptedRow, contract, env).accountInstanceId,
      accountInstanceId,
    )
    assert.throws(
      () => decryptPluginAccountEnvelope({ ...encryptedRow, user_id: 8 }, contract, env),
      (error: unknown) => error instanceof PluginAccountError && error.code === 'SECRET_INVALID',
    )

    const staleRunner = {
      async query<Row extends QueryResultRow>(): Promise<QueryResult<Row>> {
        return queryResult([], 0)
      },
    }
    await assert.rejects(
      commitPluginAccountState({ row, verified, envelope, runner: staleRunner, env }),
      (error: unknown) => error instanceof PluginAccountError && error.code === 'ACCOUNT_STALE',
    )

    await markPluginAccountRelinkRequiredFenced({ row, verified, runner })
    assert.match(statement, /status = 'error'/)
    assert.match(statement, /last_error_code = 'RELINK_REQUIRED'/)
    assert.match(statement, /secret_generation = \$6/)
    assert.match(statement, /exec_contract_hash = \$8/)
    assert.equal(params[5], row.secret_generation)
    assert.equal(params[8], verified.contract.account.contractVersion)
    await assert.rejects(
      markPluginAccountRelinkRequiredFenced({ row, verified, runner: staleRunner }),
      (error: unknown) => error instanceof PluginAccountError && error.code === 'ACCOUNT_STALE',
    )
  })

  test('version transition preserves account identity and storageState while rotating every fence', async () => {
    const accountInstanceId = randomUUID()
    const envelope: PluginAccountEnvelopeV1 = {
      schemaVersion: 1,
      pluginType: 'managed-browser',
      driverId: contract.runtime.driverId,
      driverVersion: contract.runtime.driverVersion,
      accountInstanceId,
      storageState: validateBrowserStorageState(state('migration-cookie'), contract),
    }
    const row: PluginAccountRow = {
      id: '71',
      user_id: 9,
      provider: 'browser-reader',
      display_name: 'Reader',
      account_key: 'a'.repeat(64),
      aad_seed: randomUUID(),
      secret_enc: Buffer.from('x'),
      secret_nonce: Buffer.alloc(12),
      revision: 4,
      secret_generation: '8',
      connector_version_id: '51',
      spec_hash: Buffer.from('a'.repeat(64), 'hex'),
      exec_contract_hash: Buffer.from('b'.repeat(64), 'hex'),
      auth_contract_version: 1,
      plugin_write_enabled: false,
      plugin_write_disclaimer_version: null,
      plugin_write_disclaimer_accepted_at: null,
      status: 'error',
      meta: { account_hint: 'kept' },
      revoked_at: null,
    }
    const from = {
      slug: row.provider,
      versionId: 51,
      pluginType: 'managed-browser' as const,
      artifactHash: 'a'.repeat(64),
      execContractHash: 'b'.repeat(64),
      contract,
      compiled: {
        pluginType: 'managed-browser' as const,
        artifactHash: 'a'.repeat(64),
        execContractHash: 'b'.repeat(64),
        execContract: contract,
      },
    }
    let encryptionParams: readonly unknown[] = []
    const committedGeneration = await commitPluginAccountState({
      row,
      verified: from,
      envelope,
      env,
      runner: {
        async query<Row extends QueryResultRow>(
          _sql: string,
          params?: readonly unknown[],
        ): Promise<QueryResult<Row>> {
          encryptionParams = params ?? []
          return queryResult([{ secret_generation: '9' } as unknown as Row])
        },
      },
    })
    const encryptedOld: PluginAccountRow = {
      ...row,
      aad_seed: String(encryptionParams[10]),
      secret_enc: encryptionParams[8] as Buffer,
      secret_nonce: encryptionParams[9] as Buffer,
      secret_generation: committedGeneration,
    }
    const nextContract: ManagedBrowserPluginContractV1 = {
      ...contract,
      artifactHash: 'c'.repeat(64),
      version: '2.0.0',
      runtime: { ...contract.runtime, driverId: 'browser-reader-next', driverVersion: '2.0.0' },
    }
    const to = {
      slug: row.provider,
      versionId: 52,
      pluginType: 'managed-browser' as const,
      artifactHash: 'c'.repeat(64),
      execContractHash: 'd'.repeat(64),
      contract: nextContract,
      compiled: {
        pluginType: 'managed-browser' as const,
        artifactHash: 'c'.repeat(64),
        execContractHash: 'd'.repeat(64),
        execContract: nextContract,
      },
    }
    let statement = ''
    const migrated = await migrateManagedBrowserPluginAccountVersionFenced({
      row: encryptedOld,
      from,
      to,
      env,
      runner: {
        async query<Row extends QueryResultRow>(
          sql: string,
          params?: readonly unknown[],
        ): Promise<QueryResult<Row>> {
          statement = sql
          const p = params ?? []
          return queryResult([
            {
              ...encryptedOld,
              connector_version_id: String(p[9]),
              spec_hash: p[10],
              exec_contract_hash: p[11],
              auth_contract_version: p[12],
              secret_enc: p[13],
              secret_nonce: p[14],
              aad_seed: String(p[15]),
              revision: encryptedOld.revision + 1,
              secret_generation: '10',
            } as unknown as Row,
          ])
        },
      },
    })
    assert.match(statement, /revision = revision \+ 1/)
    assert.match(statement, /secret_generation = secret_generation \+ 1/)
    assert.equal(migrated.status, 'error')
    assert.equal(migrated.revision, 5)
    assert.equal(migrated.secret_generation, '10')
    assert.equal(migrated.connector_version_id, '52')
    const opened = decryptPluginAccountEnvelope(migrated, nextContract, env)
    assert.equal(opened.accountInstanceId, accountInstanceId)
    assert.deepEqual(opened.storageState, envelope.storageState)
    assert.throws(
      () => decryptPluginAccountEnvelope(migrated, contract, env),
      (error: unknown) => error instanceof PluginAccountError && error.code === 'SECRET_INVALID',
    )
  })
})
