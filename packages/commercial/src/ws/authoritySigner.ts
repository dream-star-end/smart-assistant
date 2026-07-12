/**
 * authoritySigner —— master 侧**模型执行权威签发器**(Ed25519 私钥独占方)。
 *
 * 方案:docs/V5_MODEL_AUTHORITY_PLAN.md §2(判定单点化)。信任根是**非对称**的:
 *
 *   master(本文件,持私钥) --签名 envelope--> bridge 注入 inbound --> 容器 gateway(只有公钥)验签
 *
 * 为什么非对称而不是共享密钥(如复用 bridgeSecret 做 HMAC):容器内跑的是**用户的 AI**,
 * 与容器 gateway 同 uid —— 共享密钥必然要注入容器 env,用户侧进程读 /proc/self/environ
 * 就能自签一份「我可以用最贵的模型 / epoch 拉回旧值」的权威。公钥注入则无此问题
 * (R3-M5 同款理由:裸 header 也可伪造,故 CCB proxy 请求必须带完整签名 envelope)。
 *
 * 本文件只负责**铸票**:
 *   - 私钥/keyring 持久化与轮换(R3-M7 五步);
 *   - signAuthority / signTurnLease / signBundle(两张票据的签发);
 *   - mintAuthorityTurnId(每 inbound 现铸的重放标识);
 *   - publicKeyringEnv():supervisor 注入容器的公钥 env 值(切片3 消费)。
 *
 * **不负责**:载荷字段的业务取值(catalog 快照投影,由调用方 bridge 组装)、epoch fence
 * (签发前的 fence 断言在调用方)、重放拒绝(容器侧 AuthorityReplayGuard)。
 *
 * ---------------------------------------------------------------------------
 * replay 防护契约(R3-M10)—— 实现体在容器 gateway 侧,签发侧在此登记语义,便于
 * 「铸票方」与「验票方」在同一份文档下对账。接口 = protocol `AuthorityReplayGuard`:
 *   1. **单次消费**:同 authorityTurnId 在活跃 TTL 内第二次出现 → 拒帧;
 *   2. **活跃条目绝不静默淘汰**:未过期条目不得因容量压力被 LRU 踢出(踢出 = 重放窗口);
 *      容量满且全为活跃条目 → 拒新 authority + critical 告警(宁可拒服务不放过重放);
 *   3. **绑连接**:cache key 含 connectionChallenge —— 连接关闭/gateway 重启后旧 envelope
 *      天然失效,无需跨进程共享 cache;
 *   4. 过期条目可安全清理(verify 的 Expired 门已挡住它们)。
 * 签发侧对应保证:authorityTurnId 每 inbound 现铸(128 bit 随机,不复用计费 requestId),
 * authority TTL 短(AUTHORITY_TTL_MS),故 gateway 的活跃窗口有界。
 * ---------------------------------------------------------------------------
 *
 * **私钥落盘取证结论**(实现期核对):与 bridge secret **同域**——
 *   - bridgeSecret:`/var/lib/openclaude/.v3-bridge-secret`,systemd `StateDirectory=openclaude`
 *     保证 root:root 0700 目录,文件 0600(见 bridgeSecret.ts 文件头);
 *   - 本 keyring:同目录 `.v5-model-authority-keys`(JSON,0600),复用 bridgeSecret 的
 *     `checkDirIntegrity`(symlink/非目录 → throw;mode/owner 异常 → warn)。
 *   同域 = 同一威胁模型:本机 root 被攻破时两者一起失守,不额外造第二套密钥保管机制。
 *   **差异**:bridgeSecret 文件损坏时**重新生成**(HMAC nonce 可随容器重建自愈);本 keyring
 *   损坏时 **fail-closed 抛错**——静默换私钥会让所有在跑容器的注入公钥集体失效
 *   (UnknownKey 全站拒帧),必须由运维显式处置。
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  randomBytes,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  AUTHORITY_TTL_MS,
  type AuthorityKeyring,
  MODEL_AUTHORITY_KEYRING_ENV,
  MODEL_AUTHORITY_VERSION,
  type ModelAuthorityBundle,
  type ModelAuthorityEngine,
  type ModelAuthorityPayload,
  type ModelExecutionDescriptor,
  TURN_LEASE_TTL_MS,
  type TurnLease,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeAuthorityKeyring,
  encodeTurnLeaseEnvelope,
  turnLeaseSigningInput,
} from '@openclaude/protocol'

import { checkDirIntegrity } from '../bridgeSecret.js'

/** keyring 落盘路径 —— 与 bridge secret 同域(systemd StateDirectory=openclaude)。 */
export const DEFAULT_MODEL_AUTHORITY_KEYS_PATH = '/var/lib/openclaude/.v5-model-authority-keys'

/** keyId 前缀:`mak1_`(model authority key v1)+ sha256(pubRaw) 前 8 字节 hex。 */
const KEY_ID_PREFIX = 'mak1_'

interface StoredKey {
  keyId: string
  /** PKCS#8 DER(base64)—— Node KeyObject 可直接 createPrivateKey。 */
  privatePkcs8B64: string
  /** Ed25519 raw 32B 公钥(base64url)—— 注入容器的就是这个。 */
  publicRawB64u: string
  createdAt: number
}

interface KeyringFile {
  v: number
  activeKeyId: string
  keys: StoredKey[]
}

/** 签发 authority 所需的业务字段(v/keyId/issuedAt/expiresAt 由签发器补齐)。 */
export interface AuthorityMintInput {
  uid: number
  containerId: number
  /** 不传 → 现铸(每 inbound 一枚)。传入仅用于测试/重签同一 turn 的 lease。 */
  authorityTurnId?: string
  /** gateway 在 hello attestation 里给出的连接级 challenge(R4-m4)。 */
  connectionChallenge: string
  canonicalModel: string
  engine: ModelAuthorityEngine
  executionDescriptor: ModelExecutionDescriptor
  executionRevision: string
  securityEpoch: number
  /**
   * 该 turn 允许的**次级模型**(容器里 CCB 的 WebFetch/WebSearch 等隐藏调用会打它们;
   * 权威源 = billing/modelCatalog.ts `platformAuxModels(snapshot)`,见该函数的取证注释)。
   *
   * **必填**(哪怕空数组):签发方必须对"这个 turn 除主模型外还能打什么"给出显式答案。
   * 做成可选 = 某条 forward 路径忘了传就悄悄退化成"只放行主模型",WebFetch 在那条路径上
   * 无声挂掉 —— 正是本字段要根治的故障形状,不能在签发侧留同一个坑。
   * 空数组是合法答案(codex turn 不用 ANTHROPIC_SMALL_FAST_MODEL)。
   */
  auxModels: readonly string[]
  /** codex 的 server-owned 计费 requestId(绑定字段,可缺席)。 */
  billingRequestId?: string
}

export interface MintOptions {
  /** 测试注入;生产恒 Date.now()。 */
  now?: number
  /** authority 有效期(默认 AUTHORITY_TTL_MS,只约束「开始执行」)。 */
  authorityTtlMs?: number
  /**
   * lease 有效期(默认 TURN_LEASE_TTL_MS = 45min hard timeout + 5min grace)。
   * **耦合**:若运维抬高 OPENCLAUDE_DELEGATE_HARD_TIMEOUT_MS,必须同步抬高此值,
   * 否则长 turn 的后续上游请求会被 lease 过期误伤(R4-M1 要消除的正是这类误伤)。
   */
  leaseTtlMs?: number
}

export interface MintedAuthority {
  payload: ModelAuthorityPayload
  lease: TurnLease
  /** 注入 inbound `__oc_model_authority` 的值。 */
  bundle: ModelAuthorityBundle
}

/**
 * master 独占的 Ed25519 签发器 + keyring(多 keyId 并存,支持 R3-M7 轮换五步)。
 *
 * 轮换五步与本类的映射:
 *   ① 下发新公钥(旧钥保留) → `addKey({ activate: false })` + supervisor 重注入 env
 *   ② 全容器 attest 新 keyId → 运维核验(容器 hello 广播 keyring 指纹)
 *   ③ master 切新私钥       → `setActiveKey(newKeyId)`
 *   ④ 等旧签名 TTL 耗尽      → 等待 ≥ TURN_LEASE_TTL_MS(lease 是最长命的票据)
 *   ⑤ 删旧公钥              → `removeKey(oldKeyId)` + supervisor 重注入 env
 * 任一步顺序颠倒(尤其 ③ 早于 ①)= 在跑容器验不了新签名 → 全站 UnknownKey 拒帧。
 */
export class AuthoritySigner {
  private file: KeyringFile
  private readonly path: string | null
  private readonly privateKeyCache = new Map<string, KeyObject>()

  private constructor(file: KeyringFile, path: string | null) {
    this.file = file
    this.path = path
  }

  /** 生产入口:加载(或首启生成)落盘 keyring。文件损坏 → 抛(fail-closed,见文件头)。 */
  static loadOrCreate(
    path: string = DEFAULT_MODEL_AUTHORITY_KEYS_PATH,
    log: (msg: string) => void = (m) => console.warn(m),
  ): AuthoritySigner {
    const dir = dirname(path)
    checkDirIntegrity(dir, log)

    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8')
      const file = parseKeyringFile(raw, path)
      return new AuthoritySigner(file, path)
    }

    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const first = generateStoredKey()
    const file: KeyringFile = { v: 1, activeKeyId: first.keyId, keys: [first] }
    const signer = new AuthoritySigner(file, path)
    signer.persist()
    log(`[model-authority] keyring initialized path=${path} activeKeyId=${first.keyId}`)
    return signer
  }

  /** 测试/内存态入口(不落盘)。 */
  static createEphemeral(): AuthoritySigner {
    const first = generateStoredKey()
    return new AuthoritySigner({ v: 1, activeKeyId: first.keyId, keys: [first] }, null)
  }

  get activeKeyId(): string {
    return this.file.activeKeyId
  }

  get keyIds(): string[] {
    return this.file.keys.map((k) => k.keyId)
  }

  /** 公钥 keyring(keyId → raw32)—— verifyAuthority / verifyTurnLease 的入参形状。 */
  publicKeyring(): AuthorityKeyring {
    const map = new Map<string, Uint8Array>()
    for (const k of this.file.keys) {
      map.set(k.keyId, new Uint8Array(Buffer.from(k.publicRawB64u, 'base64url')))
    }
    return map
  }

  /**
   * supervisor 注入容器的 env 值(切片3 消费):
   *   env.push(`${MODEL_AUTHORITY_KEYRING_ENV}=${signer.publicKeyringEnv()}`)
   * 值格式 `keyId:pubRawBase64url,...`(protocol encodeAuthorityKeyring 单一权威)。
   * 公钥公开无妨 —— 容器同 uid 进程读得到也伪造不出签名。
   */
  publicKeyringEnv(): string {
    return encodeAuthorityKeyring(this.publicKeyring())
  }

  /** 便利形态:直接给 supervisor 的 `NAME=VALUE`(env 名收口在 protocol 常量)。 */
  publicKeyringEnvAssignment(): string {
    return `${MODEL_AUTHORITY_KEYRING_ENV}=${this.publicKeyringEnv()}`
  }

  /**
   * 每条 forward 的 inbound 现铸一枚(128 bit CSPRNG)。
   *
   * **不复用计费 requestId**(方案 §2 明令):requestId 在 CCB 路径是可选的、且语义是
   * 「一次上游请求」;authorityTurnId 的语义是「一次被授权的执行」,是容器侧 replay cache
   * 的 key —— 两者混用会让「同 turn 多次上游请求」被误判成重放。
   */
  mintAuthorityTurnId(): string {
    return randomBytes(16).toString('hex')
  }

  /**
   * 铸两张票:authority(短 TTL,开始执行)+ turn lease(长 TTL,turn 内续跑)。
   * 二者绑定同一 uid/containerId/authorityTurnId/canonicalModel/securityEpoch/
   * connectionChallenge —— 消费侧 assertLeaseMatchesAuthority 会逐字段对账(R4-M1)。
   */
  signBundle(input: AuthorityMintInput, opts: MintOptions = {}): MintedAuthority {
    const now = opts.now ?? Date.now()
    const keyId = this.activeKeyId
    const authorityTurnId = input.authorityTurnId ?? this.mintAuthorityTurnId()
    // 归一在签发器里做(不在调用方):两张票必须拿到**逐字节相同**的数组,
    // 否则 assertLeaseMatchesAuthority 的集合对账虽仍能过,wire 字节却因顺序不同而分叉,
    // 日志/对账逐字节比对失去意义。主模型从 aux 里剔除 —— 它天然在放行集合里(§isModelAllowedByAuthority),
    // 重复列出只是把同一事实写两遍。
    const auxModels = normalizeAuxModels(input.auxModels, input.canonicalModel)

    const payload: ModelAuthorityPayload = {
      v: MODEL_AUTHORITY_VERSION,
      keyId,
      uid: input.uid,
      containerId: input.containerId,
      authorityTurnId,
      connectionChallenge: input.connectionChallenge,
      canonicalModel: input.canonicalModel,
      engine: input.engine,
      executionDescriptor: input.executionDescriptor,
      executionRevision: input.executionRevision,
      securityEpoch: input.securityEpoch,
      issuedAt: now,
      expiresAt: now + (opts.authorityTtlMs ?? AUTHORITY_TTL_MS),
      auxModels,
      ...(input.billingRequestId === undefined ? {} : { billingRequestId: input.billingRequestId }),
    }

    const lease: TurnLease = {
      v: MODEL_AUTHORITY_VERSION,
      keyId,
      uid: input.uid,
      containerId: input.containerId,
      authorityTurnId,
      canonicalModel: input.canonicalModel,
      auxModels,
      securityEpoch: input.securityEpoch,
      connectionChallenge: input.connectionChallenge,
      issuedAt: now,
      expiresAt: now + (opts.leaseTtlMs ?? TURN_LEASE_TTL_MS),
    }

    return {
      payload,
      lease,
      bundle: {
        authority: this.signAuthority(payload),
        lease: this.signTurnLease(lease),
      },
    }
  }

  /** 对已组装好的 payload 签名 → envelope(base64url)。payload.keyId 必须在 ring 内。 */
  signAuthority(payload: ModelAuthorityPayload): string {
    const sig = cryptoSign(null, authoritySigningInput(payload), this.privateKey(payload.keyId))
    return encodeAuthorityEnvelope(payload, sig)
  }

  signTurnLease(lease: TurnLease): string {
    const sig = cryptoSign(null, turnLeaseSigningInput(lease), this.privateKey(lease.keyId))
    return encodeTurnLeaseEnvelope(lease, sig)
  }

  // --- 轮换五步(R3-M7)-----------------------------------------------------

  /** 步①:加一把新钥进 ring(默认**不**切签发,先让公钥下发到全部容器)。 */
  addKey(opts: { activate?: boolean } = {}): string {
    const key = generateStoredKey()
    this.file = { ...this.file, keys: [...this.file.keys, key] }
    if (opts.activate) this.file = { ...this.file, activeKeyId: key.keyId }
    this.persist()
    return key.keyId
  }

  /** 步③:切签发私钥(前提 = 该 keyId 的公钥已下发到全部在跑容器)。 */
  setActiveKey(keyId: string): void {
    if (!this.file.keys.some((k) => k.keyId === keyId)) {
      throw new Error(`[model-authority] setActiveKey: unknown keyId ${keyId}`)
    }
    this.file = { ...this.file, activeKeyId: keyId }
    this.persist()
  }

  /**
   * 步⑤:移除旧公钥(此后该 keyId 的旧签名 → UnknownKey)。
   * 前提 = 已过 ④「旧签名 TTL 耗尽」(最长命票据 = turn lease)。禁止移除 active 钥。
   */
  removeKey(keyId: string): void {
    if (keyId === this.file.activeKeyId) {
      throw new Error(`[model-authority] removeKey: refusing to remove active keyId ${keyId}`)
    }
    if (!this.file.keys.some((k) => k.keyId === keyId)) {
      throw new Error(`[model-authority] removeKey: unknown keyId ${keyId}`)
    }
    this.file = { ...this.file, keys: this.file.keys.filter((k) => k.keyId !== keyId) }
    this.privateKeyCache.delete(keyId)
    this.persist()
  }

  // --- 内部 ---------------------------------------------------------------

  private privateKey(keyId: string): KeyObject {
    const cached = this.privateKeyCache.get(keyId)
    if (cached) return cached
    const stored = this.file.keys.find((k) => k.keyId === keyId)
    if (!stored) throw new Error(`[model-authority] sign: unknown keyId ${keyId}`)
    const key = createPrivateKey({
      key: Buffer.from(stored.privatePkcs8B64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
    this.privateKeyCache.set(keyId, key)
    return key
  }

  /** 原子落盘(tmp + rename):半写文件 = 下次启动 fail-closed,不可接受。 */
  private persist(): void {
    if (this.path === null) return // ephemeral(测试)
    const tmp = `${this.path}.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify(this.file, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch (e) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* best-effort cleanup */
      }
      throw e
    }
  }
}

/**
 * 去重 + 排序 + 剔除主模型 —— 两张票共用同一个数组实例的规范形态。
 * 空串会被 protocol 的形状门拒(BadShape),这里提前挡住,免得签出一张必然验不过的票。
 */
function normalizeAuxModels(aux: readonly string[], canonicalModel: string): string[] {
  const out = new Set<string>()
  for (const m of aux) {
    if (typeof m !== 'string' || m === '') {
      throw new Error(`[model-authority] auxModels contains an empty/non-string model id`)
    }
    if (m === canonicalModel) continue
    out.add(m)
  }
  return [...out].sort()
}

function generateStoredKey(): StoredKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privatePkcs8B64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string }
  if (typeof jwk.x !== 'string') {
    throw new Error('[model-authority] generateKeyPair: missing ed25519 public key material')
  }
  return {
    keyId: deriveKeyId(Buffer.from(jwk.x, 'base64url')),
    privatePkcs8B64,
    publicRawB64u: jwk.x,
    createdAt: Date.now(),
  }
}

/**
 * keyId = `mak1_` + sha256(pubRaw)[0..8) hex —— **由公钥派生**,不是随机串。
 * 好处:keyId 与公钥绑定,ring 里不可能出现「同 keyId 不同公钥」的错配(轮换期错配 =
 * 验签随机失败,是最难查的一类事故)。
 */
function deriveKeyId(publicRaw: Buffer): string {
  return KEY_ID_PREFIX + createHash('sha256').update(publicRaw).digest('hex').slice(0, 16)
}

/** 落盘文件解析:任何异常 → 抛(fail-closed;绝不静默重生成私钥,见文件头)。 */
function parseKeyringFile(raw: string, path: string): KeyringFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`[model-authority] keyring file is not valid JSON: ${path}`)
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`[model-authority] keyring file is not an object: ${path}`)
  }
  const file = parsed as Partial<KeyringFile>
  if (file.v !== 1 || typeof file.activeKeyId !== 'string' || !Array.isArray(file.keys)) {
    throw new Error(`[model-authority] keyring file shape invalid: ${path}`)
  }
  for (const k of file.keys) {
    if (
      typeof k?.keyId !== 'string' ||
      typeof k?.privatePkcs8B64 !== 'string' ||
      typeof k?.publicRawB64u !== 'string'
    ) {
      throw new Error(`[model-authority] keyring entry shape invalid: ${path}`)
    }
    // keyId 必须与公钥一致 —— 手工编辑过的 ring 不许上线。
    const expected = deriveKeyId(Buffer.from(k.publicRawB64u, 'base64url'))
    if (expected !== k.keyId) {
      throw new Error(
        `[model-authority] keyring entry keyId/publicKey mismatch (${k.keyId} != ${expected}): ${path}`,
      )
    }
    // 私钥与公钥同源校验(防手工拼接的 ring 让签名恒验不过)。
    const pub = createPublicKey(
      createPrivateKey({
        key: Buffer.from(k.privatePkcs8B64, 'base64'),
        format: 'der',
        type: 'pkcs8',
      }),
    ).export({ format: 'jwk' }) as { x?: string }
    if (pub.x !== k.publicRawB64u) {
      throw new Error(`[model-authority] keyring entry private/public key mismatch: ${k.keyId}`)
    }
  }
  if (!file.keys.some((k) => k.keyId === file.activeKeyId)) {
    throw new Error(`[model-authority] keyring activeKeyId not in ring: ${path}`)
  }
  return { v: 1, activeKeyId: file.activeKeyId, keys: file.keys as StoredKey[] }
}
