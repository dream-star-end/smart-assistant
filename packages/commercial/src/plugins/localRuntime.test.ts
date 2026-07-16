import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { compileRuntimePluginArtifact } from './contracts.js'
import {
  LocalPluginRuntimeError,
  type RegisteredLocalPluginImageV1,
  VerifiedLocalPluginRuntime,
} from './localRuntime.js'

function verifiedLocal() {
  const compiled = compileRuntimePluginArtifact({
    schemaVersion: 1,
    pluginType: 'sandboxed-local',
    id: 'local-reader',
    version: '1.0.0',
    package: {
      manifest: {
        schemaVersion: 1,
        id: 'local-reader',
        version: '1.0.0',
        actions: [
          {
            id: 'read',
            description: 'Read',
            effect: 'read',
            entrypoint: 'scripts/read.mjs',
            timeoutSeconds: 10,
            params: { type: 'object', additionalProperties: false, properties: {} },
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
  })
  if (compiled.pluginType !== 'sandboxed-local') throw new Error('fixture subtype')
  return {
    slug: 'local-reader',
    versionId: 51,
    pluginType: 'sandboxed-local' as const,
    artifactHash: compiled.artifactHash,
    execContractHash: compiled.execContractHash,
    contract: compiled.execContract,
    compiled,
  }
}

describe('verified local Plugin runtime', () => {
  test('production default remains inert without an exact image/ABI registration', async () => {
    const runtime = new VerifiedLocalPluginRuntime({} as never, { artifactRoot: '/tmp/unused' })
    await assert.rejects(
      runtime.runReadAction({ verified: verifiedLocal(), userId: 7, actionId: 'read', params: {} }),
      (error: unknown) =>
        error instanceof LocalPluginRuntimeError && error.code === 'RUNTIME_UNAVAILABLE',
    )
  })

  test('constructs a single-artifact allowlist only after every runtime pin matches', async () => {
    const verified = verifiedLocal()
    const image: RegisteredLocalPluginImageV1 = {
      imageId: verified.contract.runtime.imageId,
      requiredLabels: verified.contract.runtime.requiredLabels,
      interpreterVersions: verified.contract.runtime.interpreterVersions,
    }
    let allowlist: ReadonlyMap<string, unknown> | null = null
    const runtime = new VerifiedLocalPluginRuntime({} as never, {
      artifactRoot: '/tmp/unused',
      images: new Map([[image.imageId, image]]),
      serviceFactory(packages) {
        allowlist = packages
        return {
          runReadAction: async () => ({
            result: {},
            stderr: '',
            digest: verified.contract.runtime.packageDigest,
          }),
        }
      },
    })
    const output = await runtime.runReadAction({
      verified,
      userId: 7,
      actionId: 'read',
      params: {},
    })
    assert.deepEqual([...allowlist!.keys()], ['local-reader'])
    assert.equal(output.digest, verified.contract.runtime.packageDigest)
  })

  test('rejects interpreter or label drift before constructing the sandbox', async () => {
    const verified = verifiedLocal()
    const image: RegisteredLocalPluginImageV1 = {
      imageId: verified.contract.runtime.imageId,
      requiredLabels: verified.contract.runtime.requiredLabels,
      interpreterVersions: { '/usr/bin/node': '22.18.0' },
    }
    const runtime = new VerifiedLocalPluginRuntime({} as never, {
      artifactRoot: '/tmp/unused',
      images: new Map([[image.imageId, image]]),
      serviceFactory: () => {
        throw new Error('must not construct')
      },
    })
    await assert.rejects(
      runtime.runReadAction({ verified, userId: 7, actionId: 'read', params: {} }),
      (error: unknown) =>
        error instanceof LocalPluginRuntimeError && error.code === 'RUNTIME_UNAVAILABLE',
    )
  })
})
