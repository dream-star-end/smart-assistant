/**
 * master 侧签发器测试 —— 铸票 / keyring 持久化 / 轮换五步(R3-M7)/ turn lease(R4-M1)。
 *
 * 验签一侧刻意**只用 protocol 的公开 verify API + 公钥 ring**(容器能拿到的全部信息),
 * 即「签发方与验证方在测试里被真正拆开」:任何私钥泄进 verify 路径的实现都会被这里发现。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
  keyringFingerprint,
  parseAuthorityKeyring,
  verifyAuthority,
  verifyTurnLease,
} from '@openclaude/protocol'
import {
  containerPreviewTargetHash,
  verifyContainerPreviewAssertion,
} from '@openclaude/protocol/containerPreviewAuth'

import { AuthorityKeyringReader, type AuthorityMintInput, AuthoritySigner } from '../ws/authoritySigner.js'

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

function publicKeysPath(privatePath: string): string {
  return `${privatePath}.public`
}

function fullCoverage(keyId: string) {
  return { keyId, total: 2, covering: 2, missing: [], fullyCovered: true }
}

describe('AuthoritySigner 铸票 + 验签(签发/验证两侧拆开)', () => {
  test('container preview assertion uses the same public ring but a domain-separated short TTL', () => {
    const signer = AuthoritySigner.createEphemeral()
    const targetHash = containerPreviewTargetHash('http://localhost:3000/', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      isMobile: false,
    })
    const signed = signer.signContainerPreviewAssertion({
      uid: 1001,
      containerId: 55,
      sessionId: 'a'.repeat(32),
      targetHash,
    }, { now: NOW, ttlMs: 10_000 })
    const verified = verifyContainerPreviewAssertion(signed.envelope, signer.publicKeyring(), NOW + 1_000)
    assert.equal(verified.uid, 1001)
    assert.equal(verified.containerId, 55)
    assert.equal(verified.targetHash, targetHash)
    assert.equal(verified.expiresAt, NOW + 10_000)
    assert.throws(() => verifyContainerPreviewAssertion(signed.envelope, signer.publicKeyring(), NOW + 10_001))
  })

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
    let clock = NOW
    const signer = AuthoritySigner.createEphemeral(() => clock)
    const oldKeyId = signer.activeKeyId

    // 旧钥签的票(轮换前发出的,在跑 turn 还握着它)
    const oldMinted = signer.signBundle(mintInput(), { now: NOW })
    assert.equal(oldMinted.payload.keyId, oldKeyId)

    // 步①:加新钥,**不**切签发 —— 公钥先下发到全部容器
    const newKeyId = signer.addKey()
    assert.notEqual(newKeyId, oldKeyId)
    assert.equal(signer.activeKeyId, oldKeyId, '步①不得改变签发钥')

    // 步②:容器此时的 ring 含新旧两把 —— 旧签名照常验通
    const ringBoth = parseAuthorityKeyring(signer.publicKeyringEnv())
    assert.equal(ringBoth.size, 2)
    assert.ok(verifyAuthority(oldMinted.bundle.authority, ringBoth, NOW))

    // 步③:切签发私钥
    signer.activateKeyAfterCensus(newKeyId, fullCoverage(newKeyId), () => {})
    const newMinted = signer.signBundle(mintInput(), { now: NOW })
    assert.equal(newMinted.payload.keyId, newKeyId)

    // 并存期:新旧签名**都**验得通(这是轮换不中断的关键)
    assert.ok(verifyAuthority(oldMinted.bundle.authority, ringBoth, NOW))
    assert.ok(verifyAuthority(newMinted.bundle.authority, ringBoth, NOW))

    // 步④→⑤:旧签名 TTL 耗尽后移除旧公钥 → 旧签名此后 UnknownKey
    const removals: unknown[] = []
    clock = NOW + TURN_LEASE_TTL_MS - 1
    assert.throws(
      () => signer.removeKey(oldKeyId, { audit: () => {} }),
      /turn lease TTL has not elapsed/,
    )
    clock = NOW + TURN_LEASE_TTL_MS
    signer.removeKey(oldKeyId, {
      audit: (entry) => removals.push(entry),
    })
    assert.equal(removals.length, 1)
    const ringNewOnly = parseAuthorityKeyring(signer.publicKeyringEnv())
    assert.equal(ringNewOnly.size, 1)
    assert.throws(
      () => verifyAuthority(oldMinted.bundle.authority, ringNewOnly, NOW),
      (e: unknown) => e instanceof ModelAuthorityError && e.code === 'UnknownKey',
    )
    assert.ok(verifyAuthority(newMinted.bundle.authority, ringNewOnly, NOW))
  })

  test('轮换审计 fail-closed：audit 抛错时 activation/removal 均不落盘', () => {
    let clock = NOW
    const signer = AuthoritySigner.createEphemeral(() => clock)
    const oldKeyId = signer.activeKeyId
    const newKeyId = signer.addKey()
    assert.throws(
      () => signer.activateKeyAfterCensus(newKeyId, fullCoverage(newKeyId), () => {
        throw new Error('audit unavailable')
      }),
      /audit unavailable/,
    )
    assert.equal(signer.activeKeyId, oldKeyId, '审计失败不得切签发钥')

    signer.activateKeyAfterCensus(newKeyId, fullCoverage(newKeyId), () => {})
    clock += TURN_LEASE_TTL_MS
    assert.throws(
      () => signer.removeKey(oldKeyId, { audit: () => {
        throw new Error('audit unavailable')
      } }),
      /audit unavailable/,
    )
    assert.ok(signer.keyIds.includes(oldKeyId), '审计失败不得删除仍需验旧 lease 的公钥')
  })

  test('护栏:移除 active 钥 / 切到未知 keyId → 抛(顺序颠倒 = 全站验签失败)', () => {
    const signer = AuthoritySigner.loadOrCreate(keysPath('guard'), () => {})
    assert.throws(
      () => signer.removeKey(signer.activeKeyId, { audit: () => {} }),
      /refusing to remove active/,
    )
    assert.throws(
      () => signer.activateKeyAfterCensus('mak1_nope', fullCoverage('mak1_nope'), () => {}),
      /unknown keyId/,
    )
    assert.throws(
      () => signer.removeKey('mak1_nope', { audit: () => {} }),
      /unknown keyId/,
    )
  })

  test('切签发钥必须有非空且全覆盖的 census,成功时写 rotation audit', () => {
    const signer = AuthoritySigner.loadOrCreate(keysPath('rotation-gate'), () => {})
    const newKeyId = signer.addKey()
    assert.throws(
      () => signer.activateKeyAfterCensus(
        newKeyId,
        { keyId: newKeyId, total: 0, covering: 0, missing: [], fullyCovered: true },
        () => {},
      ),
      /non-empty census/,
    )
    assert.throws(
      () => signer.activateKeyAfterCensus(
        newKeyId,
        {
          keyId: newKeyId,
          total: 2,
          covering: 1,
          missing: [{ uid: 1, containerId: 2, keyIdsUnknown: false }],
          fullyCovered: false,
        },
        () => {},
      ),
      /not fully covered/,
    )
    const audit: Array<Record<string, unknown>> = []
    signer.activateKeyAfterCensus(newKeyId, fullCoverage(newKeyId), (entry) => audit.push(entry))
    assert.equal(signer.activeKeyId, newKeyId)
    assert.equal(audit.length, 1)
    assert.equal(audit[0]?.newKeyId, newKeyId)
    assert.equal(audit[0]?.censusTotal, 2)
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
    const newKeyId = s1.addKey()
    s1.activateKeyAfterCensus(newKeyId, fullCoverage(newKeyId), () => {})

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
    const publicRaw = readFileSync(publicKeysPath(path), 'utf8')
    assert.equal(publicRaw.includes('privatePkcs8B64'), false, '公钥文件不得含私钥字段')
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
    // 热重载(MAJOR-3 ③)的连带保证:**已经加载过的 signer 实例也不许继续用内存里的旧钥**。
    // 文件是唯一权威源 —— 磁盘上的 ring 被改坏之后,这个进程再签出来的票没人能验
    // (公钥已经不是那把了),继续签 = 制造一批必然 UnknownKey 的帧。fail-closed 抛。
    assert.throws(() => good.activeKeyId, /keyId\/publicKey mismatch/)

    const orphan = keysPath('orphan')
    AuthoritySigner.loadOrCreate(orphan, () => {})
    const o = JSON.parse(readFileSync(orphan, 'utf8')) as { activeKeyId: string }
    o.activeKeyId = 'mak1_0000000000000000'
    writeFileSync(orphan, JSON.stringify(o))
    assert.throws(() => AuthoritySigner.loadOrCreate(orphan, () => {}), /activeKeyId not in ring/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// keyring 生命周期(代码审 R1 MAJOR-3)
// ─────────────────────────────────────────────────────────────────────────────

/** 在**独立进程**里跑一次 loadOrCreate,回传它看到的 activeKeyId(真并发,不是模拟)。 */
function spawnLoadOrCreate(path: string): Promise<string> {
  const mod = new URL('../ws/authoritySigner.ts', import.meta.url).pathname
  const script = `
    const m = await import(${JSON.stringify(mod)});
    const s = m.AuthoritySigner.loadOrCreate(${JSON.stringify(path)}, () => {});
    process.stdout.write(s.activeKeyId);
  `
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${err.message}\n${stderr}`))
        else resolve(stdout.trim())
      },
    )
  })
}

describe('keyring 首启并发(MAJOR-3 ①:多进程同时起,只能有一把钥匙)', () => {
  test('6 个进程同时 loadOrCreate 同一路径 → 全部收敛到同一 keyId,无 tmp/lock 残留', async () => {
    const path = keysPath('concurrent-init')
    // 真起 6 个 node 进程同时抢首启。旧实现(existsSync → 固定 .tmp → rename)在这里
    // 会产生**双钥**:后到的 rename 静默覆盖先到的 —— master 用 B 签、egress 只认 A,
    // 全站 UnknownKey。link() 抢名 = 输的一方丢弃自己的钥匙,物理上不可能出现两把。
    const keyIds = await Promise.all(Array.from({ length: 6 }, () => spawnLoadOrCreate(path)))
    const unique = new Set(keyIds)
    assert.equal(unique.size, 1, `并发首启产生了多把钥匙:${[...unique].join(', ')}`)

    // 落盘的那把 = 大家都认的那把;且能正常签/验(不是半写文件)
    const signer = AuthoritySigner.loadOrCreate(path, () => {})
    assert.equal(signer.activeKeyId, [...unique][0])
    const minted = signer.signBundle(mintInput(), { now: NOW })
    assert.ok(verifyAuthority(minted.bundle.authority, signer.publicKeyring(), NOW))

    // tmp / lock 残留 = 下次启动读到半成品 or 锁死。必须为零。
    const residue = readdirSync(tmpRoot).filter(
      (f) => f.startsWith('concurrent-init.json.') && f !== 'concurrent-init.json.public',
    )
    assert.deepEqual(residue, [], `tmp/lock 残留:${residue.join(', ')}`)
  })

  test('并发 addKey(多进程 read-modify-write)不丢钥:两把新钥都在 ring 里', async () => {
    const path = keysPath('concurrent-addkey')
    const base = AuthoritySigner.loadOrCreate(path, () => {})
    const baseKeyId = base.activeKeyId

    const mod = new URL('../ws/authoritySigner.ts', import.meta.url).pathname
    const addKeyInChild = (): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            `const m = await import(${JSON.stringify(mod)});
             const s = m.AuthoritySigner.loadOrCreate(${JSON.stringify(path)}, () => {});
             process.stdout.write(s.addKey());`,
          ],
          { timeout: 60_000 },
          (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout.trim())),
        )
      })

    const [k1, k2] = await Promise.all([addKeyInChild(), addKeyInChild()])
    assert.notEqual(k1, k2)
    // 无锁的 read-modify-write 在这里会丢掉先写的那把(整份覆盖)→ ring 只剩 2 把。
    const reloaded = AuthoritySigner.loadOrCreate(path, () => {})
    assert.deepEqual(reloaded.keyIds.sort(), [baseKeyId, k1, k2].sort())
    assert.equal(reloaded.activeKeyId, baseKeyId, 'addKey 默认不切签发钥')
  })
})

describe('AuthorityKeyringReader —— 只读公钥 + 热重载(MAJOR-3 ②③)', () => {
  test('reader **不创建**文件:缺失 → 空 ring(验签方 fail-closed,而不是自己铸一把钥)', () => {
    const path = keysPath('reader-missing')
    const reader = AuthorityKeyringReader.open(publicKeysPath(path), () => {})
    assert.equal(reader.keyring().size, 0)
    assert.equal(existsSync(path), false, 'reader 绝不能创建 keyring 文件(egress 铸钥 = 双钥源)')
  })

  test('master 加新钥 → reader **无需重启**就认得(轮换窗口 egress 不瞎)', () => {
    const path = keysPath('reader-hot')
    const signer = AuthoritySigner.loadOrCreate(path, () => {})
    const reader = AuthorityKeyringReader.open(publicKeysPath(path), () => {})
    assert.deepEqual(reader.keyIds(), [signer.activeKeyId])

    const newKeyId = signer.addKey()
    signer.activateKeyAfterCensus(newKeyId, fullCoverage(newKeyId), () => {})
    // 整改前:reader 拿的是常驻 signer 的**内存** → 这里仍是旧 ring,新签名 UnknownKey。
    assert.equal(reader.keyIds().includes(newKeyId), true, '文件变了,reader 必须重读')

    const minted = signer.signBundle(mintInput(), { now: NOW })
    assert.equal(minted.payload.keyId, newKeyId)
    assert.ok(verifyAuthority(minted.bundle.authority, reader.keyring(), NOW), '新签名要能被热重载后的 ring 验通')
  })

  test('整份换 ring(轮换/灾备恢复)→ 下次验签用新 ring,旧签名 UnknownKey', () => {
    const path = keysPath('reader-swap')
    const signerA = AuthoritySigner.loadOrCreate(path, () => {})
    const reader = AuthorityKeyringReader.open(publicKeysPath(path), () => {})
    const mintedA = signerA.signBundle(mintInput(), { now: NOW })
    assert.ok(verifyAuthority(mintedA.bundle.authority, reader.keyring(), NOW))

    // 另起一份完全不同的 ring,原子换上去(= 生产里的 rename 落盘)。
    // B 的票必须在换盘**之前**铸好:换完之后 B 自己的文件已经不在原路径上,
    // signer 是文件权威的 —— 它会 fail-closed 抛,这正是我们要的(不留内存旁路)。
    const other = keysPath('reader-swap-other')
    const signerB = AuthoritySigner.loadOrCreate(other, () => {})
    const keyIdB = signerB.activeKeyId
    const mintedB = signerB.signBundle(mintInput(), { now: NOW })
    renameSync(publicKeysPath(other), publicKeysPath(path))

    const ringNow = reader.keyring()
    assert.deepEqual(reader.keyIds(), [keyIdB], 'reader 必须看见换上去的新 ring')
    assert.throws(
      () => verifyAuthority(mintedA.bundle.authority, ringNow, NOW),
      (e: unknown) => e instanceof ModelAuthorityError && e.code === 'UnknownKey',
    )
    assert.ok(verifyAuthority(mintedB.bundle.authority, ringNow, NOW))
  })

  test('reader 与 signer 的指纹/keyIds 同源(census 对账的前提)', () => {
    const path = keysPath('reader-fp')
    const signer = AuthoritySigner.loadOrCreate(path, () => {})
    const reader = AuthorityKeyringReader.open(publicKeysPath(path), () => {})
    signer.addKey()
    assert.equal(reader.fingerprint(), signer.fingerprint())
    assert.deepEqual(reader.keyIds(), [...signer.keyIds].sort())
    // 容器侧从 env 解析出的 ring 也必须算出同一个指纹(protocol 单一实现)
    assert.equal(keyringFingerprint(parseAuthorityKeyring(reader.publicKeyringEnv())), signer.fingerprint())
  })
})
