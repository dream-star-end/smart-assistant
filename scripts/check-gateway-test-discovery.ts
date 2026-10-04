/** Unit/mandatory-integ partition guard. Nothing removed from gateway testing. */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readWorkflowInclude, parseShardBudget } from '../.github/scripts/integ-shard-budget.js'

export function assertGatewayTestPartition(all: string[], tiers: Map<string, string[]>, activeShards: Set<string>): void {
  const unit = all.filter(p => !p.endsWith('.integ.test.ts'))
  const integ = all.filter(p => p.endsWith('.integ.test.ts'))
  assert.deepEqual([...unit, ...integ].sort(), [...all].sort(), 'discovery partition lost targets')
  assert.equal(new Set(all).size, all.length, 'duplicate discovery target')
  for (const target of integ) {
    const owners = [...tiers].filter(([, entries]) => entries.includes(target)).map(([name]) => name)
    assert.equal(owners.length, 1, `${target}: must have exactly one execution owner`)
    assert.match(owners[0], /^pr-/, `${target}: excluded from unit needs mandatory PR execution`)
    assert.ok(activeShards.has(owners[0]), `${target}: owning shard absent from actual CI matrix`)
  }
}

export function checkGatewayTestDiscovery(root: string): void {
  const all = readdirSync(join(root, 'packages/gateway/src'), { recursive: true, encoding: 'utf8' })
    .filter(p => p.endsWith('.test.ts') && !p.includes('node_modules/'))
    .map(p => `packages/gateway/src/${p}`).sort()
  const dir = join(root, '.github/integ-tiers')
  const tiers = new Map(readdirSync(dir).filter(n => n.endsWith('.txt')).map(n =>
    [n.replace(/\.txt$/, ''), parseShardBudget(readFileSync(join(dir, n), 'utf8'), {}).files]))
  const workflow = readFileSync(join(root, '.github/workflows/v5-ci.yml'), 'utf8')
  const execution = workflow.slice(workflow.indexOf('  commercial-integ:\n'), workflow.indexOf('  ci-classify:\n'))
  assert.ok(execution.includes('npm run test:commercial:integ:shard'), 'actual matrix must execute tier targets')
  assertGatewayTestPartition(all, tiers, new Set(readWorkflowInclude(execution).map(s => s.shard)))
  console.log(`gateway discovery: ${all.length} targets = ${all.filter(p => !p.endsWith('.integ.test.ts')).length} unit + ${all.filter(p => p.endsWith('.integ.test.ts')).length} mandatory integ`)
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  checkGatewayTestDiscovery(fileURLToPath(new URL('..', import.meta.url)))
}
