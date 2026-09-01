import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const relay = readFileSync(resolve(root, 'packages/gateway/src/engine/cursorSandRelay.ts'), 'utf8')
const adapter = readFileSync(resolve(root, 'packages/gateway/src/engine/cursorSandAdapter.ts'), 'utf8')
const routing = readFileSync(resolve(root, 'packages/gateway/src/engine/cursorRoutingAdapter.ts'), 'utf8')
const registry = readFileSync(resolve(root, 'packages/gateway/src/engine/cursorAdapter.ts'), 'utf8')
const tests = readFileSync(resolve(root, 'packages/gateway/src/__tests__/cursorSandRelay.test.ts'), 'utf8')
const commercialDeploy = readFileSync(resolve(root, 'scripts/deploy-v5.sh'), 'utf8')
const selfhostRelease = readFileSync(resolve(root, 'scripts/v5-selfhost-master-release-lib.sh'), 'utf8')

assert.match(relay, /\/aiserver\.v1\.InferenceService\/Stream/)
assert.match(relay, /'x-cursor-client-type': 'sand'/)
assert.doesNotMatch(relay, /agent\.v1\.AgentService\/Run/)
assert.match(adapter, /await this\.prepareRelay\(\)/)
assert.match(adapter, /this\.emit\('external_billing'/)
assert.match(routing, /SAND_RESUME_PREFIX = 'sand-ccb:'/)
assert.match(routing, /await this\.ensureVariant\(\)/)
assert.match(registry, /new CursorRoutingAdapter\(opts\)/)
assert.match(tests, /tool recovery accepts XML and bounded compact control but rejects unknown tools/)
assert.match(tests, /downstream abort cancels the Cursor stream and relay close does not hang/)
assert.match(tests, /ordinary tool examples remain text and do not trigger a correction request/)
assert.match(tests, /interrupt before cold Sand preparation prevents submission/)
assert.match(commercialDeploy, /check-v5-cursor-sand-inference\.ts/)
assert.match(selfhostRelease, /check-v5-cursor-sand-inference\.ts/)

console.log('[cursor-sand-inference] PASS — endpoint, Sand identity, cold-submit/cancel, billing, variant, abort and both deploy-path guards present')
