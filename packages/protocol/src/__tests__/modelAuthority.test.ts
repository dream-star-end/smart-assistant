/**
 * 模型执行权威 —— JCS 规范编码 + Ed25519 验签的行为锁死。
 *
 * 这些断言是 master 与容器之间的**签名互认合同**:任何一条被改动,双方就会
 * 在某些输入上算出不同签名字节 → 验签随机失败(最难查的一类事故)。
 *
 * 私钥只在测试里出现(生产私钥独占于 commercial/ws/authoritySigner.ts)。
 */
import * as assert from 'node:assert/strict'
import { sign as cryptoSign, generateKeyPairSync } from 'node:crypto'
import { describe, it } from 'node:test'

import {
  AUTHORITY_TTL_MS,
  type JsonValue,
  MODEL_AUTHORITY_FIELD,
  MODEL_AUTHORITY_VERSION,
  ModelAuthorityError,
  type ModelAuthorityPayload,
  type TurnLease,
  assertLeaseMatchesAuthority,
  authoritySigningInput,
  canonicalizePayload,
  encodeAuthorityEnvelope,
  encodeAuthorityKeyring,
  encodeTurnLeaseEnvelope,
  isModelAllowedByAuthority,
  parseAuthorityKeyring,
  stripModelAuthorityField,
  turnLeaseSigningInput,
  verifyAuthority,
  verifyTurnLease,
} from '../modelAuthority.js'

// --- 测试用签名工具(模拟 master 签发器)------------------------------------

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const publicRaw = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url')
const KEY_ID = 'mak1_testkey00000001'
const keyring = new Map<string, Uint8Array>([[KEY_ID, new Uint8Array(publicRaw)]])

const NOW = 1_760_000_000_000

function makePayload(over: Partial<ModelAuthorityPayload> = {}): ModelAuthorityPayload {
  return {
    v: MODEL_AUTHORITY_VERSION,
    keyId: KEY_ID,
    uid: 42,
    containerId: 7,
    authorityTurnId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    connectionChallenge: 'chal-1',
    canonicalModel: 'gpt-5.6-sol',
    engine: 'codex',
    executionDescriptor: {
      capabilityProfile: { tools: ['bash', 'web'], nested: { a: 1, b: [true, null] } },
      capabilitySchemaVersion: 1,
      contextWindow: 400_000,
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      codexDefaultEffort: 'xhigh',
      supportsVision: true,
    },
    executionRevision: 'a'.repeat(64),
    securityEpoch: 12,
    issuedAt: NOW,
    expiresAt: NOW + AUTHORITY_TTL_MS,
    ...over,
  }
}

function makeLease(over: Partial<TurnLease> = {}): TurnLease {
  const p = makePayload()
  return {
    v: MODEL_AUTHORITY_VERSION,
    keyId: p.keyId,
    uid: p.uid,
    containerId: p.containerId,
    authorityTurnId: p.authorityTurnId,
    canonicalModel: p.canonicalModel,
    securityEpoch: p.securityEpoch,
    connectionChallenge: p.connectionChallenge,
    issuedAt: NOW,
    expiresAt: NOW + 50 * 60_000,
    ...over,
  }
}

function signAuthorityEnvelope(p: ModelAuthorityPayload): string {
  return encodeAuthorityEnvelope(p, cryptoSign(null, authoritySigningInput(p), privateKey))
}

function signLeaseEnvelope(l: TurnLease): string {
  return encodeTurnLeaseEnvelope(l, cryptoSign(null, turnLeaseSigningInput(l), privateKey))
}

/** 直接拼一个「payload 与 sig 不匹配」的 envelope(模拟中间人篡改字段)。 */
function forgeEnvelope(kind: string, payload: JsonValue, sigB64u: string): string {
  const env = { v: MODEL_AUTHORITY_VERSION, kind, payload, sig: sigB64u }
  return Buffer.from(JSON.stringify(env), 'utf8').toString('base64url')
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof ModelAuthorityError, `expected ModelAuthorityError, got ${String(e)}`)
    assert.equal((e as ModelAuthorityError).code, code)
    return
  }
  assert.fail(`expected throw with code ${code}`)
}

// --- JCS ---------------------------------------------------------------------

describe('canonicalizePayload (RFC 8785 风格)', () => {
  it('键序无关:同语义不同插入顺序 → 同一字节串', () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } }
    const b = { c: { y: 2, z: 1 }, a: 2, b: 1 }
    assert.equal(canonicalizePayload(a), canonicalizePayload(b))
    assert.equal(canonicalizePayload(a), '{"a":2,"b":1,"c":{"y":2,"z":1}}')
  })

  it('空白无关:同一 JSON 文本的不同排版 → 同一字节串', () => {
    const compact = JSON.parse('{"a":1,"b":[1,2]}') as JsonValue
    const pretty = JSON.parse('{\n  "b" : [ 1,\n 2 ],\n  "a":\t1\n}') as JsonValue
    assert.equal(canonicalizePayload(compact), canonicalizePayload(pretty))
  })

  it('键按 UTF-16 code unit 升序(不是 localeCompare)', () => {
    // code unit:'Z'=0x5A < 'a'=0x61 < 'ä'=0xE4 < '中'=0x4E2D。
    // localeCompare 会把 'ä' 排到 'a' 旁边 —— 那样 master/容器如果一方用了 locale 序就对不上。
    const out = canonicalizePayload({ ä: 1, 中: 2, a: 3, Z: 4 })
    assert.equal(out, '{"Z":4,"a":3,"ä":1,"中":2}')
  })

  it('数组保序(数组不排序)', () => {
    assert.equal(canonicalizePayload([3, 1, 2] as unknown as JsonValue), '[3,1,2]')
  })

  it('数字:整数/小数/指数/-0 边界', () => {
    assert.equal(canonicalizePayload(0), '0')
    assert.equal(canonicalizePayload(-0), '0') // RFC 8785 §3.2.2.3:-0 → "0"
    assert.equal(canonicalizePayload(1.5), '1.5')
    assert.equal(canonicalizePayload(1e21), '1e+21')
    assert.equal(canonicalizePayload(1e-7), '1e-7')
    assert.equal(canonicalizePayload(Number.MAX_SAFE_INTEGER), '9007199254740991')
    assert.equal(canonicalizePayload(0.1 + 0.2), '0.30000000000000004') // 最短往返表示
  })

  it('非有限数字 → BadShape', () => {
    expectCode(() => canonicalizePayload(Number.NaN), 'BadShape')
    expectCode(() => canonicalizePayload(Number.POSITIVE_INFINITY), 'BadShape')
  })

  it('unicode:非 ASCII 原样输出,控制符小写 \\u00xx 转义', () => {
    assert.equal(canonicalizePayload('中文🙂'), '"中文🙂"')
    assert.equal(canonicalizePayload('\u0001\u001f'), '"\\u0001\\u001f"')
    assert.equal(canonicalizePayload('a"b\\c\nd\t'), '"a\\"b\\\\c\\nd\\t"')
  })

  it('孤立代理对 → BadShape(不做「尽力编码」)', () => {
    expectCode(() => canonicalizePayload('\uD800'), 'BadShape')
    expectCode(() => canonicalizePayload('\uDC00x'), 'BadShape')
    // 合法代理对不受影响
    assert.equal(canonicalizePayload('🙂'), '"🙂"')
  })

  it('undefined 属性省略(= 可选字段缺席);数组内 undefined → BadShape', () => {
    const withUndef = { a: 1, b: undefined } as unknown as JsonValue
    assert.equal(canonicalizePayload(withUndef), '{"a":1}')
    expectCode(() => canonicalizePayload([1, undefined] as unknown as JsonValue), 'BadShape')
  })

  it('非纯数据对象(Date/Map)→ BadShape', () => {
    expectCode(() => canonicalizePayload(new Date() as unknown as JsonValue), 'BadShape')
    expectCode(() => canonicalizePayload(new Map() as unknown as JsonValue), 'BadShape')
  })

  it('嵌套 payload:重排 descriptor 内部键不改变签名字节', () => {
    const p1 = makePayload()
    const p2 = JSON.parse(
      JSON.stringify({
        expiresAt: p1.expiresAt,
        issuedAt: p1.issuedAt,
        executionDescriptor: {
          supportsVision: true,
          contextWindow: 400_000,
          codexDefaultEffort: 'xhigh',
          supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          capabilitySchemaVersion: 1,
          capabilityProfile: { nested: { b: [true, null], a: 1 }, tools: ['bash', 'web'] },
        },
        securityEpoch: p1.securityEpoch,
        executionRevision: p1.executionRevision,
        engine: p1.engine,
        canonicalModel: p1.canonicalModel,
        connectionChallenge: p1.connectionChallenge,
        authorityTurnId: p1.authorityTurnId,
        containerId: p1.containerId,
        uid: p1.uid,
        keyId: p1.keyId,
        v: p1.v,
      }),
    ) as JsonValue
    assert.equal(canonicalizePayload(p1 as unknown as JsonValue), canonicalizePayload(p2))
  })
})

// --- 签名 / 验签 --------------------------------------------------------------

describe('verifyAuthority', () => {
  it('往返:签发 → 验签 → 载荷逐字段还原', () => {
    const p = makePayload()
    const got = verifyAuthority(signAuthorityEnvelope(p), keyring, NOW + 1000)
    assert.deepEqual(got, p)
  })

  it('可选字段 billingRequestId 缺席/存在都能往返', () => {
    const withId = makePayload({ billingRequestId: 'req_123' })
    assert.equal(
      verifyAuthority(signAuthorityEnvelope(withId), keyring, NOW).billingRequestId,
      'req_123',
    )
    assert.equal(
      verifyAuthority(signAuthorityEnvelope(makePayload()), keyring, NOW).billingRequestId,
      undefined,
    )
  })

  it('伪造签名 → VerifyFail', () => {
    const p = makePayload()
    const env = forgeEnvelope(
      'model_authority',
      p as unknown as JsonValue,
      Buffer.alloc(64).toString('base64url'),
    )
    expectCode(() => verifyAuthority(env, keyring, NOW), 'VerifyFail')
  })

  it('篡改任一字段(model / epoch / descriptor / uid)→ VerifyFail', () => {
    const p = makePayload()
    const envelope = signAuthorityEnvelope(p)
    const decoded = JSON.parse(Buffer.from(envelope, 'base64url').toString('utf8')) as {
      payload: Record<string, unknown>
      sig: string
    }
    const tampers: Record<string, unknown>[] = [
      { ...decoded.payload, canonicalModel: 'gpt-5.6-terra' },
      { ...decoded.payload, securityEpoch: 1 },
      { ...decoded.payload, uid: 43 },
      { ...decoded.payload, containerId: 8 },
      {
        ...decoded.payload,
        executionDescriptor: {
          ...(decoded.payload.executionDescriptor as Record<string, unknown>),
          contextWindow: 2_000_000,
        },
      },
      { ...decoded.payload, expiresAt: NOW + 86_400_000 },
    ]
    for (const t of tampers) {
      expectCode(
        () =>
          verifyAuthority(
            forgeEnvelope('model_authority', t as JsonValue, decoded.sig),
            keyring,
            NOW,
          ),
        'VerifyFail',
      )
    }
  })

  it('过期 → Expired(边界:expiresAt == now 即算过期)', () => {
    const p = makePayload()
    const env = signAuthorityEnvelope(p)
    assert.ok(verifyAuthority(env, keyring, p.expiresAt - 1))
    expectCode(() => verifyAuthority(env, keyring, p.expiresAt), 'Expired')
    expectCode(() => verifyAuthority(env, keyring, p.expiresAt + 1), 'Expired')
  })

  it('未知 keyId → UnknownKey(验签之前先查 ring)', () => {
    const p = makePayload({ keyId: 'mak1_not_in_ring' })
    expectCode(() => verifyAuthority(signAuthorityEnvelope(p), keyring, NOW), 'UnknownKey')
  })

  it('签名有效但已过期时报 Expired;签名无效时恒报 VerifyFail(不泄漏时效语义)', () => {
    const p = makePayload()
    const bad = forgeEnvelope(
      'model_authority',
      { ...(p as unknown as Record<string, unknown>) } as JsonValue,
      Buffer.alloc(64).toString('base64url'),
    )
    expectCode(() => verifyAuthority(bad, keyring, p.expiresAt + 999_999), 'VerifyFail')
  })

  it('结构非法 → BadShape:非 base64/非 JSON/版本不符/缺字段/多余字段/错 kind', () => {
    expectCode(() => verifyAuthority('', keyring, NOW), 'BadShape')
    expectCode(() => verifyAuthority('!!!not-base64!!!', keyring, NOW), 'BadShape')
    const p = makePayload()
    const sig = Buffer.alloc(64).toString('base64url')
    // 版本不符
    expectCode(
      () =>
        verifyAuthority(
          Buffer.from(
            JSON.stringify({ v: 2, kind: 'model_authority', payload: p, sig }),
            'utf8',
          ).toString('base64url'),
          keyring,
          NOW,
        ),
      'BadShape',
    )
    // 缺字段
    const { canonicalModel: _drop, ...missing } = p as unknown as Record<string, unknown>
    expectCode(
      () =>
        verifyAuthority(forgeEnvelope('model_authority', missing as JsonValue, sig), keyring, NOW),
      'BadShape',
    )
    // 多余字段(未知字段不得被携带 —— 否则它绕过全部校验)
    expectCode(
      () =>
        verifyAuthority(
          forgeEnvelope(
            'model_authority',
            { ...(p as unknown as Record<string, unknown>), evil: 1 } as JsonValue,
            sig,
          ),
          keyring,
          NOW,
        ),
      'BadShape',
    )
    // 未知 engine
    expectCode(
      () =>
        verifyAuthority(
          forgeEnvelope(
            'model_authority',
            { ...(p as unknown as Record<string, unknown>), engine: 'evil' } as JsonValue,
            sig,
          ),
          keyring,
          NOW,
        ),
      'BadShape',
    )
    // sig 长度不对
    expectCode(
      () =>
        verifyAuthority(
          forgeEnvelope('model_authority', p as unknown as JsonValue, 'AAAA'),
          keyring,
          NOW,
        ),
      'BadShape',
    )
  })

  it('域分离:authority envelope 不能当 turn lease 用(反之亦然)', () => {
    const authEnv = signAuthorityEnvelope(makePayload())
    expectCode(() => verifyTurnLease(authEnv, keyring, NOW), 'BadShape')
    const leaseEnv = signLeaseEnvelope(makeLease())
    expectCode(() => verifyAuthority(leaseEnv, keyring, NOW), 'BadShape')
  })

  it('域分离(签名层):把 lease 的签名字节挪去当 authority 签名 → VerifyFail', () => {
    // 构造一个与 lease 字段集完全一致、但被当作 authority 提交的载荷是不可能的
    // (字段集不同 → BadShape),这里验证更底层的性质:同一 JCS 字节在两个域下签名不同。
    const lease = makeLease()
    const leaseSig = cryptoSign(null, turnLeaseSigningInput(lease), privateKey)
    const authSigOverSameJcs = cryptoSign(
      null,
      authoritySigningInput(lease as unknown as ModelAuthorityPayload),
      privateKey,
    )
    assert.notEqual(leaseSig.toString('base64url'), authSigOverSameJcs.toString('base64url'))
  })
})

describe('verifyTurnLease + assertLeaseMatchesAuthority', () => {
  it('往返 + 与 authority 绑定一致 → 通过', () => {
    const p = makePayload()
    const l = makeLease()
    const lease = verifyTurnLease(signLeaseEnvelope(l), keyring, NOW + 10 * 60_000)
    assert.deepEqual(lease, l)
    assert.doesNotThrow(() => assertLeaseMatchesAuthority(lease, p))
  })

  it('lease 比 authority 长命:authority 过期后 lease 仍有效(长 turn 不误伤)', () => {
    const p = makePayload()
    const l = makeLease()
    const t = NOW + 6 * 60_000 // 6 分钟:authority(2min TTL)已过期
    expectCode(() => verifyAuthority(signAuthorityEnvelope(p), keyring, t), 'Expired')
    assert.ok(verifyTurnLease(signLeaseEnvelope(l), keyring, t))
  })

  it('绑定字段任一不一致 → LeaseMismatch', () => {
    const p = makePayload()
    const cases: Partial<TurnLease>[] = [
      { uid: 43 },
      { containerId: 8 },
      { authorityTurnId: 'ff'.repeat(16) },
      { canonicalModel: 'gpt-5.6-luna' },
      { securityEpoch: 13 },
      { connectionChallenge: 'chal-2' },
    ]
    for (const over of cases) {
      const lease = verifyTurnLease(signLeaseEnvelope(makeLease(over)), keyring, NOW)
      expectCode(() => assertLeaseMatchesAuthority(lease, p), 'LeaseMismatch')
    }
  })

  it('keyId 不参与对账(轮换期两张票可由不同 key 签发)', () => {
    const p = makePayload()
    const lease = makeLease({ keyId: 'mak1_other_key' })
    assert.doesNotThrow(() => assertLeaseMatchesAuthority(lease, p))
  })
})

// --- keyring env + strip -------------------------------------------------------

describe('keyring env 编解码', () => {
  it('encode → parse 往返,解析出的 ring 能验签', () => {
    const env = encodeAuthorityKeyring(keyring)
    assert.match(env, /^mak1_testkey00000001:[A-Za-z0-9_-]{43}$/)
    const parsed = parseAuthorityKeyring(env)
    assert.equal(parsed.size, 1)
    assert.ok(verifyAuthority(signAuthorityEnvelope(makePayload()), parsed, NOW))
  })

  it('多 keyId 并存(轮换期)—— 顺序无语义', () => {
    const ring = new Map<string, Uint8Array>([
      ['mak1_aaaa', new Uint8Array(publicRaw)],
      [KEY_ID, new Uint8Array(publicRaw)],
    ])
    const parsed = parseAuthorityKeyring(encodeAuthorityKeyring(ring))
    assert.deepEqual([...parsed.keys()].sort(), ['mak1_aaaa', KEY_ID].sort())
  })

  it('空/缺席 env → 空 ring(验签必然 UnknownKey,fail-closed)', () => {
    assert.equal(parseAuthorityKeyring(undefined).size, 0)
    assert.equal(parseAuthorityKeyring('').size, 0)
    expectCode(
      () => verifyAuthority(signAuthorityEnvelope(makePayload()), parseAuthorityKeyring(''), NOW),
      'UnknownKey',
    )
  })

  it('畸形项 / 公钥长度不对 → BadShape(不做部分解析)', () => {
    expectCode(() => parseAuthorityKeyring('nosep'), 'BadShape')
    expectCode(() => parseAuthorityKeyring('k1:QUJD'), 'BadShape') // 3 字节公钥
  })
})

// --- auxModels(次级模型放行集,BLOCKER 2026-07-12)-------------------------------

describe('auxModels —— 次级模型放行集', () => {
  it('进签名载荷:篡改 auxModels(加/删/换)→ VerifyFail(容器改不了放行集)', () => {
    const p = makePayload({ auxModels: ['deepseek-v4-flash'] })
    const envelope = signAuthorityEnvelope(p)
    assert.deepEqual(verifyAuthority(envelope, keyring, NOW).auxModels, ['deepseek-v4-flash'])

    const decoded = JSON.parse(Buffer.from(envelope, 'base64url').toString('utf8')) as {
      payload: Record<string, unknown>
      sig: string
    }
    const tampers: Record<string, unknown>[] = [
      // 提权:往放行集里塞一个更贵的模型
      { ...decoded.payload, auxModels: ['deepseek-v4-flash', 'glm-5.2'] },
      // 换成别的模型
      { ...decoded.payload, auxModels: ['gpt-5.6-sol'] },
      // 清空
      { ...decoded.payload, auxModels: [] },
      // 整个字段抹掉(缺席 = 空集,但签名字节变了)
      (() => {
        const { auxModels: _drop, ...rest } = decoded.payload
        return rest
      })(),
    ]
    for (const t of tampers) {
      expectCode(
        () =>
          verifyAuthority(
            forgeEnvelope('model_authority', t as JsonValue, decoded.sig),
            keyring,
            NOW,
          ),
        'VerifyFail',
      )
    }
  })

  it('缺席 = 空集(老签发方不放宽任何东西,fail-closed)', () => {
    const p = makePayload()
    assert.equal(p.auxModels, undefined)
    const verified = verifyAuthority(signAuthorityEnvelope(p), keyring, NOW)
    assert.equal(verified.auxModels, undefined)
    assert.equal(isModelAllowedByAuthority(verified, verified.canonicalModel), true)
    assert.equal(isModelAllowedByAuthority(verified, 'deepseek-v4-flash'), false)
  })

  it('放行集判定 = {canonicalModel} ∪ auxModels,集合外一律 false', () => {
    const p = makePayload({ canonicalModel: 'glm-5.2', auxModels: ['deepseek-v4-flash'] })
    assert.equal(isModelAllowedByAuthority(p, 'glm-5.2'), true)
    assert.equal(isModelAllowedByAuthority(p, 'deepseek-v4-flash'), true)
    assert.equal(isModelAllowedByAuthority(p, 'deepseek-v4-pro'), false)
    assert.equal(isModelAllowedByAuthority(p, 'gpt-5.6-sol'), false)
    assert.equal(isModelAllowedByAuthority(p, ''), false)
  })

  it('形状门:非数组 / 含空串 / 含重复 → BadShape(畸形载荷不喂进集合判定)', () => {
    const sig = Buffer.alloc(64).toString('base64url')
    const bad: unknown[] = [
      'deepseek-v4-flash', // 不是数组
      [''], // 空串
      ['deepseek-v4-flash', 'deepseek-v4-flash'], // 重复
      [1], // 非字符串
    ]
    for (const v of bad) {
      const payload = { ...(makePayload() as unknown as Record<string, unknown>), auxModels: v }
      expectCode(
        () => verifyAuthority(forgeEnvelope('model_authority', payload as JsonValue, sig), keyring, NOW),
        'BadShape',
      )
    }
  })

  it('lease 同样带 auxModels;turn 内后续请求只带 lease 时放行集不丢', () => {
    const l = makeLease({ auxModels: ['deepseek-v4-flash'] })
    const verified = verifyTurnLease(signLeaseEnvelope(l), keyring, NOW)
    assert.deepEqual(verified.auxModels, ['deepseek-v4-flash'])
    assert.equal(isModelAllowedByAuthority(verified, 'deepseek-v4-flash'), true)
  })

  it('lease 与 authority 的 auxModels 不一致 → LeaseMismatch(跨 turn 拿宽 lease 提权)', () => {
    const authority = makePayload({ auxModels: ['deepseek-v4-flash'] })
    // 宽 lease:多带一个主模型级别的贵模型
    expectCode(
      () =>
        assertLeaseMatchesAuthority(
          makeLease({ auxModels: ['deepseek-v4-flash', 'glm-5.2'] }),
          authority,
        ),
      'LeaseMismatch',
    )
    // 窄 lease / 缺席也算漂移(两张票必须是同一次签发)
    expectCode(() => assertLeaseMatchesAuthority(makeLease({ auxModels: [] }), authority), 'LeaseMismatch')
    expectCode(() => assertLeaseMatchesAuthority(makeLease(), authority), 'LeaseMismatch')
    // 顺序不同不算漂移(签发器已排序,但对账按集合)
    assert.doesNotThrow(() =>
      assertLeaseMatchesAuthority(
        makeLease({ auxModels: ['deepseek-v4-flash'] }),
        makePayload({ auxModels: ['deepseek-v4-flash'] }),
      ),
    )
  })
})

describe('stripModelAuthorityField', () => {
  it('无条件删除同名字段(客户端自带的必须先死)', () => {
    const msg: Record<string, unknown> = { text: 'hi', [MODEL_AUTHORITY_FIELD]: { authority: 'x' } }
    stripModelAuthorityField(msg)
    assert.equal(MODEL_AUTHORITY_FIELD in msg, false)
    assert.equal(msg.text, 'hi')
    assert.doesNotThrow(() => stripModelAuthorityField(null))
    assert.doesNotThrow(() => stripModelAuthorityField(undefined))
  })
})
