import assert from 'node:assert/strict'
import test from 'node:test'
import { validateBrowserStorageState } from '../accounts.js'
import { COMPILED_BILI_ACCOUNT_PLUGIN } from '../biliAccountContract.js'
import {
  type ManagedBrowserPluginContractV1,
  RUNTIME_PLUGIN_COMPILER_VERSION,
  compileRuntimePluginArtifact,
} from '../contracts.js'
import { COMPILED_KNOWLEDGE_PLANET_PLUGIN } from '../knowledgePlanetContract.js'
import { COMPILED_WEIBO_PLUGIN } from '../weiboContract.js'
import { COMPILED_ZHIHU_PLUGIN } from '../zhihuContract.js'
import { LITERATURE_PLUGIN_ARTIFACT } from './builtinArtifact.js'
import {
  COMPILED_LITERATURE_PLUGIN,
  LITERATURE_PLUGIN_CONTRACT,
  isLiteratureHttpContract,
  isLiteratureHttpIdentity,
} from './builtinContract.js'

test('only the immutable complete literature artifact gets the exact HTTP exception', () => {
  assert(isLiteratureHttpContract(LITERATURE_PLUGIN_CONTRACT))
  assert.deepEqual(LITERATURE_PLUGIN_CONTRACT.runtime.network.origins, [
    'http://www.jieyoutsg.com:80',
    'https://www.jieyoutsg.com:443',
  ])
  assert.deepEqual(LITERATURE_PLUGIN_CONTRACT.runtime.network.methods, ['GET', 'POST'])
  for (const change of [
    { id: 'other-literature' },
    { version: '0.1.1' },
    { driver: { id: 'builtin-jieyou-http', version: '0.1.1' } },
    { network: { origins: ['http://sub.jieyoutsg.com:80'], methods: ['GET'] } },
    { network: { origins: ['http://www.jieyoutsg.com:81'], methods: ['GET'] } },
    { actions: [] },
  ])
    assert.throws(() => compileRuntimePluginArtifact({ ...LITERATURE_PLUGIN_ARTIFACT, ...change }))
  const generic = structuredClone(LITERATURE_PLUGIN_ARTIFACT) as unknown as Record<string, unknown>
  generic.network = { origins: ['https://www.jieyoutsg.com:443'], methods: ['GET', 'POST'] }
  generic.accountState = {
    cookieDomains: ['www.jieyoutsg.com'],
    origins: ['https://www.jieyoutsg.com:443'],
  }
  const compiled = compileRuntimePluginArtifact(generic)
  assert.equal(compiled.pluginType, 'managed-browser')
  if (compiled.pluginType === 'managed-browser') {
    assert.equal(compiled.execContract.runtime.transport, undefined)
    assert.equal(isLiteratureHttpContract(compiled.execContract), false)
  }
})

test('self-reported artifact hash or wrapper fields cannot forge an HTTP contract pin', () => {
  const changed = structuredClone(LITERATURE_PLUGIN_CONTRACT)
  changed.runtime.network = { ...changed.runtime.network, origins: ['http://evil.test:80'] }
  assert.equal(isLiteratureHttpContract(changed), false)
  const identity = {
    slug: LITERATURE_PLUGIN_CONTRACT.id,
    artifactHash: COMPILED_LITERATURE_PLUGIN.artifactHash,
    execContractHash: COMPILED_LITERATURE_PLUGIN.execContractHash,
    contract: LITERATURE_PLUGIN_CONTRACT,
  }
  assert(isLiteratureHttpIdentity(identity))
  assert.equal(isLiteratureHttpIdentity({ ...identity, slug: 'other' }), false)
  assert.equal(isLiteratureHttpIdentity({ ...identity, execContractHash: 'a'.repeat(64) }), false)
  assert.equal(isLiteratureHttpIdentity({ ...identity, contract: changed }), false)
  assert.throws(() =>
    validateBrowserStorageState({ cookies: [], origins: [] }, LITERATURE_PLUGIN_CONTRACT),
  )
})

test('existing official artifact and execution hashes remain byte-for-byte unchanged', () => {
  assert.equal(RUNTIME_PLUGIN_COMPILER_VERSION, 1)
  const expected = [
    [
      '57e857ef31cb2315c4575bcd8fb7067296dc635898a368d48b8a3a30c5830c34',
      '67487c45c1d4b40f7ced01e0524f82a0fb1d159a03a9bbaa6eb59cf1c5ef48ab',
    ],
    [
      '794d299acb093c0cf3c5fd8f9b1f4b9cae8a85892938a98dc76cfd253ee08749',
      'e58a8ecf9a1f3fcfffa9e9ccafc98041902acbdd55516b9c7ca04dee3964a00e',
    ],
    [
      'a0a248f2941c6103d9dfbf5d4f1c0c8dd5c11e7376c43e33a5f434acb27f05f9',
      'dac72b57968efd0bad82ea388fdcbad07baf2cfdca7199e7ce586fa74b0fc628',
    ],
    [
      'f5b41bcbdeeb0709c4e77ee05f05e6b994aeb8e6d72d5661e06496cfc2a8a642',
      'e67a26206d419020abf21f4bd4a3dd8ae44eb1a249cd47a9e356a861a8d08364',
    ],
  ]
  const actual = [
    COMPILED_WEIBO_PLUGIN,
    COMPILED_ZHIHU_PLUGIN,
    COMPILED_BILI_ACCOUNT_PLUGIN,
    COMPILED_KNOWLEDGE_PLANET_PLUGIN,
  ]
  assert.deepEqual(
    actual.map((c) => [c.artifactHash, c.execContractHash]),
    expected,
  )
  for (const compiled of actual) {
    assert.equal(
      (compiled.execContract as ManagedBrowserPluginContractV1).runtime.transport,
      undefined,
    )
    assert.equal(
      (compiled.execContract as ManagedBrowserPluginContractV1).runtime.accountState.format,
      undefined,
    )
  }
})
