import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Design §10 E1–E18 coverage map. Automated names must appear in test
 * sources so a rename turns this file red.
 */
export const E_MATRIX = Object.freeze([
  { id: 'E1', kind: 'automated', files: ['e1-enroll-register.test.mjs'], tests: ['E1 enroll → finish → 18445 token path → WSS register_ok muxVersion=1'] },
  { id: 'E2', kind: 'automated', files: ['e2-full-gateway.test.mjs'], tests: ['E2 full Gateway class + Host + fake-ccb one turn (Linux CI)'] },
  { id: 'E3', kind: 'automated', files: ['tunnel-client.test.mjs'], tests: ['heartbeat timeout degrades then reconnects', 'kick after register_ok backs off instead of storming'] },
  { id: 'E4', kind: 'automated', files: ['tunnel-client.test.mjs'], tests: ['token refresh drop reconnects with new token after in-flight drain'] },
  { id: 'E5', kind: 'automated', files: ['e5-expired.test.mjs'], tests: ['expired token without refresh is unauthorized and does not keep the tunnel alive'] },
  { id: 'E6', kind: 'automated', files: ['e6-killswitch.test.mjs'], tests: ['E6 killswitch 503 does not tight-loop: backoff >= killSwitchBackoffMs and UI falls back once'] },
  { id: 'E7', kind: 'automated', files: ['e7-engine-not-enabled.test.mjs', '../../../packages/gateway/src/__tests__/engineEnabled.test.ts'], tests: ['E7 desktop gateway env pins OPENCLAUDE_ENGINES=ccb so cursor is client-side disabled', 'createEngine(cursor) under desktop env throws ENGINE_NOT_ENABLED'] },
  { id: 'E8', kind: 'automated', files: ['host-gateway-integration.test.mjs'], tests: ['S3c-4/5/6 real local-bridge gateway: healthz, needsAuth HTTP, WS, non-loopback'] },
  { id: 'E9', kind: 'citation', files: ['../../../packages/commercial/src/__tests__/desktopE2e.integ.test.ts'], tests: ['packages/commercial/src/__tests__/desktopE2e.integ.test.ts (P1)'] },
  { id: 'E10', kind: 'automated', files: ['e10-flag-off.test.mjs'], tests: ['E10 flag-off enroll 404 leaves cloud shell usable and stops local reconnect'] },
  { id: 'E11', kind: 'automated', files: ['power-events.test.mjs', 'tunnel-client.test.mjs'], tests: ['E11 injected event source drives suspend/resume/network_change hooks', 'suspend then resume forces a new connection'] },
  { id: 'E12', kind: 'automated', files: ['workspace-guard.test.mjs'], tests: ['win32 DES-02 proj-evil prefix is rejected'] },
  { id: 'E13', kind: 'automated', files: ['workspace-approval.test.mjs'], tests: ['requestApproval times out as deny when the injected timer fires'] },
  { id: 'E14', kind: 'automated', files: ['runtime-fetch.test.mjs'], tests: ['fetchArtifact deletes a corrupt download and reports 运行时损坏'] },
  { id: 'E15', kind: 'citation', files: ['../../../packages/commercial/src/__tests__/desktopE2e.integ.test.ts'], tests: ['packages/commercial/src/__tests__/desktopE2e.integ.test.ts (P1, same uid docker)'] },
  { id: 'E16', kind: 'automated', files: ['e16-revoke.test.mjs'], tests: ['E16 revoke deletes identity blob, stops Host/gateway, remint 401'] },
  { id: 'E17', kind: 'automated', files: ['host-gateway-integration.test.mjs'], tests: ['S3c-3 assertGatewayEnvSafe rejects TRUST_BRIDGE trio and oc-v3'] },
  { id: 'E18', kind: 'automated', files: ['host-local-proxy.test.mjs'], tests: ['18791/18792 reject missing token with 401 and do not outbound'] },
])

const here = path.dirname(fileURLToPath(import.meta.url))

test('E-matrix covers E1–E18 and automated names exist in source', () => {
  assert.equal(E_MATRIX.length, 18)
  const automated = E_MATRIX.filter((row) => row.kind === 'automated').length
  const citation = E_MATRIX.filter((row) => row.kind === 'citation').length
  assert.equal(automated, 16)
  assert.equal(citation, 2)

  for (let i = 0; i < 18; i += 1) {
    const row = E_MATRIX[i]
    assert.equal(row.id, `E${i + 1}`)
    assert.ok(row.tests.length >= 1)
    const bodies = (row.files || []).map((rel) => {
      const filePath = path.resolve(here, rel)
      assert.equal(fs.existsSync(filePath), true, `missing ${filePath}`)
      return fs.readFileSync(filePath, 'utf8')
    })
    const haystack = bodies.join('\n')
    if (row.kind === 'automated') {
      for (const name of row.tests) {
        assert.equal(haystack.includes(name), true, `${row.id} missing test name: ${name}`)
      }
    }
  }
})
