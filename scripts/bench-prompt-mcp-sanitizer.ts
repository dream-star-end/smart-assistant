// Offline CPU benchmark only; no model requests or output of prompt content.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PLATFORM_MCP_TOOL_NAMES, createMcpClaimSanitizer } from '../packages/gateway/src/promptSlots.js'

function baseline(
  content: string,
  availableMcpTools: string[] | undefined,
): string {
  if (availableMcpTools === undefined) return content
  const available = new Set(availableMcpTools)
  let out = content
  for (const tool of PLATFORM_MCP_TOOL_NAMES) {
    if (available.has(tool)) continue
    const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`\\b${escaped}\\b(?:\\([^\\n\\r]*?\\))?`, 'g'), '（当前未注册）')
  }
  return out
}

const slots = Array.from({ length: 14 }, (_, i) =>
  (`section${i}: ${PLATFORM_MCP_TOOL_NAMES.map(n => `${n}(query)`).join(' 中文 ')}`).repeat(8))
const results = []
for (const [name, tools] of [['legacy', undefined], ['all', [...PLATFORM_MCP_TOOL_NAMES]], ['partial', ['skill_view', 'skill_search']]] as const) {
  const available = tools === undefined ? undefined : [...tools]
  const expected = slots.map(s => baseline(s, available))
  assert.deepEqual(slots.map(createMcpClaimSanitizer(available)), expected)
  for (const version of ['baseline', 'candidate']) {
    const durations: number[] = []
    for (let i = 0; i < 1500; i++) {
      const started = performance.now()
      const transform = version === 'candidate' ? createMcpClaimSanitizer(available) : (s: string) => baseline(s, available)
      slots.map(transform)
      durations.push(performance.now() - started)
    }
    durations.sort((a, b) => a - b)
    results.push({ name, version, iterations: durations.length, p50Ms: durations[750], p95Ms: durations[1425] })
  }
}
console.log(JSON.stringify({ slots: slots.length, inputBytes: slots.reduce((n, s) => n + Buffer.byteLength(s), 0),
  fixtureSha256: createHash('sha256').update(slots.join('\n')).digest('hex'), results }, null, 2))
