import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
function run(command: string, name: string) {
  const r = spawnSync(command, [path.join(here, name)], {encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}})
  assert.equal(r.status, 0, r.stdout+r.stderr)
  return r.stdout+r.stderr
}
test('durable generic policy decisions and filesystem boundaries',()=>{
  assert.match(run('python3','v5ReleasePolicy.test.py'), /Ran 23 tests/)
})
test('real shared saga retains healthy candidate and preserves legacy safety guards',()=>{
  assert.match(run('bash','v5-release-policy-drill.sh'), /RESULT PASS=87 FAIL=0/)
})
test('real shared saga precise red and green faults',()=>{
  assert.match(run('bash','v5-release-policy-red-drill.sh'), /POLICY_RED_GREEN ablated=1 actual=0 faultHits=1:1/)
})
test('commercial data adapter and actual outer paths',()=>{
  assert.match(run('python3','v5CommercialReleasePolicy.test.py'), /Ran 14 tests/)
})
