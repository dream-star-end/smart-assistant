/**
 * Remote lane runtime: real directories, ownership, Unix sockets and a real signed admission
 * through a lane's relay; only the SSH host is a fixture. Needs root (as the master runs).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import {
  type Cc5BridgeBinding,
  type RemoteLaneHooks,
  type RemoteLanePlacement,
  cc5ControlRequest,
  CodexSshHost,
  createRemoteLaneRuntime,
} from '@openclaude/gateway/cc5-container-runtime'
import type { RemoteFinanceFactory } from '@openclaude/gateway/remote-finance'
import {
  MODEL_AUTHORITY_VERSION,
  type ModelAuthorityPayload,
  type TurnLease,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  turnLeaseSigningInput,
} from '@openclaude/protocol'

const root = process.getuid?.() === 0
const MODEL = 'claude-opus-5-5-remote'
const DOCKER = 'a'.repeat(64)
const SESSION = 'agent:main:webchat:dm:fixture_chat1'
const financeFactory: RemoteFinanceFactory = () => ({ async admit() { return {
  async beforeHostStart() {}, async beforeDispatch() {}, async stop() {},
  async terminal() { return { state: 'proven', requestId: 'fixture-only-request' } },
} } })
const env = { OC_SELFHOST_CC5_T1555U_ENABLED: '1', OC_SELFHOST_CC5_T1555U_TEST_UID: '912' }

function fixture(options: { failStop?: boolean; failPrepare?: boolean; baseRoot?: string; holdPrepare?: Promise<void>; enforcePlacementState?: boolean; capacity?: number } = {}) {
  const dir = options.baseRoot ? undefined : mkdtempSync('/tmp/cl-')
  const baseRoot = options.baseRoot ?? join(dir!, 'r')
  const key = generateKeyPairSync('ed25519')
  const publicKeyring = `fixture-key:${(key.publicKey.export({ format: 'jwk' }) as { x: string }).x}`
  const events: string[] = []
  const states: Array<[string, string]> = []
  const hosts: Array<{ input: PassThrough; written: Buffer[]; operationId: string }> = []
  const places: Array<Record<string, unknown>> = []
  const placements = new Map<string, RemoteLanePlacement>()
  const persisted = new Map<string, string>()
  const hooks: RemoteLaneHooks = {
    async place(request) {
      if (options.enforcePlacementState && persisted.get(request.sessionKey) !== undefined && persisted.get(request.sessionKey) !== 'released') throw new Error('REMOTE_LANE_STOP_UNPROVEN')
      if (options.capacity !== undefined && [...persisted].filter(([key, state]) =>
        key !== request.sessionKey && state !== 'released').length >= options.capacity) throw new Error('REMOTE_LANE_CAPACITY_EXHAUSTED')
      places.push({ ...request })
      persisted.set(request.sessionKey, 'preparing')
      // Sticky like placeRemoteLane: one task root and operation per chat.
      let placement = placements.get(request.sessionKey)
      if (!placement) {
        const operationId = randomUUID()
        placement = {
          target: { host: 'node.example', port: 22, user: 'box', keyPath: '/unused', knownHostsPath: '/unused',
            controllerSha256: '0'.repeat(64), taskRootPrefix: '/home/box/oc-agentremote-',
            upstreamModel: request.canonicalModel.replace(/-remote$/, '') },
          taskRoot: `/home/box/oc-agentremote-c${operationId.replace(/-/g, '').slice(0, 23)}`,
          operationId, runId: randomUUID(), provisionPacket: Buffer.from('{"fixture":true}'),
        }
        placements.set(request.sessionKey, placement)
      }
      return { ...placement, target: { ...placement.target, upstreamModel: request.canonicalModel.replace(/-remote$/, '') } }
    },
    onState(operationId, state) { states.push([operationId, state]); for (const [key, value] of placements) if (value.operationId === operationId) persisted.set(key, state) },
  }
  const runtime = createRemoteLaneRuntime({
    selfhost: true, env, financeFactory, hooks,
    configuration: () => ({
      baseRoot, controllerPath: '/unused/controller',
      hostFactory: (config) => {
        const input = new PassThrough()
        const written: Buffer[] = []
        input.on('data', (b: Buffer) => written.push(b))
        hosts.push({ input, written, operationId: config.operationId })
        return {
          async prepareTask(packet: Buffer) {
            events.push(`prepare:${config.operationId}`)
            assert.equal(packet.toString(), '{"fixture":true}')
            await options.holdPrepare
            if (options.failPrepare) throw new Error('fixture node unreachable')
          },
          start() {
            events.push(`start:${config.operationId}`)
            return { stdin: input, stdout: new PassThrough(), ready: Promise.resolve() }
          },
          async stop(): Promise<{ remoteStopped: true }> {
            events.push(`stop:${config.operationId}`)
            if (options.failStop) throw new Error('fixture remote exit unknown')
            return { remoteStopped: true }
          },
        }
      },
    }),
  })!
  const container = async (containerDbId = '91') => {
    const handle = (await runtime.prepare({ uid: 912, containerDbId, local: true, publicKeyring }))!
    await runtime.bindCreated(handle, DOCKER)
    await runtime.activate(handle, DOCKER)
    return handle
  }
  const lane = (sessionKey = SESSION, canonicalModel = MODEL, containerDbId = '91') =>
    runtime.ensureLane({ uid: 912, containerDbId, sessionKey, canonicalModel })
  return { dir, baseRoot, runtime, key, publicKeyring, events, states, hosts, places, container, lane,
    async cleanup() {
      await runtime.release('91').catch(() => {})
      if (dir) rmSync(dir, { recursive: true, force: true })
    } }
}

function admission(key: ReturnType<typeof generateKeyPairSync>, b: Cc5BridgeBinding) {
  const containerId = Number(b.containerDbId)
  const now = Date.now()
  const a: ModelAuthorityPayload = {
    v: MODEL_AUTHORITY_VERSION, keyId: 'fixture-key', uid: 912, containerId,
    authorityTurnId: 'a'.repeat(32), billingRequestId: 'fixture-only-request',
    connectionChallenge: 'fixture-connection', canonicalModel: b.canonicalModel, engine: 'ccb',
    executionBackend: { kind: 'cc5-interactive-v1', sessionKey: b.sessionKey, operationId: b.operationId },
    securityEpoch: 1, executionRevision: 'fixture-r1', issuedAt: now, expiresAt: now + 60000,
    executionDescriptor: { capabilityProfile: {}, capabilitySchemaVersion: 1, contextWindow: 200000,
      supportedEfforts: [], supportsVision: false },
  }
  const lease: TurnLease = { v: a.v, keyId: a.keyId, uid: a.uid, containerId: a.containerId,
    authorityTurnId: a.authorityTurnId, connectionChallenge: a.connectionChallenge,
    canonicalModel: a.canonicalModel, securityEpoch: a.securityEpoch, issuedAt: now, expiresAt: now + 120000 }
  return { ...b, turnKey: 'fixture-billing-turn',
    authority: encodeAuthorityEnvelope(a, sign(null, authoritySigningInput(a), key.privateKey)),
    lease: encodeTurnLeaseEnvelope(lease, sign(null, turnLeaseSigningInput(lease), key.privateKey)) }
}

test('OFF, invalid UID and nonselfhost never read configuration or create a runtime', () => {
  for (const [selfhost, policy] of [
    [true, {}], [false, env], [true, { ...env, OC_SELFHOST_CC5_T1555U_TEST_UID: 'all' }],
    [true, { ...env, OC_SELFHOST_CC5_T1555U_ENABLED: 'true' }],
  ] as const) {
    assert.equal(createRemoteLaneRuntime({ selfhost, env: policy, financeFactory,
      hooks: { place: () => { throw new Error('never') } },
      configuration: () => { throw new Error('must never read configuration') } }), undefined)
  }
})

test('a container view holds only the public ring; no lane exists until a chat asks for one', { skip: !root }, async () => {
  const f = fixture()
  try {
    await assert.rejects(f.lane(), /REMOTE_LANE_UNAVAILABLE/, 'no container yet')
    const handle = (await f.runtime.prepare({ uid: 912, containerDbId: '91', local: true, publicKeyring: f.publicKeyring }))!
    assert.equal(await f.runtime.prepare({ uid: 913, containerDbId: '92', local: true, publicKeyring: f.publicKeyring }), null)
    await assert.rejects(f.lane(), /REMOTE_LANE_UNAVAILABLE/, 'prepared, not yet active')
    await f.runtime.bindCreated(handle, DOCKER)
    await f.runtime.activate(handle, DOCKER)
    assert.deepEqual(readdirSync(handle.mountSource), ['authority-public.json'])
    const st = lstatSync(join(handle.mountSource, 'authority-public.json'))
    assert.deepEqual([st.uid, st.gid, st.mode & 0o777], [0, 1000, 0o640])
    assert.deepEqual(f.places, [])
    assert.deepEqual(f.events, [])
  } finally {
    await f.cleanup()
  }
})

test('a chat lane is placed, its node root prepared, and a real signed admission through its relay reaches the host', { skip: !root }, async () => {
  const f = fixture()
  let req: ReturnType<typeof request> | undefined
  try {
    const handle = await f.container()
    const backend = await f.lane()
    assert.equal(backend.kind, 'cc5-interactive-v1')
    assert.equal(backend.sessionKey, SESSION)
    assert.deepEqual(f.places, [{ uid: 912, containerDbId: '91', sessionKey: SESSION, canonicalModel: MODEL, dockerId: DOCKER }])
    assert.deepEqual(f.events, [`prepare:${backend.operationId}`], 'the node root is reset/provisioned before any start')
    const view = join(handle.mountSource, backend.operationId)
    const b = JSON.parse(readFileSync(join(view, 'binding.json'), 'utf8')) as Cc5BridgeBinding
    assert.deepEqual([b.canonicalModel, b.sessionKey, b.operationId, b.containerDbId, b.dockerId, b.uid],
      [MODEL, SESSION, backend.operationId, '91', DOCKER, '912'])
    for (const [path, owner, mode] of [[join(view, 'binding.json'), 0, 0o640], [join(view, 'relay.sock'), 1000, 0o600]] as const) {
      const st = lstatSync(path)
      assert.deepEqual([st.uid, st.mode & 0o777], [owner, mode], path)
    }
    // The container user (uid 1000) can read its lane binding inside the mounted view
    // (entered as root first: only the view, not its private parents, is mounted in a container).
    const check = "const fs=require('node:fs');process.chdir(process.argv[1]);process.setgid(1000);process.setuid(1000);" +
      "process.stdout.write(JSON.parse(fs.readFileSync(process.argv[2]+'/binding.json')).operationId)"
    assert.equal(execFileSync(process.execPath, ['-e', check, handle.mountSource, backend.operationId],
      { encoding: 'utf8' }), backend.operationId)
    const socket = join(view, 'relay.sock')
    const scope = admission(f.key, b)
    await assert.rejects(cc5ControlRequest('/admit', { ...scope, uid: '913' }, socket))
    const admitted = await cc5ControlRequest('/admit', scope, socket)
    assert.equal(admitted.ready, true)
    assert.deepEqual(f.events, [`prepare:${backend.operationId}`, `start:${backend.operationId}`])
    req = request({ socketPath: socket, method: 'POST', path: '/session/open' })
    req.on('error', () => {})
    req.write(`${JSON.stringify({ ...b, type: 'open', sessionKey: SESSION })}\n`)
    const [res] = await once(req, 'response')
    res.on('error', () => {})
    res.resume()
    const bytes = Buffer.from(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello remote' } })}\n`)
    req.write(`${JSON.stringify({ seq: 1, bytes: bytes.toString('base64'), hash: createHash('sha256').update(bytes).digest('hex') })}\n`)
    const end = Date.now() + 1000
    while (f.hosts[0]!.written.length === 0) {
      assert.ok(Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.deepEqual(Buffer.concat(f.hosts[0]!.written), bytes)
    // The next turn of the chat reuses the resident lane: no placement, no node preparation.
    assert.deepEqual(await f.lane(), backend)
    assert.equal(f.places.length, 1)
    assert.equal(f.hosts.length, 1)
    assert.deepEqual(f.states, [[backend.operationId, 'running']])
  } finally {
    req?.destroy()
    await f.cleanup()
  }
})

test('chats get their own lanes; concurrent first turns of one chat share a single placement', { skip: !root }, async () => {
  const f = fixture()
  try {
    const handle = await f.container()
    const [a1, a2, other] = await Promise.all([f.lane(), f.lane(), f.lane('agent:main:webchat:dm:fixture_chat2')])
    assert.deepEqual(a1, a2)
    assert.notEqual(other.operationId, a1.operationId)
    assert.equal(f.places.length, 2)
    assert.deepEqual(readdirSync(handle.mountSource).sort(),
      ['authority-public.json', a1.operationId, other.operationId].sort())
  } finally {
    await f.cleanup()
  }
})

test('a full pool hands the longest-idle chat lane to a new chat; a chat mid-turn keeps its lane', { skip: !root }, async () => {
  const f = fixture({ capacity: 2 })
  try {
    const handle = await f.container()
    const chat2 = 'agent:main:webchat:dm:fixture_chat2', chat3 = 'agent:main:webchat:dm:fixture_chat3'
    const first = await f.lane()
    const second = await f.lane(chat2)
    // chat2 is mid-turn: its relay holds an admission.
    const b = JSON.parse(readFileSync(join(handle.mountSource, second.operationId, 'binding.json'), 'utf8')) as Cc5BridgeBinding
    await cc5ControlRequest('/admit', admission(f.key, b), join(handle.mountSource, second.operationId, 'relay.sock'))
    const third = await f.lane(chat3)
    assert.notEqual(third.operationId, first.operationId)
    assert.ok(f.states.some(([op, state]) => op === first.operationId && state === 'released'), 'the idle chat lane was released')
    assert.ok(!f.states.some(([op, state]) => op === second.operationId && state === 'released'), 'the busy chat keeps its lane')
    // The reclaimed chat comes back while the pool is still full: it reclaims the now-idle chat3
    // and continues its own operation.
    const back = await f.lane()
    assert.equal(back.operationId, first.operationId)
    assert.ok(f.states.some(([op, state]) => op === third.operationId && state === 'released'), 'the idle chat3 lane was released')
    // With every remaining lane busy or the requester's own, the pool stays full.
    await cc5ControlRequest('/admit', admission(f.key, JSON.parse(readFileSync(join(handle.mountSource, back.operationId, 'binding.json'), 'utf8'))),
      join(handle.mountSource, back.operationId, 'relay.sock'))
    await assert.rejects(f.lane(chat3), /REMOTE_LANE_UNAVAILABLE/)
  } finally {
    await f.cleanup()
  }
})

test('a stopped lane or a model switch gets a new lane only after the old remote exit', { skip: !root }, async () => {
  const f = fixture()
  try {
    const handle = await f.container()
    const first = await f.lane()
    const socket = join(handle.mountSource, first.operationId, 'relay.sock')
    const b = JSON.parse(readFileSync(join(handle.mountSource, first.operationId, 'binding.json'), 'utf8')) as Cc5BridgeBinding
    await cc5ControlRequest('/admit', admission(f.key, b), socket)
    await cc5ControlRequest('/stop', admission(f.key, b), socket) // e.g. the remote CLI died
    const again = await f.lane()
    assert.equal(again.operationId, first.operationId, 'same chat, same node root and resume ids')
    const op = first.operationId
    assert.deepEqual(f.events, [`prepare:${op}`, `start:${op}`, `stop:${op}`, `prepare:${op}`])
    await f.lane(SESSION, 'claude-sonnet-5-5-remote')
    assert.deepEqual(f.events.slice(4), [`prepare:${op}`], 'never started: no remote stop needed')
    assert.equal(JSON.parse(readFileSync(join(handle.mountSource, op, 'binding.json'), 'utf8')).canonicalModel,
      'claude-sonnet-5-5-remote')
    assert.equal(f.places.length, 3)
  } finally {
    await f.cleanup()
  }
})

test('release stops every lane, reports an unproved exit, and never blocks the next container', { skip: !root }, async () => {
  const f = fixture({ failStop: true })
  try {
    const handle = await f.container()
    const a = await f.lane()
    const b = await f.lane('agent:main:webchat:dm:fixture_chat2')
    for (const op of [a.operationId, b.operationId]) {
      const binding = JSON.parse(readFileSync(join(handle.mountSource, op, 'binding.json'), 'utf8')) as Cc5BridgeBinding
      await cc5ControlRequest('/admit', admission(f.key, binding), join(handle.mountSource, op, 'relay.sock'))
    }
    await f.runtime.release('91', DOCKER)
    assert.equal(existsSync(handle.mountSource), false)
    assert.deepEqual(new Set(f.states.filter(([, s]) => s !== 'running')),
      new Set([[a.operationId, 'unknown'], [b.operationId, 'unknown']]))
    await assert.rejects(f.lane(), /REMOTE_LANE_UNAVAILABLE/)
    await f.container('91') // A new container of the same row is served again.
    assert.equal((await f.lane()).operationId, a.operationId)
  } finally {
    await f.cleanup()
  }
})

test('a node that cannot be prepared fails the turn without leaving a lane behind', { skip: !root }, async () => {
  const f = fixture({ failPrepare: true })
  try {
    const handle = await f.container()
    await assert.rejects(f.lane(), (error: Error) =>
      error.message === 'REMOTE_LANE_UNAVAILABLE' && (error.cause as Error).message === 'fixture node unreachable')
    assert.deepEqual(readdirSync(handle.mountSource), ['authority-public.json'])
    assert.equal(f.states.at(-1)?.[1], 'released')
  } finally {
    await f.cleanup()
  }
})

test('a restarted master adopts live container views, drops lane leftovers and ignores unknown entries', { skip: !root }, async () => {
  const first = fixture()
  try {
    const handle = await first.container()
    const lane = await first.lane()
    // A former master's single-lane layout and garbage must not block startup.
    writeFileSync(join(handle.mountSource, 'binding.json'), '{}')
    mkdirSync(join(first.baseRoot, 'not-a-container'))
    mkdirSync(join(first.baseRoot, 'b'.repeat(24)), { mode: 0o700 })
    const restarted = fixture({ baseRoot: first.baseRoot })
    assert.deepEqual(readdirSync(handle.mountSource), ['authority-public.json'])
    const backend = await restarted.lane()
    assert.equal(backend.sessionKey, SESSION)
    assert.notEqual(backend.operationId, lane.operationId, 'fixture placement is per runtime')
    assert.deepEqual(restarted.events, [`prepare:${backend.operationId}`],
      'the node root is reset before the adopted container gets a lane')
    await restarted.runtime.release('91')
  } finally {
    await first.cleanup()
  }
})

async function startHost(f: ReturnType<typeof fixture>, mountSource: string, operationId: string) {
  const view = join(mountSource, operationId)
  const b = JSON.parse(readFileSync(join(view, 'binding.json'), 'utf8')) as Cc5BridgeBinding
  await cc5ControlRequest('/admit', admission(f.key, b), join(view, 'relay.sock'))
}

test('a chat moving to another container hands its node root over only after the old lane stopped', { skip: !root }, async () => {
  const f = fixture()
  try {
    const a = await f.container('91')
    const b = await f.container('92')
    const first = await f.lane(SESSION, MODEL, '91')
    await startHost(f, a.mountSource, first.operationId)
    const moved = await f.lane(SESSION, MODEL, '92')
    const op = first.operationId
    assert.equal(moved.operationId, op, 'same chat, same node root')
    assert.deepEqual(f.events, [`prepare:${op}`, `start:${op}`, `stop:${op}`, `prepare:${op}`])
    assert.deepEqual(readdirSync(a.mountSource), ['authority-public.json'])
    assert.deepEqual(readdirSync(b.mountSource).sort(), ['authority-public.json', op].sort())
    await f.runtime.release('92')
  } finally {
    await f.cleanup()
  }
})

test('concurrent first turns of one chat in two containers are placed one after the other', { skip: !root }, async () => {
  const f = fixture()
  try {
    const a = await f.container('91')
    const b = await f.container('92')
    const [x, y] = await Promise.all([f.lane(SESSION, MODEL, '91'), f.lane(SESSION, MODEL, '92')])
    assert.equal(x.operationId, y.operationId)
    assert.deepEqual(f.places.map((p) => p.containerDbId), ['91', '92'], 'the second waited for the first')
    assert.deepEqual(f.events, [`prepare:${x.operationId}`, `prepare:${x.operationId}`])
    const views = [...readdirSync(a.mountSource), ...readdirSync(b.mountSource)].filter((n) => n !== 'authority-public.json')
    assert.deepEqual(views, [x.operationId], 'exactly one live lane for the chat')
    await f.runtime.release('92')
  } finally {
    await f.cleanup()
  }
})

test('a container released while its lane is being prepared never ends up serving it', { skip: !root }, async () => {
  let open!: () => void
  const f = fixture({ holdPrepare: new Promise<void>((resolve) => { open = resolve }) })
  try {
    const handle = await f.container()
    const pending = f.lane()
    while (f.events.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    const released = f.runtime.release('91')
    open()
    await assert.rejects(pending, /REMOTE_LANE_UNAVAILABLE/)
    await released
    assert.equal(existsSync(handle.mountSource), false)
    assert.deepEqual(f.states.filter(([, s]) => s === 'running'), [])
  } finally {
    await f.cleanup()
  }
})

test('two different models queued for one chat each get their own lane in order', { skip: !root }, async () => {
  const f = fixture()
  try {
    const handle = await f.container()
    const [opus, haiku] = await Promise.all([f.lane(SESSION, MODEL), f.lane(SESSION, 'claude-haiku-5-5-remote')])
    assert.equal(opus.operationId, haiku.operationId)
    const b = JSON.parse(readFileSync(join(handle.mountSource, haiku.operationId, 'binding.json'), 'utf8'))
    assert.equal(b.canonicalModel, 'claude-haiku-5-5-remote', 'the later request is not handed the earlier model')
  } finally {
    await f.cleanup()
  }
})

test('a request queued for a container that was released meanwhile leaves the other container lane alone', { skip: !root }, async () => {
  let open!: () => void
  const f = fixture({ holdPrepare: new Promise<void>((resolve) => { open = resolve }) })
  try {
    await f.container('91')
    const b = await f.container('92')
    const fresh = f.lane(SESSION, MODEL, '92')
    while (f.events.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    const stale = f.lane(SESSION, MODEL, '91')
    const released = f.runtime.release('91')
    open()
    const backend = await fresh
    await assert.rejects(stale, /REMOTE_LANE_UNAVAILABLE/)
    await released
    assert.deepEqual(f.places.map((p) => p.containerDbId), ['92'])
    assert.deepEqual(readdirSync(b.mountSource).sort(), ['authority-public.json', backend.operationId].sort())
    assert.ok(existsSync(join(b.mountSource, backend.operationId, 'relay.sock')), 'the new container keeps serving')
    await f.runtime.release('92')
  } finally {
    await f.cleanup()
  }
})

test('Codex creation failures release unexposed placement; failed running write never publishes a live owner', { skip: !root }, async () => {
  for (const failure of ['finance','key','running'] as const) {
    const dir=mkdtempSync('/tmp/cr-'), states:string[]=[], operationId=randomUUID(), runId=randomUUID()
    const key=generateKeyPairSync('ed25519'), keyPath=join(dir,'key'), knownHostsPath=join(dir,'hosts')
    writeFileSync(keyPath,'fixture',{mode:0o600}); writeFileSync(knownHostsPath,'fixture',{mode:0o600})
    let attempts=0
    const preflight = CodexSshHost.prototype.preflight
    CodexSshHost.prototype.preflight = async () => ({memoryOk:true,activeSessions:0})
    const runtime=createRemoteLaneRuntime({selfhost:true,env,
      financeFactory:()=>{if(failure==='finance')throw new Error('finance unavailable');return {admit:async()=>{throw new Error('must not admit')}}},
      configuration:()=>({baseRoot:join(dir,'runtime'),controllerPath:'/unused'}),hooks:{
        async place() { attempts++; const generation=String(attempts); return {operationId,runId,generation,taskRoot:'/unused',provisionPacket:Buffer.alloc(0),
          target:{host:'fixture.invalid',port:22,user:'box',keyPath:failure==='key'?join(dir,'missing'):keyPath,knownHostsPath,
            controllerSha256:'a'.repeat(64),upstreamModel:'gpt-6-luna',taskRootPrefix:'/home/box/oc-codexremote-'},
          codex:{controllerPath:`/opt/openclaude/codex-remote/${'a'.repeat(64)}/codex-host-controller.py`,
            manifest:{version:1,engine:'codex',operationId,runId,generation,profileId:'default',authEpoch:'epoch1',model:'gpt-6-luna',
              root:`/home/box/oc-codexremote-${operationId.replaceAll('-','')}-g${generation}`,nativeThreadId:null,codexHome:'/unused',
              controllerSha256:'a'.repeat(64),cliSha256:'b'.repeat(64),nativeSha256:'c'.repeat(64)},modelList:[],modelCatalog:{models:[]}}} },
        async onNativeThread(){}, async onRemoteStart(){throw new Error('must not start')},
        async onState(_op,state){states.push(state);if(failure==='running' && state==='running')throw new Error('write unavailable')},
      }})!
    try {
      const handle=(await runtime.prepare({uid:912,containerDbId:'91',local:true,
        publicKeyring:`fixture-key:${key.publicKey.export({format:'jwk'}).x}`}))!
      await runtime.bindCreated(handle,DOCKER);await runtime.activate(handle,DOCKER)
      const ensure=()=>runtime.ensureLane({uid:912,containerDbId:'91',sessionKey:SESSION,canonicalModel:'gpt-6-luna-remote',engine:'codex'})
      await assert.rejects(ensure(),/REMOTE_LANE_UNAVAILABLE/)
      assert.equal(states.at(-1),'released',failure)
      if (failure === 'running') assert.ok(states.includes('running'),'must reach the intended state-write fault')
      assert.deepEqual(readdirSync(handle.mountSource),['authority-public.json'])
      await assert.rejects(ensure(),/REMOTE_LANE_UNAVAILABLE/)
      assert.equal(attempts,2,'failed running callback must not leave a reusable owner')
    } finally { CodexSshHost.prototype.preflight = preflight; await runtime.release('91');rmSync(dir,{recursive:true,force:true}) }
  }
})


test('R1 prepare failure closes persistent placement; unproved stop occupies until proof then same chat retries', {skip: !root}, async () => {
  for (const unknown of [false, true]) {
    const options = {failPrepare: true, failStop: unknown, enforcePlacementState: true}
    const f = fixture(options)
    try {
      await f.container()
      await assert.rejects(f.lane(), /REMOTE_LANE_UNAVAILABLE/)
      assert.equal(f.states.at(-1)?.[1], unknown ? 'unknown' : 'released')
      if (unknown) {
        options.failPrepare = false
        await assert.rejects(f.lane(), /REMOTE_LANE_UNAVAILABLE/)
        assert.equal(f.places.length, 1, 'no second placement before stop proof')
      }
      options.failStop = false
      options.failPrepare = false
      const recovered = await f.lane()
      assert.ok(recovered.operationId)
      assert.equal(f.states.at(-1)?.[1], 'running')
      assert.equal(f.places.length, 2)
    } finally { await f.cleanup() }
  }
})
