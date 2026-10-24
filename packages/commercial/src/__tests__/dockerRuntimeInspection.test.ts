import assert from 'node:assert/strict'
import { test } from 'node:test'
import type Docker from 'dockerode'
import type { Pool } from 'pg'
import { LocalDockerBackend, type ContainerService } from '../compute-pool/containerService.js'
import { readDockerRuntimeInspection, readWireRuntimeInspection } from '../compute-pool/dockerInspection.js'
import { getV3ContainerStatus, type V3SupervisorDeps } from '../agent-sandbox/v3supervisor.js'
const id = 'a'.repeat(64)
function raw() {
  return { Id: id, Image: `sha256:${'b'.repeat(64)}`, State: { Running: true, Status: 'running' },
    Config: { User: '1000:1000', Image: 'fixture:tag', Labels: { 'com.openclaude.v3.uid': '765', 'arbitrary-label': 'fixture-private' } },
    HostConfig: { Tmpfs: { '/run/oc/claude-config': 'rw,noexec,nosuid,size=64m' } },
    Mounts: [{ Type: 'volume', Name: 'oc-v5-data-u765', Driver: 'local', Source: '/var/lib/docker/volumes/fixture/_data', Destination: '/home/agent/.openclaude', RW: true, Mode: 'rw', Propagation: '' },
      { Type: 'bind', Source: '/fixture/state', Destination: '/run/oc/system-state', RW: false, Mode: 'ro', Propagation: 'rprivate' }],
  }
}
test('captures the actual complete snapshot, named volume and both explicit RW values without environment or arbitrary labels', () => {
  const value = raw()
  Object.defineProperty(value.Config, 'Env', { get() { throw new Error('must never read Env') } })
  const got = readDockerRuntimeInspection(value, id)!
  assert.equal(got.version, 1)
  assert.deepEqual(got.identityLabels, { 'com.openclaude.v3.uid': '765' })
  assert.equal(got.mounts[0]?.name, 'oc-v5-data-u765')
  assert.deepEqual(got.mounts.map(item => item.rw), [true, false])
  assert.equal(got.tmpfs['/run/oc/claude-config'], 'rw,noexec,nosuid,size=64m')
  value.Mounts[0]!.RW = false
  assert.equal(got.mounts[0]?.rw, true)
  assert.ok(Object.isFrozen(got) && Object.isFrozen(got.mounts) && Object.isFrozen(got.mounts[0]) && Object.isFrozen(got.tmpfs))
  assert.ok(!JSON.stringify(got).includes('fixture-private'))
  assert.deepEqual(readWireRuntimeInspection(got, id, id), got)
})
for (const path of ['Id', 'Image', 'Config', 'HostConfig', 'Mounts', 'Config.User', 'Config.Labels', 'HostConfig.Tmpfs', 'Mounts.0.RW', 'Mounts.0.Propagation']) {
  test(`missing ${path} is unknown, never an empty or read-only default`, () => {
    const value = raw() as unknown as Record<string, unknown>
    const parts = path.split('.'); const key = parts.pop()!
    let parent = value
    for (const part of parts) parent = parent[part] as Record<string, unknown>
    delete parent[key]
    assert.equal(readDockerRuntimeInspection(value, id), undefined)
  })
}
test('explicit empty Docker labels/tmpfs may be null, but null map values and malformed mounts invalidate the whole snapshot', () => {
  const value = raw()
  const empty = { ...value, Config: { ...value.Config, User: '', Labels: null }, HostConfig: { Tmpfs: null }, Mounts: [] }
  const got = readDockerRuntimeInspection(empty, id)!
  assert.equal(got.configuredUser, '')
  assert.deepEqual(got.mounts, []); assert.deepEqual(got.tmpfs, {}); assert.deepEqual(got.identityLabels, {})
  for (const patch of [{ Mounts: null }, { Mounts: [...value.Mounts, { ...value.Mounts[1], RW: 'false' }] },
    { HostConfig: { Tmpfs: { '/run/a': null } } }, { Config: { ...value.Config, Labels: { invalid: null } } }]) {
    assert.equal(readDockerRuntimeInspection({ ...value, ...patch }, id), undefined)
  }
})
test('canonical actual container/image identity is mandatory, including across the remote wire envelope', () => {
  const value = raw(); const got = readDockerRuntimeInspection(value, id)!
  assert.equal(readDockerRuntimeInspection(value, `${id}\n`), undefined)
  assert.equal(readDockerRuntimeInspection({ ...value, Image: `${value.Image}\n` }, id), undefined)
  assert.equal(readDockerRuntimeInspection({ ...value, Id: 'c'.repeat(64) }, id), undefined)
  assert.equal(readWireRuntimeInspection(got, 'c'.repeat(64), id), undefined)
  assert.equal(readWireRuntimeInspection({ ...got, id: 'c'.repeat(64) }, id, id), undefined)
  assert.equal(readWireRuntimeInspection({ ...got, version: 2 }, id, id), undefined)
  assert.equal(readWireRuntimeInspection(undefined, id, id), undefined)
})
test('real local backend and supervisor attach one inspected snapshot; old partial inspection still returns the original status', async () => {
  let value: unknown = raw(); let reads = 0
  const docker = { getContainer: (cid: string) => { assert.equal(cid, id); return { inspect: async () => { reads++; return value } } } } as unknown as Docker
  const backend = new LocalDockerBackend(docker)
  const info = await backend.inspect(id)
  assert.equal(info.runtimeInspection?.id, id); assert.equal(reads, 1)
  const row = { id: '5', user_id: '765', bound_ip: '172.31.1.2', port: 18791, container_internal_id: id, host_uuid: 'self', created_at: new Date(), last_ws_activity: null }
  const pool = { query: async () => ({ rows: [row], rowCount: 1 }) } as unknown as Pool
  const deps = { docker, pool, image: 'fixture:tag', selfHostId: 'self' } as V3SupervisorDeps
  const status = await getV3ContainerStatus(deps, 765)
  assert.equal(status?.runtimeInspection?.id, id); assert.equal(reads, 2)
  value = { Id: id, State: { Running: true } }
  const old = await backend.inspect(id)
  assert.equal(old.runtimeInspection, undefined); assert.equal(old.state, 'running')
  assert.equal((await getV3ContainerStatus(deps, 765))?.runtimeInspection, undefined)
})
test('remote supervisor validates new wire metadata while keeping old imageId/labels semantics and unknown compatibility', async () => {
  const snapshot = readDockerRuntimeInspection(raw(), id)!
  let info: unknown = { id, state: 'running', runtimeInspection: snapshot }
  const row = { id: '5', user_id: '765', bound_ip: '172.31.1.2', port: 18791, container_internal_id: id, host_uuid: 'remote', created_at: new Date(), last_ws_activity: null }
  const deps = { docker: {}, pool: { query: async () => ({ rows: [row], rowCount: 1 }) }, image: 'fixture:tag', selfHostId: 'self',
    containerService: { inspect: async () => info } as unknown as ContainerService } as unknown as V3SupervisorDeps
  const got = await getV3ContainerStatus(deps, 765)
  assert.deepEqual(got?.runtimeInspection, snapshot)
  assert.equal(got?.imageId, undefined); assert.equal(got?.labels, undefined)
  info = { id, state: 'running' }
  assert.equal((await getV3ContainerStatus(deps, 765))?.runtimeInspection, undefined)
  info = { id, state: 'running', runtimeInspection: { ...snapshot, id: 'c'.repeat(64) } }
  assert.equal((await getV3ContainerStatus(deps, 765))?.runtimeInspection, undefined)
})
