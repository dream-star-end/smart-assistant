/**
 * master 侧签发器测试 —— 铸票 / keyring 持久化 / 轮换五步(R3-M7)/ turn lease(R4-M1)。
 *
 * 验签一侧刻意**只用 protocol 的公开 verify API + 公钥 ring**(容器能拿到的全部信息),
 * 即「签发方与验证方在测试里被真正拆开」:任何私钥泄进 verify 路径的实现都会被这里发现。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import {
  AUTHORITY_TTL_MS,
  MODEL_AUTHORITY_KEYRING_ENV,
  ModelAuthorityError,
  type ModelExecutionDescriptor,
  TURN_LEASE_TTL_MS,
  assertLeaseMatchesAuthority,
  isModelAllowedByAuthority,
  parseAuthorityKeyring,
  verifyAuthority,
  verifyTurnLease,
} from '@openclaude/protocol'

import { type AuthorityMintInput, AuthoritySigner } from '../ws/authoritySigner.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'oc-model-authority-'))
after(() => rmSync(tmpRoot, { recursive: true, force: true }))

const NOW = 1_760_000_000_000

const DESCRIPTOR: ModelExecutionDescriptor = {
  capabilityProfile: { tools: ['bash'], maxOutputTokens: 64_000 },
  capabilitySchemaVersion: 1,
  contextWindow: 200_000,
  supportedEfforts: ['low', 'medium', 'high'],
  supportsVision: false,
}

function mintInput(over: Partial<AuthorityMintInput> = {}): AuthorityMintInput {
  return {
    uid: 1001,
    containerId: 55,
    connectionChallenge: 'conn-challenge-abc',
    canonicalModel: 'glm-5.2',
    engine: 'ccb',
    executionDescriptor: DESCRIPTOR,
    executionRevision: 'b'.repeat(64),
    securityEpoch: 9,
    auxModels: ['deepseek-v4-flash'],
    ...over,
  }
}

function keysPath(name: string): string {
  return join(tmpRoot, `${name}.json`)
}

describe('AuthoritySigner 铸票 + 验签(签发/验证两侧拆开)', () => {
  test('signBundle → 容器只用公钥 ring 就能验通 authority + lease,并对账绑定字段', () => {
    const signer = AuthoritySigner.createEphemeral()
    const minted = signer.signBundle(mintInput(), { now: NOW })

    // 容器侧:从 env 值解析 ring(与 supervisor 注入的形状完全一致)
    const ring = parseAuthorityKeyring(signer.publicKeyringEnv())

    const authority = verifyAuthority(minted.bundle.authority, ring, NOW + 1_000)
    const lease = verifyTurnLease(minted.bundle.lease, ring, NOW + 1_000)

    assert.deepEqual(authority, minted.payload)
    assert.deepEqual(lease, minted.lease)
    assert.doesNotThrow(() => assertLeaseMatchesAuthority(lease, authority))

    assert.equal(authority.keyId, signer.activeKeyId)
    assert.equal(authority.engine, 'ccb')
    assert.equal(authority.executionDescriptor.contextWindow, 200_000)
    assert.equal(authority.expiresAt, NOW + AUTHORITY_TTL_MS)
    assert.equal(lease.expiresAt, NOW + TURN_LEASE_TTL_MS)
  })

  test('长 turn(>5min,跨多次上游请求):authority 过期而 lease 仍有效', () => {
    const signer = AuthoritySigner.createEphemeral()
    const ring = signer.publicKeyring()
    const minted = signer.signBundle(mintInput(), { now: NOW })

    // 6 分钟后的第二次上游请求:authority(短 TTL)已死 —— 这正是 R4-M1 要拆票据的原因
    const t6min = NOW + 6 * 60_000
    assert.throws(
      () => verifyAuthority(minted.bundle.authority, ring, t6min),
      (e: unknown) => e instanceof ModelAuthorityError && e.code === 'Expired',
    )
    assert.ok(verifyTurnLease(minted.bundle.lease, ring, t6min))

    // 40 分钟(接近 45min hard timeout)仍在 lease 有效期内
    assert.ok(verifyTurnLease(minted.bundle.lease, ring, NOW + 40 * 60_000))
    // 超过 45min + 5min grace 才过期
    assert.throws(
      () => verifyTurnLease(minted.bundle.lease, ring, NOW + TURN_LEASE_TTL_MS + 1),
      (e: unknown) => e instanceof ModelAuthorityError && e.code === 'Expired',
    )
  })

  test('auxModels 同时进两张票且逐字节同形(turn 中段只带 lease 时放行集不丢)', () => {
    const signer = AuthoritySigner.createEphemeral()
    const ring = signer.publicKeyring()
    const minted = signer.signBundle(mintInput({ auxModels: ['deepseek-v4-flash'] }), { now: NOW })

    const authority = verifyAuthority(minted.bundle.authority, ring, NOW + 1_000)
    const lease = verifyTurnLease(minted.bundle.lease, ring, NOW + 1_000)
    assert.deepEqual(authority.auxModels, ['deepseek-v4-flash'])
    assert.deepEqual(lease.auxModels, ['deepseek-v4-flash'])
    assert.doesNotThrow(() => assertLeaseMatchesAuthority(lease, authority))
    // 放行集 = 主模型 ∪ aux
    assert.equal(isModelAllowedByAuthority(lease, 'glm-5.2'), true)
    assert.equal(isModelAllowedByAuthority(lease, 'deepseek-v4-flash'), true)
    assert.equal(isModelAllowedByAuthority(lease, 'deepseek-v4-pro'), false)
  })

  test('归一在签发器里做:去重 + 排序 + 剔除主模型(wire 字节确定化)', () => {
    const signer = AuthoritySigner.createEphemeral()
    const minted = signer.signBundle(
      mintInput({
        canonicalModel: 'glm-5.2',
        // 乱序 + 重复 + 混入主模型自身
        auxModels: ['zzz-model', 'deepseek-v4-flash', 'deepseek-v4-flash', 'glm-5.2', 'aaa-model'],
      }),
      { now: NOW },
    )
    assert.deepEqual(minted.payload.auxModels, ['aaa-model', 'deepseek-v4-flash', 'zzz-model'])
    assert.deepEqual(minted.lease.auxModels, minted.payload.auxModels)
  })

  test('空 auxModels(codex turn)→ 空集,只放行主模型', () => {
    const signer = AuthoritySigner.createEphemeral()
    const minted = signer.signBundle(mintInput({ engine: 'codex', auxModels: [] }), { now: NOW })
    assert.deepEqual(minted.payload.auxModels, [])
    assert.equal(isModelAllowedByAuthority(minted.payload, 'deepseek-v4-flash'), false)
    assert.equal(isModelAllowedByAuthority(minted.payload, 'glm-5.2'), true)
  })

  test('billingRequestId(codex 绑定字段)进签名载荷', () => {
    const signer = AuthoritySigner.createEphemeral()
    const minted = signer.signBundle(
      mintInput({ engine: 'codex', canonicalModel: 'gpt-5.6-sol', billingRequestId: 'req_x1' }),
      { now: NOW },
    )
    const got = verifyAuthority(minted.bundle.authority, signer.publicKeyring(), NOW)
    assert.equal(got.billingRequestId, 'req_x1')
  })

  test('authorityTurnId 每次现铸(不复用计费 requestId 语义),128bit hex', () => {
    const signer = AuthoritySigner.createEphemeral()
    const ids = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const id = signer.mintAuthorityTurnId()
      assert.match(id, /^[0-9a-f]{32}$/)
      ids.add(id)
    }
    assert.equal(ids.size, 200)

    // 两次 signBundle 同输入 → 不同 authorityTurnId(replay cache 的 key 必须唯一)
    const a = signer.signBundle(mintInput(), { now: NOW })
    const b = signer.signBundle(mintInput(), { now: NOW })
    assert.notEqual(a.payload.authorityTurnId, b.payload.authorityTurnId)
    // 同一 bundle 的两张票据共享同一 turnId(对账的前提)
    assert.equal(a.payload.authorityTurnId, a.lease.authorityTurnId)
  })

  test('supervisor 注入形状:NAME=VALUE,env 名收口在 protocol 常量', () => {
    const signer = AuthoritySigner.createEphemeral()
    const assignment = signer.publicKeyringEnvAssignment()
    assert.ok(assignment.startsWith(`${MODEL_AUTHORITY_KEYRING_ENV}=`))
    const value = assignment.slice(MODEL_AUTHORITY_KEYRING_ENV.length + 1)
    const ring = parseAuthorityKeyring(value)
    assert.equal(ring.size, 1)
    assert.ok(ring.has(signer.activeKeyId))
    // 公钥 32B raw —— 私钥材料绝不出现在 env 里
    assert.equal(ring.get(signer.activeKeyId)?.length, 32)
    assert.equal(value.includes('PRIVATE'), false)
  })
})

describe('keyring 轮换五步(R3-M7)', () => {
  test('①新公钥入 ring(不切签发)→ ③切签发 → 新旧签名并存都验通 → ⑤删旧钥后旧签名拒', () => {
    const signer = AuthoritySigner.loadOrCreate(keysPath('rotate'), () => {})
    const oldKeyId = signer.activeKeyId

    // 旧钥签的票(轮换前发出的,在跑 turn 还握着它)
    const oldMinted = signer.signBundle(mintInput(), { now: NOW })
    assert.equal(oldMinted.payload.keyId, oldKeyId)

    // 步①:加新钥,**不**切签发 —— 公钥先下发到全部容器
    const newKeyId = signer.addKey({ activate: false })
    assert.notEqual(newKeyId, oldKeyId)
    assert.equal(signer.activeKeyId, oldKeyId, '步①不得改变签发钥')

    // 步②:容器此时的 ring 含新旧两把 —— 旧签名照常验通
    const ringBoth = parseAuthorityKeyring(signer.publicKeyringEnv())
    assert.equal(ringBoth.size, 2)
    assert.ok(verifyAuthority(oldMinted.bundle.authority, ringBoth, NOW))

    // 步③:切签发私钥
    signer.setActiveKey(newKeyId)
    const newMinted = signer.signBundle(mintInput(), { now: NOW })
    assert.equal(newMinted.payload.keyId, newKeyId)

    // 并存期:新旧签名**都**验得通(这是轮换不中断的关键)
    assert.ok(verifyAuthority(oldMinted.bundle.authority, ringBoth, NOW))
    assert.ok(verifyAuthority(newMinted.bundle.authority, ringBoth, NOW))

    // 步④→⑤:旧签名 TTL 耗尽后移除旧公钥 → 旧签名此后 UnknownKey
    signer.removeKey(oldKeyId)
    const ringNewOnly = parseAuthorityKeyring(signer.publicKeyringEnv())
    assert.equal(ringNewOnly.size, 1)
    assert.throws(
      () => verifyAuthority(oldMinted.bundle.authority, ringNewOnly, NOW),
      (e: unknown) => e instanceof ModelAuthorityError && e.code === 'UnknownKey',
    )
    assert.ok(verifyAuthority(newMinted.bundle.authority, ringNewOnly, NOW))
  })

  test('护栏:移除 active 钥 / 切到未知 keyId → 抛(顺序颠倒 = 全站验签失败)', () => {
    const signer = AuthoritySigner.loadOrCreate(keysPath('guard'), () => {})
    assert.throws(() => signer.removeKey(signer.activeKeyId), /refusing to remove active/)
    assert.throws(() => signer.setActiveKey('mak1_nope'), /unknown keyId/)
    assert.throws(() => signer.removeKey('mak1_nope'), /unknown keyId/)
  })
})

describe('keyring 持久化(与 bridge secret 同域)', () => {
  test('首启生成 → 重载同 keyId;重载后签的票用**原公钥 ring**验得通', () => {
    const path = keysPath('persist')
    const first = AuthoritySigner.loadOrCreate(path, () => {})
    const ringFromFirst = first.publicKeyring()

    const reloaded = AuthoritySigner.loadOrCreate(path, () => {})
    assert.equal(reloaded.activeKeyId, first.activeKeyId)
    assert.deepEqual(reloaded.keyIds, first.keyIds)

    const minted = reloaded.signBundle(mintInput(), { now: NOW })
    // 用「第一次加载导出的 ring」验 —— 私钥确实原样持久化(不是每次重启换钥)
    assert.ok(verifyAuthority(minted.bundle.authority, ringFromFirst, NOW))
  })

  test('轮换后的 ring 落盘且可重载(多 keyId 并存跨重启)', () => {
    const path = keysPath('persist-rotate')
    const s1 = AuthoritySigner.loadOrCreate(path, () => {})
    const oldKeyId = s1.activeKeyId
    const newKeyId = s1.addKey({ activate: true })

    const s2 = AuthoritySigner.loadOrCreate(path, () => {})
    assert.equal(s2.activeKeyId, newKeyId)
    assert.deepEqual(s2.keyIds.sort(), [oldKeyId, newKeyId].sort())
  })

  test('文件落盘 0600 且内容是 JSON keyring(私钥不裸奔在别处)', () => {
    const path = keysPath('mode')
    AuthoritySigner.loadOrCreate(path, () => {})
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { v: number; keys: unknown[] }
    assert.equal(parsed.v, 1)
    assert.equal(parsed.keys.length, 1)
  })

  test('**fail-closed**:文件损坏 / keyId 与公钥错配 / active 不在 ring → 抛,绝不静默换钥', () => {
    const corrupt = keysPath('corrupt')
    writeFileSync(corrupt, '{not json')
    assert.throws(() => AuthoritySigner.loadOrCreate(corrupt, () => {}), /not valid JSON/)

    const shape = keysPath('shape')
    writeFileSync(shape, JSON.stringify({ v: 1, activeKeyId: 'x' }))
    assert.throws(() => AuthoritySigner.loadOrCreate(shape, () => {}), /shape invalid/)

    // 手工把 keyId 改掉(伪装成别的 key)→ 必须被 keyId==sha256(pub) 一致性校验挡住
    const tampered = keysPath('tampered')
    const good = AuthoritySigner.loadOrCreate(tampered, () => {})
    const raw = JSON.parse(readFileSync(tampered, 'utf8')) as {
      activeKeyId: string
      keys: { keyId: string }[]
    }
    raw.keys[0].keyId = 'mak1_deadbeefdeadbeef'
    raw.activeKeyId = 'mak1_deadbeefdeadbeef'
    writeFileSync(tampered, JSON.stringify(raw))
    assert.throws(
      () => AuthoritySigner.loadOrCreate(tampered, () => {}),
      /keyId\/publicKey mismatch/,
    )
    assert.ok(good.activeKeyId)

    const orphan = keysPath('orphan')
    AuthoritySigner.loadOrCreate(orphan, () => {})
    const o = JSON.parse(readFileSync(orphan, 'utf8')) as { activeKeyId: string }
    o.activeKeyId = 'mak1_0000000000000000'
    writeFileSync(orphan, JSON.stringify(o))
    assert.throws(() => AuthoritySigner.loadOrCreate(orphan, () => {}), /activeKeyId not in ring/)
  })
})
