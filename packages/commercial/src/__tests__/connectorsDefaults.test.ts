/**
 * 默认连接器 seed spec 合法性:每个默认 connector 的 spec 必须能干净编译成 exec_contract
 * (effect/audience/identity/staticHeaders/pointer 全过编译器校验)。这是 seed 前的守门测试。
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, test } from 'node:test'

process.env.OPENCLAUDE_KMS_KEY = randomBytes(32).toString('base64')

import { DEFAULT_CONNECTORS } from '../connectors/defaults/index.js'
import { compileSpec } from '../connectors/spec/compiler.js'

describe('默认连接器 seed spec', () => {
  test('每个默认 connector 都能干净编译', () => {
    assert.ok(DEFAULT_CONNECTORS.length > 0, 'at least one default')
    for (const d of DEFAULT_CONNECTORS) {
      const { execContract, specHash, execContractHash } = compileSpec(d.spec, d.decision)
      assert.match(specHash, /^[0-9a-f]{64}$/, `${d.spec.id} specHash`)
      assert.match(execContractHash, /^[0-9a-f]{64}$/, `${d.spec.id} execContractHash`)
      // identity probe(若声明)必须指向存在的 read action。
      if (execContract.identity) {
        const probe = execContract.actions.find((a) => a.id === execContract.identity?.probeActionId)
        assert.ok(probe, `${d.spec.id} probe action exists`)
        assert.equal(probe?.effect, 'read', `${d.spec.id} probe is read`)
      }
      // 至少一个 apiOrigin。
      assert.ok(
        execContract.credentialAudiencePolicy.apiOrigins.length > 0,
        `${d.spec.id} has apiOrigin`,
      )
    }
  })

  test('GitHub:static-token + list_repos 顶层数组 read', () => {
    const gh = DEFAULT_CONNECTORS.find((d) => d.spec.id === 'github')
    assert.ok(gh)
    const { execContract } = compileSpec(gh!.spec, gh!.decision)
    assert.equal(execContract.authMode, 'static-token')
    const list = execContract.actions.find((a) => a.id === 'list_repos')
    assert.equal(list?.effect, 'read')
    assert.equal((list?.result as { type?: string })?.type, 'array')
    assert.equal(execContract.actions.find((a) => a.id === 'whoami')?.effect, 'read')
  })

  test('Notion:query_database 被签为 read(safe-read-non-get)', () => {
    const notion = DEFAULT_CONNECTORS.find((d) => d.spec.id === 'notion')
    assert.ok(notion)
    const { execContract } = compileSpec(notion!.spec, notion!.decision)
    const q = execContract.actions.find((a) => a.id === 'query_database')
    assert.equal(q?.effect, 'read')
    // whoami / retrieve_page 也是 read。
    assert.equal(execContract.actions.find((a) => a.id === 'whoami')?.effect, 'read')
    assert.equal(execContract.actions.find((a) => a.id === 'retrieve_page')?.effect, 'read')
  })

  test('写对等:notion create_page=write / feishu send_message=send(走确认门+日上限)', () => {
    const notion = DEFAULT_CONNECTORS.find((d) => d.spec.id === 'notion')!
    const nc = compileSpec(notion.spec, notion.decision).execContract
    assert.equal(nc.actions.find((a) => a.id === 'create_page')?.effect, 'write')

    const feishu = DEFAULT_CONNECTORS.find((d) => d.spec.id === 'feishu')!
    const fc = compileSpec(feishu.spec, feishu.decision).execContract
    assert.equal(fc.actions.find((a) => a.id === 'send_message')?.effect, 'send')
  })
})
