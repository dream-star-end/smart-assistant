/**
 * 容器侧模型执行权威 —— 验签消费 + gateway 断言全集(docs/V5_MODEL_AUTHORITY_PLAN.md §2/§8)。
 *
 * 跑法:npx tsx --test src/__tests__/modelAuthorityConsume.test.ts
 *
 * 这里**不 import commercial 的签发器**(容器不该看见 master 代码):测试自己用
 * node:crypto + protocol 的编码原语铸票 —— 顺带证明「签发侧不是同一份代码也能被验通过」,
 * 即签名格式的权威真的收在 protocol(而不是靠两侧共享实现细节)。
 *
 * 覆盖(方案 §8 单测清单):伪造 / 过期 / 重放 / cache 满 / gateway 重启重放 / epoch 回退 /
 * model 不一致 / 未知 capability version / lease 绑定 / 身份不符 / strip / descriptor 驱动
 * engine 与 model 选择 / 未配置时零行为变化。
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'

import {
  MODEL_AUTHORITY_CAPABILITY,
  MODEL_AUTHORITY_FIELD,
  MODEL_AUTHORITY_VERSION,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  turnLeaseSigningInput,
  type ModelAuthorityPayload,
  type ModelExecutionDescriptor,
  type TurnLease,
} from '@openclaude/protocol'

import {
  AuthorityRejected,
  GATEWAY_CAPABILITY_SCHEMA_VERSION,
  ModelAuthorityConsumer,
  attachTurnAuthority,
  buildContainerAttestFrame,
  getTurnAuthority,
  stripModelAuthorityField,
  type TurnExecutionDescriptor,
} from '../modelAuthority.js'
import { resolveEngine } from '../engine/registry.js'
import { resolveExecutionModel } from '../server.js'

// ─────────────────────────────────────────────────────────────────────────────
// 铸票夹具(master 的角色)
// ─────────────────────────────────────────────────────────────────────────────

const UID = 42
const CONTAINER_ID = 7
const NOW = 1_800_000_000_000

interface TestKey {
  keyId: string
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
  publicRaw: Uint8Array
}

function makeKey(keyId: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string }
  return { keyId, privateKey, publicRaw: new Uint8Array(Buffer.from(jwk.x, 'base64url')) }
}

function keyring(...keys: TestKey[]): Map<string, Uint8Array> {
  return new Map(keys.map((k) => [k.keyId, k.publicRaw]))
}

const DESCRIPTOR: ModelExecutionDescriptor = {
  capabilityProfile: {
    supportsVision: false,
    reasoning: { supported: ['low', 'medium', 'high'], codexModelDefault: null },
    ccb: { capabilityZero: true, supportsThinking: true },
  },
  capabilitySchemaVersion: 1,
  contextWindow: 200_000,
  supportedEfforts: ['low', 'medium', 'high'],
  supportsVision: false,
}

const CODEX_DESCRIPTOR: ModelExecutionDescriptor = {
  capabilityProfile: {
    supportsVision: true,
    reasoning: { supported: ['medium', 'xhigh'], codexModelDefault: 'xhigh' },
    ccb: { capabilityZero: false, supportsThinking: false },
  },
  capabilitySchemaVersion: 1,
  contextWindow: 400_000,
  supportedEfforts: ['medium', 'xhigh'],
  codexDefaultEffort: 'xhigh',
  supportsVision: true,
}

function mintFrame(
  key: TestKey,
  overrides: Partial<ModelAuthorityPayload> = {},
  opts: { leaseOverrides?: Partial<TurnLease>; leaseKey?: TestKey } = {},
): Record<string, unknown> {
  const payload: ModelAuthorityPayload = {
    v: MODEL_AUTHORITY_VERSION,
    keyId: key.keyId,
    uid: UID,
    containerId: CONTAINER_ID,
    authorityTurnId: 'turn-' + Math.random().toString(16).slice(2),
    connectionChallenge: 'chal-default',
    canonicalModel: 'glm-5.2',
    engine: 'ccb',
    executionDescriptor: DESCRIPTOR,
    executionRevision: 'rev-1',
    securityEpoch: 10,
    issuedAt: NOW,
    expiresAt: NOW + 120_000,
    ...overrides,
  }
  const lease: TurnLease = {
    v: MODEL_AUTHORITY_VERSION,
    keyId: (opts.leaseKey ?? key).keyId,
    uid: payload.uid,
    containerId: payload.containerId,
    authorityTurnId: payload.authorityTurnId,
    canonicalModel: payload.canonicalModel,
    securityEpoch: payload.securityEpoch,
    connectionChallenge: payload.connectionChallenge,
    issuedAt: NOW,
    expiresAt: NOW + 50 * 60_000,
    ...opts.leaseOverrides,
  }
  const leaseKey = opts.leaseKey ?? key
  return {
    type: 'inbound.message',
    model: payload.canonicalModel,
    ...(payload.engine === 'codex' && typeof payload.billingRequestId === 'string'
      ? { requestId: payload.billingRequestId }
      : {}),
    [MODEL_AUTHORITY_FIELD]: {
      authority: encodeAuthorityEnvelope(
        payload,
        cryptoSign(null, authoritySigningInput(payload), key.privateKey),
      ),
      lease: encodeTurnLeaseEnvelope(
        lease,
        cryptoSign(null, turnLeaseSigningInput(lease), leaseKey.privateKey),
      ),
    },
  }
}

function makeConsumer(
  key: TestKey,
  opts: { required?: boolean; replayCapacity?: number; alerts?: string[] } = {},
): ModelAuthorityConsumer {
  return new ModelAuthorityConsumer({
    keyring: keyring(key),
    uid: UID,
    containerId: CONTAINER_ID,
    required: opts.required,
    replayCapacity: opts.replayCapacity,
    clock: () => NOW,
    onAlert: (event) => opts.alerts?.push(event),
  })
}

function expectReject(fn: () => unknown, code: string): AuthorityRejected {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof AuthorityRejected, `expected AuthorityRejected, got ${String(err)}`)
    assert.equal(err.code, code)
    return err
  }
  throw new Error(`expected AuthorityRejected(${code}), but call succeeded`)
}

// ─────────────────────────────────────────────────────────────────────────────

describe('modelAuthority — 验签 + gateway 断言全集', () => {
  test('happy path:验签通过 → descriptor 驱动该 turn', () => {
    const key = makeKey('mak1_a')
    const consumer = makeConsumer(key)
    const conn = consumer.newConnection()
    const frame = mintFrame(key, { connectionChallenge: conn.challenge })

    const d = consumer.consume(frame, conn)
    assert.equal(d.canonicalModel, 'glm-5.2')
    assert.equal(d.engine, 'ccb')
    assert.equal(d.contextWindow, 200_000)
    assert.equal(d.supportsVision, false)
    assert.deepEqual([...d.supportedEfforts], ['low', 'medium', 'high'])
    assert.equal(d.securityEpoch, 10)
    // 两张 envelope 原样保留 → CCB proxy 请求绑定(方案 §4)的接线材料。
    const bundle = (mintedBundle: unknown) => mintedBundle as { authority: string; lease: string }
    const raw = bundle(frame[MODEL_AUTHORITY_FIELD])
    assert.equal(d.authorityEnvelope, raw.authority)
    assert.equal(d.leaseEnvelope, raw.lease)
  })

  test('伪造签名(不在 keyring 的私钥)→ unknown_key', () => {
    const real = makeKey('mak1_real')
    const forged = makeKey('mak1_forged')
    const consumer = makeConsumer(real)
    const conn = consumer.newConnection()
    const frame = mintFrame(forged, { connectionChallenge: conn.challenge })
    expectReject(() => consumer.consume(frame, conn), 'unknown_key')
  })

  test('篡改载荷(同 keyId,改 model)→ verify_fail', () => {
    const key = makeKey('mak1_a')
    const consumer = makeConsumer(key)
    const conn = consumer.newConnection()
    const frame = mintFrame(key, { connectionChallenge: conn.challenge })
    // 解开 envelope 改一个字段再塞回去(签名不变)→ 必须验不过。
    const bundle = frame[MODEL_AUTHORITY_FIELD] as { authority: string; lease: string }
    const decoded = JSON.parse(Buffer.from(bundle.authority, 'base64url').toString('utf8'))
    decoded.payload.canonicalModel = 'gpt-5.6-sol'
    bundle.authority = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    frame.model = 'gpt-5.6-sol'
    expectReject(() => consumer.consume(frame, conn), 'verify_fail')
  })

  test('重放:同 authorityTurnId 第二次 → replay(单次消费)', () => {
    const key = makeKey('mak1_a')
    const consumer = makeConsumer(key)
    const conn = consumer.newConnection()
    const frame = mintFrame(key, {
      connectionChallenge: conn.challenge,
      authorityTurnId: 'fixed-turn',
    })
    consumer.consume(frame, conn)
    expectReject(() => consumer.consume(frame, conn), 'replay')
  })

  test('replay cache 满且全为活跃条目 → 拒新 authority + 告警(绝不淘汰活跃条目)', () => {
    const key = makeKey('mak1_a')
    const alerts: string[] = []
    const consumer = makeConsumer(key, { replayCapacity: 2, alerts })
    const conn = consumer.newConnection()
    for (const id of ['t1', 't2']) {
      consumer.consume(
        mintFrame(key, { connectionChallenge: conn.challenge, authorityTurnId: id }),
        conn,
      )
    }
    expectReject(
      () =>
        consumer.consume(
          mintFrame(key, { connectionChallenge: conn.challenge, authorityTurnId: 't3' }),
          conn,
        ),
      'replay_cache_full',
    )
    assert.deepEqual(alerts, ['model_authority.replay_cache_full'])
    // 关键不变量:t1 仍在 cache 里(**没有**被新 authority 挤掉)→ 重放它依旧被拒。
    expectReject(
      () =>
        consumer.consume(
          mintFrame(key, { connectionChallenge: conn.challenge, authorityTurnId: 't1' }),
          conn,
        ),
      'replay',
    )
  })

  test('gateway 重启 / 换连接 → 旧 envelope 的 challenge 不匹配 → challenge_mismatch', () => {
    const key = makeKey('mak1_a')
    const consumer = makeConsumer(key)
    const conn = consumer.newConnection()
    const frame = mintFrame(key, { connectionChallenge: conn.challenge })

    // 「gateway 重启」= 新进程 + 新 challenge。旧 envelope 天然失效,无需跨进程 replay cache。
    const restarted = makeConsumer(key)
    const conn2 = restarted.newConnection()
    assert.notEqual(conn2.challenge, conn.challenge)
    expectReject(() => restarted.consume(frame, conn2), 'challenge_mismatch')
  })

  test('epoch 回退(安全撤销后的旧签名)→ epoch_regressed', () => {
    const key = makeKey('mak1_a')
    const consumer = makeConsumer(key)
    const conn = consumer.newConnection()
    consumer.consume(
      mintFrame(key, { connectionChallenge: conn.challenge, securityEpoch: 20 }),
      conn,
    )
    expectReject(
      () =>
        consumer.consume(
          mintFrame(key, { connectionChallenge: conn.challenge, securityEpoch: 19 }),
          conn,
        ),
      'epoch_regressed',
    )
    // 同 epoch 放行(单调 = 不降,不是严格递增 —— 同快照的多条 turn 是常态)。
    const same = consumer.consume(
      mintFrame(key, { connectionChallenge: conn.challenge, securityEpoch: 20 }),
      conn,
    )
    assert.equal(same.securityEpoch, 20)
  })

  test('伪造的高 epoch 帧不得抬高水位(否则合法帧被自伤式拒)', () => {
    const real = makeKey('mak1_real')
    const forged = makeKey('mak1_forged')
    const consumer = makeConsumer(real)
    const conn = consumer.newConnection()
    expectReject(
      () =>
        consumer.consume(
          mintFrame(forged, { connectionChallenge: conn.challenge, securityEpoch: 9999 }),
          conn,
        ),
      'unknown_key',
    )
    // 水位没被顶上去 → 合法的 epoch=10 帧仍然放行。
    const ok = consumer.consume(mintFrame(real, { connectionChallenge: conn.challenge }), conn)
    assert.equal(ok.securityEpoch, 10)
  })

  test('过期 authority → expired', () => {
    const key = makeKey('mak1_a')
    const consumer = makeConsumer(key)
    const conn = consumer.newConnection()
    const frame = mintFrame(key, {
      connectionChallenge: conn.challenge,
      expiresAt: NOW - 1,
    })
    expectReject(() => consumer.consume(frame, conn), 'expired')
  })

  test('lease 与 authority 不同 turn → lease_mismatch(跨 turn 降级攻击)', () => {
    const key = makeKey('mak1_a')
    const consumer = makeConsumer(key)
    const conn = consumer.newConnection()
    const frame = mintFrame(
      key,
      { connectionChallenge: conn.challenge, authorityTurnId: 'turn-A' },
      { leaseOverrides: { authorityTurnId: 'turn-B' } },
    )
    expectReject(() => consumer.consume(frame, conn), 'lease_mismatch')
  })

  test('uid / containerId 不是本容器 → identity_mismatch', () => {
    const key = makeKey('mak1_a')
    const consumer = makeConsumer(key)
    const conn = consumer.newConnection()
    expectReject(
      () => consumer.consume(mintFrame(key, { connectionChallenge: conn.challenge, uid: 43 }), conn),
      'identity_mismatch',
    )
    expectReject(
      () =>
        consumer.consume(
          mintFrame(key, { connectionChallenge: conn.challenge, containerId: 8 }),
          conn,
        ),
      'identity_mismatch',
    )
  })

  test('frame.model 与 descriptor.canonicalModel 不一致 → model_mismatch', () => {
    const key = makeKey('mak1_a')
    const consumer = makeConsumer(key)
    const conn = consumer.newConnection()
    const frame = mintFrame(key, { connectionChallenge: conn.challenge })
    frame.model = 'deepseek-v4-pro' // 帧被改成另一个模型,签名仍是 glm-5.2 的
    expectReject(() => consumer.consume(frame, conn), 'model_mismatch')

    // model 字段缺失同样拒(bridge 注入时必定归一并写 canonical)。
    const frame2 = mintFrame(key, { connectionChallenge: conn.challenge })
    delete frame2.model
    expectReject(() => consumer.consume(frame2, conn), 'model_mismatch')
  })

  test('codex billingRequestId 必须与 server-owned frame.requestId 精确绑定', () => {
    const key = makeKey('mak1_a')
    const consumer = makeConsumer(key)
    const conn = consumer.newConnection()
    const frame = mintFrame(key, {
      connectionChallenge: conn.challenge,
      canonicalModel: 'gpt-5.6-sol',
      engine: 'codex',
      billingRequestId: '0123456789abcdef0123456789abcdef',
      executionDescriptor: CODEX_DESCRIPTOR,
    })
    frame.requestId = 'fedcba9876543210fedcba9876543210'
    expectReject(() => consumer.consume(frame, conn), 'billing_request_mismatch')
  })

  test('capability schema 未来版本 → unknown_capability_version(fail-closed,不尽力解析)', () => {
    const key = makeKey('mak1_a')
    const consumer = makeConsumer(key)
    const conn = consumer.newConnection()
    const frame = mintFrame(key, {
      connectionChallenge: conn.challenge,
      executionDescriptor: {
        ...DESCRIPTOR,
        capabilitySchemaVersion: GATEWAY_CAPABILITY_SCHEMA_VERSION + 1,
      },
    })
    expectReject(() => consumer.consume(frame, conn), 'unknown_capability_version')
  })

  test('缺 envelope:required=false 放行(flag 未开)/ required=true 拒', () => {
    const key = makeKey('mak1_a')
    const conn = makeConsumer(key).newConnection()
    const bare = { type: 'inbound.message', model: 'glm-5.2' }

    const lenient = makeConsumer(key)
    expectReject(() => lenient.consume(bare, conn), 'missing')
    assert.equal(lenient.required, false, 'flag 未开 → 调用方按 missing 放行(见 server 真值表)')

    const strict = makeConsumer(key, { required: true })
    assert.equal(strict.required, true)
    expectReject(() => strict.consume(bare, conn), 'missing')
  })

  test('未配置 keyring / 身份 env → enabled=false,不广播 capability(旧 env 容器骗不到 bridge)', () => {
    const empty = new ModelAuthorityConsumer({ keyring: new Map(), clock: () => NOW })
    assert.equal(empty.enabled, false)
    assert.deepEqual(empty.capabilities(), [])
    const conn = empty.newConnection()
    expectReject(() => empty.consume({ type: 'inbound.message' }, conn), 'not_configured')

    // 有 keyring 但没有容器身份 env → 依然 not enabled(验得了签也证明不了"这是给我的")。
    const key = makeKey('mak1_a')
    const noIdentity = new ModelAuthorityConsumer({ keyring: keyring(key), clock: () => NOW })
    assert.equal(noIdentity.enabled, false)

    const ready = makeConsumer(key)
    assert.equal(ready.enabled, true)
    assert.deepEqual(ready.capabilities(), [MODEL_AUTHORITY_CAPABILITY])
  })

  test('attest 帧形状:capability + challenge(bridge 消费的唯一两个字段)', () => {
    const key = makeKey('mak1_a')
    const consumer = makeConsumer(key)
    const conn = consumer.newConnection()
    const frame = buildContainerAttestFrame(consumer, conn, CONTAINER_ID)
    assert.equal(frame.type, 'outbound.control.container_attest')
    assert.deepEqual(frame.capabilities, [MODEL_AUTHORITY_CAPABILITY])
    assert.equal(frame.connectionChallenge, conn.challenge)
    assert.equal(frame.containerId, CONTAINER_ID)
  })

  test('strip:一切入口无条件剥离 wire 字段;descriptor 走 WeakMap 不可伪造', () => {
    const frame: Record<string, unknown> = {
      type: 'inbound.message',
      [MODEL_AUTHORITY_FIELD]: { authority: 'x', lease: 'y' },
    }
    stripModelAuthorityField(frame)
    assert.equal(MODEL_AUTHORITY_FIELD in frame, false)

    // wire 上伪造不出 WeakMap 条目:只有 attachTurnAuthority 能挂。
    assert.equal(getTurnAuthority(frame), undefined)
    const d: TurnExecutionDescriptor = {
      canonicalModel: 'glm-5.2',
      engine: 'ccb',
      contextWindow: 1,
      supportsVision: false,
      supportedEfforts: [],
      capabilityProfile: {},
      capabilitySchemaVersion: 1,
      executionRevision: 'r',
      securityEpoch: 1,
      authorityTurnId: 't',
      authorityEnvelope: 'a',
      leaseEnvelope: 'l',
    }
    attachTurnAuthority(frame, d)
    assert.equal(getTurnAuthority(frame)?.canonicalModel, 'glm-5.2')
  })
})

describe('descriptor 驱动执行选择(engine / model)', () => {
  const mainAgent = { id: 'main' } as never

  test('resolveEngine:有 descriptor → 只认 descriptor.engine(baked 表不参与)', () => {
    // baked MODEL_ENGINE_MAP 不认识 'brand-new-codex-model',旧逻辑会判 ccb。
    assert.equal(resolveEngine('brand-new-codex-model', mainAgent), 'ccb')
    assert.equal(
      resolveEngine('brand-new-codex-model', mainAgent, {
        canonicalModel: 'brand-new-codex-model',
        engine: 'codex',
      }),
      'codex',
    )
    // 反向:baked 认为是 codex 的模型,catalog 说它迁回 ccb → 听 catalog。
    assert.equal(resolveEngine('gpt-5.6-sol', mainAgent), 'codex')
    assert.equal(
      resolveEngine('gpt-5.6-sol', mainAgent, { canonicalModel: 'gpt-5.6-sol', engine: 'ccb' }),
      'ccb',
    )
  })

  test('resolveEngine:codex-native pin 与 descriptor 冲突 → fail-closed 抛', () => {
    const pinned = { id: 'codex', provider: 'codex-native' } as never
    assert.equal(resolveEngine(undefined, pinned), 'codex')
    assert.equal(
      resolveEngine('gpt-5.6-sol', pinned, { canonicalModel: 'gpt-5.6-sol', engine: 'codex' }),
      'codex',
    )
    assert.throws(
      () => resolveEngine('glm-5.2', pinned, { canonicalModel: 'glm-5.2', engine: 'ccb' }),
      /fail-closed/,
    )
  })

  test('resolveExecutionModel:有 descriptor → 不过 baked 白名单(新模型不再被降级)', () => {
    // 旧行为:白名单外的模型被收敛成平台默认。
    assert.equal(resolveExecutionModel('catalog-only-model', undefined), 'glm-5.2')
    // descriptor 存在 → 直接落地(catalog 是唯一判定者)。
    assert.equal(
      resolveExecutionModel('catalog-only-model', undefined, {
        canonicalModel: 'catalog-only-model',
      }),
      'catalog-only-model',
    )
  })

  test('codex descriptor 携带默认 effort(effort 判定源上移 descriptor)', () => {
    const key = makeKey('mak1_a')
    const consumer = makeConsumer(key)
    const conn = consumer.newConnection()
    const d = consumer.consume(
      mintFrame(key, {
        connectionChallenge: conn.challenge,
        canonicalModel: 'gpt-5.6-sol',
        engine: 'codex',
        billingRequestId: '0123456789abcdef0123456789abcdef',
        executionDescriptor: CODEX_DESCRIPTOR,
      }),
      conn,
    )
    assert.equal(d.engine, 'codex')
    assert.equal(d.codexDefaultEffort, 'xhigh')
    assert.deepEqual([...d.supportedEfforts], ['medium', 'xhigh'])
    assert.equal(d.supportsVision, true)
  })
})
