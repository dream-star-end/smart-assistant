import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const unitDir = join(root, 'deploy/v5-selfhost')
const read = (name: string) => readFileSync(join(unitDir, name), 'utf8')

/** `Key=a b` lines of one section, later lines appended as systemd does. */
function values(unit: string, section: string, key: string): string[] {
  const out: string[] = []
  let current = ''
  for (const raw of unit.split('\n')) {
    const line = raw.trim()
    const header = /^\[(.+)\]$/.exec(line)
    if (header) { current = header[1]!; continue }
    if (current !== section || !line.startsWith(`${key}=`)) continue
    out.push(...line.slice(key.length + 1).split(/\s+/).filter(Boolean))
  }
  return out
}

describe('v5 selfhost egress socket boot order', () => {
  const socket = read('openclaude-v5-selfhost-egress@.socket')

  // 2026-10-04 reboot: a socket with default dependencies is ordered before
  // sockets.target. Its After= names services that are ordered after
  // basic.target, which waits for sockets.target. systemd broke the cycle by
  // dropping containerd's start job and docker never came up.
  it('does not sit between sockets.target and the services it waits for', () => {
    const after = values(socket, 'Unit', 'After').filter((unit) => unit.endsWith('.service'))
    assert.ok(after.includes('openclaude-v5-selfhost-hostnet.service'))
    assert.ok(after.includes('openclaude-v5-selfhost-boot-guard.service'))
    for (const name of after) {
      const service = read(name)
      // Each of them keeps its default dependencies, hence After=basic.target.
      assert.notDeepEqual(values(service, 'Unit', 'DefaultDependencies'), ['no'], name)
    }
    assert.deepEqual(values(socket, 'Unit', 'DefaultDependencies'), ['no'])
    assert.ok(!values(socket, 'Unit', 'Before').includes('sockets.target'))
  })

  it('still stops at shutdown without the default dependencies', () => {
    assert.ok(values(socket, 'Unit', 'Conflicts').includes('shutdown.target'))
    assert.ok(values(socket, 'Unit', 'Before').includes('shutdown.target'))
  })

  it('still binds only after the docker bridge address exists', () => {
    assert.deepEqual(values(socket, 'Socket', 'ListenStream'), ['172.31.0.1:18892'])
    assert.ok(values(socket, 'Unit', 'Wants').includes('openclaude-v5-selfhost-hostnet.service'))
    assert.deepEqual(values(read('openclaude-v5-selfhost-hostnet.service'), 'Unit', 'Requires'),
      ['docker.service'])
  })
})
