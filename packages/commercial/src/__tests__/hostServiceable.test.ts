/**
 * A3/B8 — assertHostServiceable / HostNotServiceableError 纯单元覆盖(无 DB)。
 *
 * service 路径(RPC / tunnel / file)对 host 的"可服务"断言:
 *   - self 豁免(本机走 local docker,不经 node-agent fingerprint pin)
 *   - status='revoked' = kill-switch 终态 → 拒
 *   - agent_cert_fingerprint_sha256 IS NULL = 未完成 provision / 已被 setRevoked 清
 *     → 拒(B8 fail-closed)
 *   - revoked 优先于 null-fp(reason='revoked',kill-switch 语义优先)
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { assertHostServiceable, HostNotServiceableError } from '../compute-pool/nodeAgentClient.js'
import type { ComputeHostRow } from '../compute-pool/types.js'

function row(over: Partial<ComputeHostRow>): ComputeHostRow {
  return {
    id: 'h1',
    name: 'node-1',
    status: 'ready',
    agent_cert_fingerprint_sha256: 'aa:bb:cc',
    ...over,
  } as unknown as ComputeHostRow
}

describe('assertHostServiceable (A3/B8)', () => {
  test('ready host with pinned fingerprint passes', () => {
    assert.doesNotThrow(() => assertHostServiceable(row({})))
  })

  test('revoked host throws HostNotServiceableError(reason=revoked)', () => {
    let caught: unknown
    try {
      assertHostServiceable(row({ status: 'revoked', agent_cert_fingerprint_sha256: null }))
    } catch (e) {
      caught = e
    }
    assert.ok(caught instanceof HostNotServiceableError)
    assert.equal(caught.reason, 'revoked')
    assert.equal(caught.code, 'HOST_NOT_SERVICEABLE')
  })

  test('null fingerprint (incomplete provision) throws (B8 fail-closed)', () => {
    let caught: unknown
    try {
      assertHostServiceable(row({ agent_cert_fingerprint_sha256: null }))
    } catch (e) {
      caught = e
    }
    assert.ok(caught instanceof HostNotServiceableError)
    assert.equal(caught.reason, 'no pinned fingerprint')
  })

  test('self host is exempt even if status/fp abnormal (local, no node-agent)', () => {
    assert.doesNotThrow(() =>
      assertHostServiceable(
        row({ name: 'self', status: 'revoked', agent_cert_fingerprint_sha256: null }),
      ),
    )
  })

  test('revoked takes precedence over null fingerprint', () => {
    try {
      assertHostServiceable(row({ status: 'revoked', agent_cert_fingerprint_sha256: null }))
      assert.fail('should have thrown')
    } catch (e) {
      assert.ok(e instanceof HostNotServiceableError)
      assert.equal(e.reason, 'revoked')
    }
  })
})
