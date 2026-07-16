import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  REQUIRED_BROWSER_FORBIDDEN_CHANNELS,
  RUNTIME_PLUGIN_ARTIFACT_MAX_BYTES,
  RuntimePluginContractError,
  compileRuntimePluginArtifact,
  validateRuntimePluginJson,
} from './contracts.js'

const objectSchema = {
  type: 'object',
  properties: { query: { type: 'string', maxLength: 64 } },
  required: ['query'],
  additionalProperties: false,
}

function managedArtifact() {
  return {
    schemaVersion: 1,
    pluginType: 'managed-browser',
    id: 'knowledge-planet',
    version: '1.0.0',
    driver: { id: 'knowledge-planet', version: '1.0.0' },
    account: { mode: 'required', contractVersion: 1 },
    accountState: {
      cookieDomains: ['zsxq.com', 'wx.zsxq.com'],
      origins: ['https://wx.zsxq.com'],
    },
    network: {
      origins: ['https://wx.zsxq.com', 'https://api.zsxq.com:443'],
      methods: ['GET', 'POST'],
    },
    actions: [
      {
        id: 'search',
        description: 'Search posts',
        effect: 'read',
        timeoutSeconds: 30,
        params: objectSchema,
        result: { type: 'object', additionalProperties: false, properties: {} },
      },
    ],
  }
}

describe('runtime Plugin contracts', () => {
  test('compiles a managed-browser artifact into deterministic signed bytes', () => {
    const a = compileRuntimePluginArtifact(managedArtifact())
    const b = compileRuntimePluginArtifact({
      ...managedArtifact(),
      driver: { version: '1.0.0', id: 'knowledge-planet' },
    })

    assert.equal(a.pluginType, 'managed-browser')
    assert.equal(a.artifactHash, b.artifactHash)
    assert.equal(a.execContractHash, b.execContractHash)
    assert.deepEqual(a.execContract.runtime.network.origins, [
      'https://api.zsxq.com:443',
      'https://wx.zsxq.com:443',
    ])
    assert.deepEqual(
      a.execContract.runtime.network.forbiddenChannels,
      REQUIRED_BROWSER_FORBIDDEN_CHANNELS,
    )
    assert.deepEqual(a.execContract.runtime.accountState, {
      cookieDomains: ['wx.zsxq.com', 'zsxq.com'],
      origins: ['https://wx.zsxq.com:443'],
    })
  })

  test('rejects writable actions and browser network escape declarations', () => {
    const writable = managedArtifact()
    writable.actions[0]!.effect = 'write'
    assert.throws(
      () => compileRuntimePluginArtifact(writable),
      (error: unknown) =>
        error instanceof RuntimePluginContractError && error.code === 'INVALID_ARTIFACT',
    )

    assert.throws(
      () =>
        compileRuntimePluginArtifact({
          ...managedArtifact(),
          network: { origins: ['http://wx.zsxq.com'], methods: ['GET'] },
        }),
      /safe HTTPS origin/,
    )
    assert.throws(
      () =>
        compileRuntimePluginArtifact({
          ...managedArtifact(),
          network: { origins: ['https://127.0.0.1'], methods: ['GET'] },
        }),
      /safe HTTPS origin/,
    )
    assert.throws(
      () =>
        compileRuntimePluginArtifact({
          ...managedArtifact(),
          network: { origins: ['https://wx.zsxq.com'], methods: ['GET', 'DELETE'] },
        }),
      /network method/,
    )
    assert.throws(
      () =>
        compileRuntimePluginArtifact({
          ...managedArtifact(),
          accountState: { cookieDomains: ['127.0.0.1'], origins: ['https://wx.zsxq.com'] },
        }),
      /safe public hostname/,
    )
    assert.throws(
      () =>
        compileRuntimePluginArtifact({
          ...managedArtifact(),
          accountState: {
            cookieDomains: ['wx.zsxq.com:443'],
            origins: ['https://wx.zsxq.com'],
          },
        }),
      /canonical hostname|safe public hostname/,
    )
  })

  test('compiles local package digest, image/ABI/interpreter pins and broker policy', () => {
    const compiled = compileRuntimePluginArtifact({
      schemaVersion: 1,
      pluginType: 'sandboxed-local',
      id: 'local-reader',
      version: '1.2.3',
      package: {
        manifest: {
          schemaVersion: 1,
          id: 'local-reader',
          version: '1.2.3',
          actions: [
            {
              id: 'read',
              description: 'Read one value',
              effect: 'read',
              entrypoint: 'scripts/read.mjs',
              timeoutSeconds: 10,
              params: objectSchema,
              result: { type: 'object', additionalProperties: false, properties: {} },
            },
          ],
        },
        files: { 'scripts/read.mjs': 'process.stdout.write("{}")' },
      },
      image: {
        id: `sha256:${'a'.repeat(64)}`,
        sandboxAbi: 'local-read-v1',
        requiredLabels: { 'oc.plugin.node': '22.17.0' },
        interpreterVersions: { '/usr/bin/node': '22.17.0' },
      },
      brokerPolicy: {
        schemaVersion: 1,
        actions: {
          read: {
            httpRead: {
              origins: ['https://example.com'],
              maxRequests: 2,
              maxConcurrent: 1,
              maxResponseBytes: 4096,
              requestTimeoutMs: 2000,
            },
          },
        },
      },
    })

    assert.equal(compiled.pluginType, 'sandboxed-local')
    assert.match(compiled.execContract.runtime.packageDigest, /^[0-9a-f]{64}$/)
    assert.equal(compiled.execContract.runtime.imageId, `sha256:${'a'.repeat(64)}`)
    assert.equal(compiled.execContract.runtime.sandboxAbi, 'local-read-v1')
    assert.match(compiled.execContract.runtime.brokerPolicyHash ?? '', /^[0-9a-f]{64}$/)
  })

  test('safe JSON schema validator rejects unknown and prototype keys', () => {
    validateRuntimePluginJson(objectSchema, { query: 'hello' }, 'params')
    assert.throws(() =>
      validateRuntimePluginJson(objectSchema, { query: 'ok', extra: 1 }, 'params'),
    )
    const polluted = Object.create(null) as Record<string, unknown>
    polluted.query = 'ok'
    polluted.__proto__ = 'bad'
    assert.throws(() => validateRuntimePluginJson(objectSchema, polluted, 'params'))
    assert.throws(
      () =>
        validateRuntimePluginJson(
          {
            type: 'object',
            additionalProperties: false,
            properties: { value: { type: 'string' } },
          },
          { value: 'x'.repeat(1024 * 1024) },
          'result',
        ),
      (error: unknown) =>
        error instanceof RuntimePluginContractError && error.code === 'INVALID_RESULT',
    )
  })

  test('supports only bounded anchored ASCII patterns and enforces them at runtime', () => {
    const patternedParams = {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 6,
          maxLength: 32,
          pattern: '^[0-9]{6,32}$',
        },
      },
      required: ['query'],
      additionalProperties: false,
    }
    const compiled = compileRuntimePluginArtifact({
      ...managedArtifact(),
      actions: [{ ...managedArtifact().actions[0]!, params: patternedParams }],
    })
    const params = compiled.execContract.actions[0]!.params
    validateRuntimePluginJson(params, { query: '123456' }, 'params')
    assert.throws(
      () => validateRuntimePluginJson(params, { query: 'abcdef' }, 'params'),
      (error: unknown) =>
        error instanceof RuntimePluginContractError && error.code === 'INVALID_PARAMS',
    )

    assert.throws(
      () =>
        compileRuntimePluginArtifact({
          ...managedArtifact(),
          actions: [
            {
              ...managedArtifact().actions[0]!,
              params: {
                type: 'object',
                properties: { query: { type: 'string', pattern: '^(a+)+$' } },
                required: ['query'],
                additionalProperties: false,
              },
            },
          ],
        }),
      /not an allowed bounded ASCII pattern/,
    )
  })

  test('requires closed object schemas and bounded array item schemas', () => {
    assert.throws(
      () =>
        compileRuntimePluginArtifact({
          ...managedArtifact(),
          actions: [
            {
              ...managedArtifact().actions[0],
              params: { type: 'object', properties: {} },
            },
          ],
        }),
      /additionalProperties must be false/,
    )
    assert.throws(
      () =>
        compileRuntimePluginArtifact({
          ...managedArtifact(),
          actions: [
            {
              ...managedArtifact().actions[0],
              result: { type: 'array', maxItems: 10 },
            },
          ],
        }),
      /items is required/,
    )
  })

  test('rejects an oversized or combinatorially wide artifact before canonical hashing', () => {
    assert.throws(
      () =>
        compileRuntimePluginArtifact({
          ...managedArtifact(),
          unknown: 'x'.repeat(RUNTIME_PLUGIN_ARTIFACT_MAX_BYTES + 1),
        }),
      /JSON byte limit/,
    )
    assert.throws(
      () =>
        compileRuntimePluginArtifact({
          ...managedArtifact(),
          actions: Array.from({ length: 5000 }, () => managedArtifact().actions[0]),
        }),
      /array exceeds the item limit/,
    )
  })
})
