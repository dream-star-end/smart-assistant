import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, test } from 'node:test'
import type { PoolClient, QueryResult, QueryResultRow } from 'pg'

import { canonicalSha256Hex } from '../connectors/spec/canonical.js'
import { signPluginContractV2 } from '../connectors/spec/signer.js'
import { ConnectorSpecError } from '../connectors/spec/types.js'
import { compileRuntimePluginArtifact } from './contracts.js'
import {
  CURRENT_RUNTIME_PLUGIN_SECURITY_POLICY_VERSION,
  approveRuntimePluginVersion,
  approveRuntimePluginVersionWithRunner,
  loadVerifiedRuntimePluginContract,
} from './review.js'

const env = { OPENCLAUDE_KMS_KEY: randomBytes(32).toString('base64') }

function artifact() {
  return {
    schemaVersion: 1,
    pluginType: 'managed-browser',
    id: 'browser-reader',
    version: '1.0.0',
    driver: { id: 'browser-reader', version: '1.0.0' },
    account: { mode: 'required', contractVersion: 1 },
    accountState: { cookieDomains: ['example.com'], origins: ['https://example.com'] },
    network: { origins: ['https://example.com'], methods: ['GET'] },
    actions: [
      {
        id: 'read',
        description: 'Read',
        effect: 'read',
        timeoutSeconds: 10,
        params: { type: 'object', additionalProperties: false, properties: {} },
        result: { type: 'object', additionalProperties: false, properties: {} },
      },
    ],
  }
}

function result<Row extends QueryResultRow>(rows: Row[], rowCount = rows.length): QueryResult<Row> {
  return {
    command: 'SELECT',
    rowCount,
    oid: 0,
    fields: [],
    rows,
  }
}

describe('runtime Plugin review/load', () => {
  test('public approval wrapper requires a real functional verification assertion', async () => {
    await assert.rejects(
      approveRuntimePluginVersion({
        versionId: 41,
        reviewerUserId: 7,
        expectedArtifactHash: 'a'.repeat(64),
        functionalVerified: false,
      } as never),
      (error: unknown) => error instanceof ConnectorSpecError && error.code === 'INVALID_STATE',
    )
    await assert.rejects(
      approveRuntimePluginVersion({
        versionId: 41,
        reviewerUserId: 7,
        expectedArtifactHash: 'a'.repeat(64),
      } as never),
      (error: unknown) => error instanceof ConnectorSpecError && error.code === 'INVALID_STATE',
    )
  })

  test('sets the xid-bound writer gate before the atomic plugin-v2 trust update', async () => {
    const raw = artifact()
    const compiled = compileRuntimePluginArtifact(raw)
    const calls: string[] = []
    const client = {
      async query<Row extends QueryResultRow>(sql: string): Promise<QueryResult<Row>> {
        calls.push(sql)
        if (sql.includes('FROM marketplace_skill_versions') && sql.includes('FOR UPDATE')) {
          return result([
            {
              id: '41',
              slug: 'browser-reader',
              version: '1.0.0',
              name: 'Browser Reader',
              artifact_hash: compiled.artifactHash,
              status: 'pending',
              submitted_by: '9',
              raw_artifact: JSON.stringify(raw),
              security_review_state: 'draft',
              functional_verify_state: 'unverified',
              exec_revoked_at: null,
              exec_contract: null,
              exec_contract_hash: null,
              compiler_version: null,
              security_policy_version: null,
              signature: null,
              key_id: null,
              signature_scheme: null,
            } as unknown as Row,
          ])
        }
        if (sql.includes('FROM marketplace_skill_listings') && sql.includes('FOR UPDATE')) {
          return result([
            {
              slug: 'browser-reader',
              kind: 'connector',
              plugin_type: 'managed-browser',
              state: 'active',
              owner_user_id: '9',
              org_id: null,
              current_approved_version_id: null,
            } as unknown as Row,
          ])
        }
        if (sql.includes('SELECT role, status FROM users'))
          return result([{ role: 'admin', status: 'active' } as unknown as Row])
        if (sql.includes('UPDATE marketplace_skill_versions')) return result([], 1)
        if (sql.includes('UPDATE marketplace_skill_listings')) return result([], 1)
        return result([])
      },
    } as unknown as PoolClient

    await approveRuntimePluginVersionWithRunner(
      {
        versionId: '41',
        reviewerUserId: 7,
        expectedArtifactHash: compiled.artifactHash,
        functionalVerified: true,
        env,
      },
      client,
    )

    const gate = calls.findIndex((sql) => sql.includes('openclaude.plugin_signature_writer'))
    const trustWrite = calls.findIndex((sql) => sql.includes('UPDATE marketplace_skill_versions'))
    assert.ok(gate >= 0 && gate < trustWrite)
    assert.match(calls[trustWrite]!, /signature_scheme = 'plugin-v2'/)
    assert.match(calls[trustWrite]!, /functional_verify_state = 'verified'/)
  })

  test('loader recompiles raw bytes and verifies subtype-bound plugin-v2 signature', async () => {
    const raw = artifact()
    const compiled = compileRuntimePluginArtifact(raw)
    const signature = signPluginContractV2(
      {
        listingSlug: 'browser-reader',
        versionId: 41,
        kind: 'connector',
        pluginType: 'managed-browser',
        specHash: compiled.artifactHash,
        execContractHash: compiled.execContractHash,
        compilerVersion: 1,
        policyVersion: CURRENT_RUNTIME_PLUGIN_SECURITY_POLICY_VERSION,
      },
      { env },
    )
    const runner = {
      async query<Row extends QueryResultRow>(): Promise<QueryResult<Row>> {
        return result([
          {
            id: '41',
            slug: 'browser-reader',
            version: '1.0.0',
            kind: 'connector',
            plugin_type: 'managed-browser',
            listing_state: 'active',
            version_status: 'approved',
            artifact_hash: compiled.artifactHash,
            raw_artifact: JSON.stringify(raw),
            security_review_state: 'security_approved',
            functional_verify_state: 'verified',
            exec_revoked_at: null,
            exec_contract: compiled.execContract,
            exec_contract_hash: Buffer.from(compiled.execContractHash, 'hex'),
            compiler_version: 1,
            security_policy_version: CURRENT_RUNTIME_PLUGIN_SECURITY_POLICY_VERSION,
            signature: Buffer.from(signature.signature, 'hex'),
            key_id: signature.keyId,
            signature_scheme: 'plugin-v2',
          } as unknown as Row,
        ])
      },
    }
    const verified = await loadVerifiedRuntimePluginContract(41, runner, { env })
    assert.equal(verified.pluginType, 'managed-browser')
    assert.equal(verified.execContractHash, canonicalSha256Hex(compiled.execContract))

    const tampered = {
      ...runner,
      async query<Row extends QueryResultRow>(): Promise<QueryResult<Row>> {
        const base = await runner.query<Row>()
        ;(base.rows[0] as unknown as { plugin_type: string }).plugin_type = 'sandboxed-local'
        return base
      },
    }
    await assert.rejects(
      loadVerifiedRuntimePluginContract(41, tampered, { env }),
      (error: unknown) =>
        error instanceof ConnectorSpecError && error.code === 'WRONG_ARTIFACT_KIND',
    )
    await assert.rejects(
      loadVerifiedRuntimePluginContract(41, runner, { env, minPolicyVersion: Number.NaN }),
      (error: unknown) => error instanceof ConnectorSpecError && error.code === 'POLICY_STALE',
    )
    await assert.rejects(
      loadVerifiedRuntimePluginContract(Number.MAX_SAFE_INTEGER + 1, runner, { env }),
      (error: unknown) => error instanceof ConnectorSpecError && error.code === 'VERSION_NOT_FOUND',
    )
  })

  test('author cannot approve their own runtime Plugin', async () => {
    const raw = artifact()
    const compiled = compileRuntimePluginArtifact(raw)
    const client = {
      async query<Row extends QueryResultRow>(sql: string): Promise<QueryResult<Row>> {
        if (sql.includes('FROM marketplace_skill_versions'))
          return result([
            {
              id: '41',
              slug: 'browser-reader',
              version: '1.0.0',
              name: 'x',
              artifact_hash: compiled.artifactHash,
              status: 'pending',
              submitted_by: '7',
              raw_artifact: JSON.stringify(raw),
              security_review_state: 'draft',
              functional_verify_state: 'unverified',
              exec_revoked_at: null,
              exec_contract: null,
              exec_contract_hash: null,
              compiler_version: null,
              security_policy_version: null,
              signature: null,
              key_id: null,
              signature_scheme: null,
            } as unknown as Row,
          ])
        if (sql.includes('FROM marketplace_skill_listings'))
          return result([
            {
              slug: 'browser-reader',
              kind: 'connector',
              plugin_type: 'managed-browser',
              state: 'active',
              owner_user_id: '7',
              org_id: null,
              current_approved_version_id: null,
            } as unknown as Row,
          ])
        if (sql.includes('SELECT role, status FROM users'))
          return result([{ role: 'admin', status: 'active' } as unknown as Row])
        return result([])
      },
    } as unknown as PoolClient
    await assert.rejects(
      approveRuntimePluginVersionWithRunner(
        {
          versionId: 41,
          reviewerUserId: 7,
          expectedArtifactHash: compiled.artifactHash,
          functionalVerified: true,
          env,
        },
        client,
      ),
      (error: unknown) =>
        error instanceof ConnectorSpecError && error.code === 'REVIEWER_IS_AUTHOR',
    )
  })
})
