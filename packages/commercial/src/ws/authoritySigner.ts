/**
 * authoritySigner —— 模型执行权威的 **keyring 生命周期**(落盘 / 初始化 / 轮换 / 热重载)
 * 与 master 侧 **Ed25519 签发器**(私钥独占方)。
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
 * ---------------------------------------------------------------------------
 * **三个角色,一个权威源(落盘文件)**(代码审 R1 MAJOR-3 整改)
 *
 *   KeyringStore           —— 落盘文件的唯一读写体:O_EXCL 首启、原子写、文件锁下的
 *                             read-modify-write、stat(ino+mtime+size)驱动的**热重载**。
 *   AuthorityKeyringReader —— **只读公钥**(egress / 非 split 拓扑的 proxy / env 注入)。
 *                             **不持私钥、不创建文件**:验签方多起一个进程不该有能力铸钥。
 *   AuthoritySigner        —— master 独占:签发 + 轮换五步的写操作(内部同样经 KeyringStore)。
 *
 * 整改前的三个洞(全部由上面的分工消掉):
 *   ① `existsSync → generate → 固定 .tmp → rename` 的首启:master 与 egress 并发起
 *      → 两把钥匙互相覆盖(rename 会盖掉对方),egress 用 A 验、master 用 B 签 → 全站
 *      UnknownKey。现在:内容先落**唯一 tmp**,再用 `link()`(原子且**不覆盖**)抢占
 *      文件名 —— 输的一方丢弃自己的钥匙去读赢家的,双钥竞态在物理上不可能。
 *   ② egress「每请求现取 keyring」实际只读常驻对象的**内存**,文件换了也不重读 →
 *      轮换窗口里 egress 认不出新签名。现在:reader 每次取 ring 先 stat,签名(ino,
 *      mtime,size)变了就重读 —— 换 ring 无需重启 egress。
 *   ③ 多进程/多次 addKey 的 read-modify-write 丢更新。现在:写操作全在 `${path}.lock`
 *      的文件锁内**重读后再改**,并发加钥不会互相吞掉。
 *
 * 本文件只负责**铸票与钥匙**:
 *   - keyring 持久化 / 初始化 / 轮换(R3-M7 五步);
 *   - signAuthority / signTurnLease / signBundle(两张票据的签发);
 *   - mintAuthorityTurnId(每 inbound 现铸的重放标识);
 *   - publicKeyringEnv():supervisor 注入容器的公钥 env 值。
 *
 * **不负责**:载荷字段的业务取值(catalog 快照投影,由调用方 bridge 组装)、epoch fence
 * (签发前 fence + **签发边界的 epoch 重读**都在调用方 bridge)、重放拒绝(容器侧
 * AuthorityReplayGuard)、轮换步骤② 的覆盖统计(ws/authorityKeyCensus.ts)。
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
  generateKeyPairSync,
  sign as cryptoSign,
  randomBytes,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

import type { AuthorityKeyCoverage } from './authorityKeyCensus.js'

import {
  AUTHORITY_TTL_MS,
  type AuthorityKeyring,
  type DispatchAuthorityPayload,
  MODEL_AUTHORITY_KEYRING_ENV,
  MODEL_AUTHORITY_VERSION,
  type ModelAuthorityBundle,
  type ModelAuthorityEngine,
  type ModelAuthorityPayload,
  type ModelExecutionDescriptor,
  TURN_LEASE_TTL_MS,
  type TurnLease,
  CONTAINER_PREVIEW_PROTOCOL_VERSION,
  authoritySigningInput,
  dispatchAuthoritySigningInput,
  encodeAuthorityEnvelope,
  encodeAuthorityKeyring,
  encodeDispatchAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  keyringFingerprint,
  keyringKeyIds,
  turnLeaseSigningInput,
} from '@openclaude/protocol'
import {
  CONTAINER_PREVIEW_ASSERTION_MAX_TTL_MS,
  type ContainerPreviewBridgeAssertionPayload,
  containerPreviewAssertionSigningInput,
  encodeContainerPreviewAssertion,
} from '@openclaude/protocol/containerPreviewAuth'

import { checkDirIntegrity } from '../bridgeSecret.js'

/** keyring 落盘路径 —— 与 bridge secret 同域(systemd StateDirectory=openclaude)。 */
export const DEFAULT_MODEL_AUTHORITY_KEYS_PATH = '/var/lib/openclaude/.v5-model-authority-keys'
/** 验签进程只允许打开这份公钥投影；绝不解析含 PKCS#8 私钥的 master 文件。 */
export const DEFAULT_MODEL_AUTHORITY_PUBLIC_KEYS_PATH =
  `${DEFAULT_MODEL_AUTHORITY_KEYS_PATH}.public`

/** keyId 前缀:`mak1_`(model authority key v1)+ sha256(pubRaw) 前 8 字节 hex。 */
const KEY_ID_PREFIX = 'mak1_'

/** 写锁获取上限 / stale 锁回收阈值(写 = 轮换,极低频;超时即抛,不静默降级)。 */
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 30_000

interface StoredKey {
  keyId: string
  /** PKCS#8 DER(base64)—— Node KeyObject 可直接 createPrivateKey。 */
  privatePkcs8B64: string
  /** Ed25519 raw 32B 公钥(base64url)—— 注入容器的就是这个。 */
  publicRawB64u: string
  createdAt: number
  /** 该 key 停止签发的持久时间；删除 TTL 由此计算，进程重启不丢。 */
  deactivatedAt?: number
}

interface KeyringFile {
  v: number
  activeKeyId: string
  keys: StoredKey[]
}

interface PublicKeyringFile {
  v: number
  keys: Array<Pick<StoredKey, 'keyId' | 'publicRawB64u' | 'createdAt'>>
}

// ---------------------------------------------------------------------------
// KeyringStore —— 落盘文件的唯一读写体(reader / signer 共用)
// ---------------------------------------------------------------------------

/**
 * 文件态 keyring 的读写单点。
 *
 * **热重载**:`read()` 每次先 `statSync` 取 (ino, mtimeMs, size) 三元组签名,与上次缓存
 * 的签名相同 → 返回缓存(零解析);不同 → 重读 + 重解析。inode 进签名很关键 —— 原子写是
 * `tmp + rename`,新内容必然是**新 inode**,即使同一毫秒内替换也能被发现(只看 mtime
 * 会漏掉亚毫秒替换)。
 *
 * **原子写**:唯一 tmp 名(pid+随机)避免多进程互踩同一个 `.tmp`,再 `rename` 覆盖 ——
 * 读者永远看到完整的旧文件或完整的新文件,没有半写态。
 */
class KeyringStore {
  private cached: KeyringFile | null = null
  private cachedStamp: string | null = null
  /** ephemeral(测试)= 纯内存,不碰文件系统。 */
  private memory: KeyringFile | null = null

  constructor(readonly path: string | null) {}

  static ephemeral(file: KeyringFile): KeyringStore {
    const s = new KeyringStore(null)
    s.memory = file
    return s
  }

  /**
   * 当前 ring。文件不存在:`allowMissing` → null,否则抛(fail-closed)。
   * 文件损坏 → 恒抛(绝不静默重生成私钥,见文件头)。
   */
  read(opts: { allowMissing?: boolean } = {}): KeyringFile | null {
    if (this.path === null) return this.memory
    let stamp: string
    try {
      const st = statSync(this.path)
      stamp = `${st.ino}:${st.mtimeMs}:${st.size}`
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.invalidate()
        if (opts.allowMissing === true) return null
        throw new Error(`[model-authority] keyring file missing: ${this.path}`)
      }
      throw err
    }
    if (this.cached !== null && this.cachedStamp === stamp) return this.cached
    const file = parseKeyringFile(readFileSync(this.path, 'utf8'), this.path)
    this.cached = file
    this.cachedStamp = stamp
    return file
  }

  /** 存在即返回,不存在 → 抛。签发/取公钥路径用它(缺文件不是可降级状态)。 */
  current(): KeyringFile {
    const f = this.read()
    if (f === null) throw new Error(`[model-authority] keyring file missing: ${String(this.path)}`)
    return f
  }

  /**
   * 首启初始化(**无锁但无竞态**):内容先落唯一 tmp,再 `link()` 抢文件名。
   *
   * `link` 是原子的**且遇到已存在的目标会 EEXIST 失败**(rename 则会静默覆盖)——
   * 这正是要的语义:并发首启只有一方能把自己的钥匙变成"那把钥匙",输的一方丢弃自己
   * 刚生成的私钥去读赢家的。旧实现(existsSync → rename)在这里会产生**双钥**:
   * master 签 B、egress 只认 A → 全站 UnknownKey 拒帧。
   */
  initIfMissing(log: (msg: string) => void): KeyringFile {
    if (this.path === null) return this.memory as KeyringFile
    const existing = this.read({ allowMissing: true })
    if (existing !== null) return existing

    const first = generateStoredKey()
    const file: KeyringFile = { v: 1, activeKeyId: first.keyId, keys: [first] }
    const tmp = this.tmpPath()
    writeFileSync(tmp, serializeKeyringFile(file), { mode: 0o600 })
    try {
      linkSync(tmp, this.path)
      log(`[model-authority] keyring initialized path=${this.path} activeKeyId=${first.keyId}`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        safeUnlink(tmp)
        throw err
      }
      // 并发首启:别的进程先建成了 —— 丢弃本进程刚生成的钥匙,用文件里那把。
      log(`[model-authority] keyring already created by a concurrent process: ${this.path}`)
    } finally {
      safeUnlink(tmp)
    }
    this.invalidate()
    return this.current()
  }

  /**
   * 写操作(轮换五步)= **文件锁内 read-modify-write**。
   *
   * 不能"拿内存里的 file 改一改再写回":另一个进程(或本进程更早的实例)刚加的钥匙会被
   * 整份覆盖掉 —— 丢一把在跑容器正在用的公钥 = 那批容器全站验签失败。锁内重读保证
   * mutator 看到的一定是磁盘现状。
   */
  mutate(
    fn: (current: KeyringFile) => KeyringFile,
    afterWrite?: (next: KeyringFile) => void,
    beforeWrite?: (next: KeyringFile) => void,
  ): KeyringFile {
    if (this.path === null) {
      const next = fn(this.memory as KeyringFile)
      beforeWrite?.(next)
      this.memory = next
      afterWrite?.(this.memory)
      return this.memory
    }
    return withKeyringLock(this.path, () => {
      const cur = this.forceRead()
      const next = fn(cur)
      // 审计类 precondition 在持锁状态、持久写之前执行。callback 抛错 → ring 完全不变。
      beforeWrite?.(next)
      this.write(next)
      // 公钥镜像与私钥 RMW 共用同一把锁，避免两个并发 addKey 以旧投影最后写覆盖
      // 新投影。私钥先落、公钥后落是安全顺序：active 仍是旧钥，最多短暂看不到新 staged key。
      afterWrite?.(next)
      return next
    })
  }

  /** 绕过 stat 缓存直读(锁内用:别的进程可能刚写完,别信任何缓存)。 */
  private forceRead(): KeyringFile {
    this.invalidate()
    return this.current()
  }

  private write(file: KeyringFile): void {
    if (this.path === null) {
      this.memory = file
      return
    }
    const tmp = this.tmpPath()
    try {
      writeFileSync(tmp, serializeKeyringFile(file), { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch (e) {
      safeUnlink(tmp)
      throw e
    }
    this.invalidate()
  }

  private invalidate(): void {
    this.cached = null
    this.cachedStamp = null
  }

  /** 唯一 tmp 名:固定 `.tmp` 会让并发写者互相截断对方的半成品。 */
  private tmpPath(): string {
    return `${String(this.path)}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
  }
}

/** 只含公钥的独立落盘投影。egress 的进程内存从物理文件边界上拿不到私钥字段。 */
class PublicKeyringStore {
  private cached: PublicKeyringFile | null = null
  private cachedStamp: string | null = null
  private memory: PublicKeyringFile | null = null

  constructor(readonly path: string | null) {}

  static ephemeral(file: PublicKeyringFile): PublicKeyringStore {
    const store = new PublicKeyringStore(null)
    store.memory = file
    return store
  }

  read(opts: { allowMissing?: boolean } = {}): PublicKeyringFile | null {
    if (this.path === null) return this.memory
    let stamp: string
    try {
      const st = statSync(this.path)
      stamp = `${st.ino}:${st.mtimeMs}:${st.size}`
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cached = null
        this.cachedStamp = null
        if (opts.allowMissing === true) return null
        throw new Error(`[model-authority] public keyring file missing: ${this.path}`)
      }
      throw err
    }
    if (this.cached !== null && this.cachedStamp === stamp) return this.cached
    const parsed = parsePublicKeyringFile(readFileSync(this.path, 'utf8'), this.path)
    this.cached = parsed
    this.cachedStamp = stamp
    return parsed
  }

  write(file: PublicKeyringFile): void {
    if (this.path === null) {
      this.memory = file
      return
    }
    const tmp = `${this.path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch (err) {
      safeUnlink(tmp)
      throw err
    }
    this.cached = null
    this.cachedStamp = null
  }
}

/** 进程间互斥的写锁(O_EXCL 创建 lock 文件;持锁进程崩溃留下的 stale 锁按 mtime 回收)。 */
function withKeyringLock<T>(path: string, fn: () => T): T {
  const lockPath = `${path}.lock`
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx', 0o600))
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      try {
        const st = statSync(lockPath)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) safeUnlink(lockPath)
      } catch {
        /* 锁刚被别人释放 —— 下一轮直接抢到 */
      }
      if (Date.now() >= deadline) {
        throw new Error(`[model-authority] keyring lock busy: ${lockPath}`)
      }
      sleepSync(20)
    }
  }
  try {
    return fn()
  } finally {
    safeUnlink(lockPath)
  }
}

/** 同步 sleep(锁重试用;写操作低频,不值得把整条轮换 API 变成 async)。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function safeUnlink(p: string): void {
  try {
    if (existsSync(p)) unlinkSync(p)
  } catch {
    /* best-effort */
  }
}

function serializeKeyringFile(file: KeyringFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// AuthorityKeyringReader —— 只读公钥(验签方 / env 注入方)
// ---------------------------------------------------------------------------

/**
 * **公钥 keyring 读取器**(无私钥、无铸钥能力)。
 *
 * 谁用它:
 *   - egress(独立进程)`/v1/messages` 的每请求验签 —— 每次取 ring 都 stat 文件,master
 *     轮换换了 ring,egress **无需重启**即认得新 keyId(整改前它读的是常驻 AuthoritySigner
 *     的内存,轮换窗口必然拿旧 ring → 新签名一律 UnknownKey);
 *   - 非 split 拓扑下 master 内部 proxy(同为验签方);
 *   - supervisor 注入容器 env 的公钥串。
 *
 * 为什么不让它们复用 AuthoritySigner:`loadOrCreate` 会**创建**文件 —— 一个只负责验签的
 * 进程有能力铸出一把 master 不知道的私钥,是纯粹的负资产(首启双钥竞态的根因之一)。
 *
 * fail-closed 语义:文件**缺失** → 空 ring(验签方随即 UnknownKey 拒帧,不放行);
 * 文件**损坏** → 抛(与 signer 同语义:密钥材料异常必须由运维显式处置,不静默降级)。
 */
export class AuthorityKeyringReader {
  private readonly store: PublicKeyringStore
  private readonly log: (msg: string) => void
  private warnedMissing = false

  private constructor(store: PublicKeyringStore, log: (msg: string) => void) {
    this.store = store
    this.log = log
  }

  /** 打开(**不创建**)。目录完整性异常 → 抛(与 signer 同域校验)。 */
  static open(
    path: string = DEFAULT_MODEL_AUTHORITY_PUBLIC_KEYS_PATH,
    log: (msg: string) => void = (m) => console.warn(m),
  ): AuthorityKeyringReader {
    checkDirIntegrity(dirname(path), log)
    return new AuthorityKeyringReader(new PublicKeyringStore(path), log)
  }

  /** 内部/测试:复用一个已有 store(signer.reader() 的实现体)。 */
  private static forStore(
    store: PublicKeyringStore,
    log: (msg: string) => void,
  ): AuthorityKeyringReader {
    return new AuthorityKeyringReader(store, log)
  }

  /** @internal signer 用来暴露自己的只读视图(同一 store = 同一份热重载状态)。 */
  static _viewOf(
    store: PublicKeyringStore,
    log: (msg: string) => void = () => {},
  ): AuthorityKeyringReader {
    return AuthorityKeyringReader.forStore(store, log)
  }

  /** 当前公钥 ring(每次调用做一次 stat 热重载检查;未变 = 命中缓存,零解析)。 */
  keyring(): AuthorityKeyring {
    const file = this.store.read({ allowMissing: true })
    if (file === null) {
      if (!this.warnedMissing) {
        this.warnedMissing = true
        this.log('[model-authority] keyring file not present yet — verification is fail-closed')
      }
      return new Map()
    }
    this.warnedMissing = false
    return toAuthorityKeyring(file.keys)
  }

  /** ring 里的 keyId(字典序;census 对账维度,protocol 单一实现)。 */
  keyIds(): string[] {
    return keyringKeyIds(this.keyring())
  }

  /** ring 指纹(容器 attestation 上报同名字段,两侧同源)。 */
  fingerprint(): string {
    return keyringFingerprint(this.keyring())
  }

  publicKeyringEnv(): string {
    return encodeAuthorityKeyring(this.keyring())
  }

  publicKeyringEnvAssignment(): string {
    return `${MODEL_AUTHORITY_KEYRING_ENV}=${this.publicKeyringEnv()}`
  }
}

// ---------------------------------------------------------------------------
// AuthoritySigner —— master 独占(私钥 + 轮换写操作)
// ---------------------------------------------------------------------------

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

export interface ContainerPreviewAssertionInput {
  uid: number
  containerId: number
  sessionId: string
  targetHash: string
}

/**
 * master 独占的 Ed25519 签发器 + keyring(多 keyId 并存,支持 R3-M7 轮换五步)。
 *
 * 轮换五步与本类的映射:
 *   ① 下发新公钥(旧钥保留) → `addKey()`;新 provision 的容器由
 *      supervisor **现取** `publicKeyringEnvAssignment()`(index.ts 传函数而非启动期
 *      快照字符串),在跑容器靠 recycle 换 env;
 *   ② 全容器 attest 新 keyId → `ws/authorityKeyCensus.ts`:容器 hello attestation 上报
 *      自己 ring 的 keyIds/指纹,census 统计覆盖 —— `isFullyCovered(newKeyId)` 为 true
 *      才允许进第③步(**这是 gate,不是目测**);
 *   ③ master 切新私钥       → `activateKeyAfterCensus(newKeyId, coverage, audit)`
 *                              (非空且全覆盖的 census 是不可绕过参数)
 *   ④ 等旧签名 TTL 耗尽      → 等待 ≥ TURN_LEASE_TTL_MS(lease 是最长命的票据)
 *   ⑤ 停签满一个 turn-lease TTL 后删旧公钥
 *                            → `removeKey(oldKeyId,{audit})` + recycle/重注入 env
 * 任一步顺序颠倒(尤其 ③ 早于 ①②)= 在跑容器验不了新签名 → 全站 UnknownKey 拒帧。
 *
 * **热重载**:所有读(activeKeyId / keyIds / publicKeyring / 签名取私钥)都经 KeyringStore
 * 的 stat 检查 —— 运维用另一个进程动了 ring,本进程立刻跟上,不必重启 master。
 */
export class AuthoritySigner {
  private readonly store: KeyringStore
  private readonly publicStore: PublicKeyringStore
  private readonly privateKeyCache = new Map<string, KeyObject>()
  private readonly now: () => number

  private constructor(
    store: KeyringStore,
    publicStore: PublicKeyringStore,
    now: () => number = Date.now,
  ) {
    this.store = store
    this.publicStore = publicStore
    this.now = now
  }

  /** 生产入口:加载(或首启生成)落盘 keyring。文件损坏 → 抛(fail-closed,见文件头)。 */
  static loadOrCreate(
    path: string = DEFAULT_MODEL_AUTHORITY_KEYS_PATH,
    log: (msg: string) => void = (m) => console.warn(m),
  ): AuthoritySigner {
    const dir = dirname(path)
    checkDirIntegrity(dir, log)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const store = new KeyringStore(path)
    const file = store.initIfMissing(log)
    const publicStore = new PublicKeyringStore(`${path}.public`)
    // 每次 master 启动都由经过私钥/公钥一致性校验的私钥 ring 重建公钥投影。
    // 旧版本升级时这一步创建新文件；egress 在此之前只会空 ring fail-closed。
    publicStore.write(toPublicKeyringFile(file))
    return new AuthoritySigner(store, publicStore, Date.now)
  }

  /** 测试/内存态入口(不落盘)。 */
  static createEphemeral(now: () => number = Date.now): AuthoritySigner {
    const first = generateStoredKey()
    const file: KeyringFile = { v: 1, activeKeyId: first.keyId, keys: [first] }
    return new AuthoritySigner(
      KeyringStore.ephemeral(file),
      PublicKeyringStore.ephemeral(toPublicKeyringFile(file)),
      now,
    )
  }

  /** 同一份 keyring 的**只读视图**(要 keyring 的地方一律拿它,别传 signer)。 */
  reader(): AuthorityKeyringReader {
    return AuthorityKeyringReader._viewOf(this.publicStore)
  }

  get activeKeyId(): string {
    return this.store.current().activeKeyId
  }

  get keyIds(): string[] {
    return this.store.current().keys.map((k) => k.keyId)
  }

  /** 公钥 keyring(keyId → raw32)—— verifyAuthority / verifyTurnLease 的入参形状。 */
  publicKeyring(): AuthorityKeyring {
    return toAuthorityKeyring(this.publicStore.read()!.keys)
  }

  /** ring 指纹(轮换 census 的对账串;与容器 attestation 上报值同源)。 */
  fingerprint(): string {
    return keyringFingerprint(this.publicKeyring())
  }

  /**
   * supervisor 注入容器的 env 值:
   *   env.push(`${MODEL_AUTHORITY_KEYRING_ENV}=${signer.publicKeyringEnv()}`)
   * 值格式 `keyId:pubRawBase64url,...`(protocol encodeAuthorityKeyring 单一权威)。
   * 公钥公开无妨 —— 容器同 uid 进程读得到也伪造不出签名。
   *
   * **每次 provision 现取**(supervisor 收的是函数):轮换步骤① 之后新建的容器要立刻
   * 拿到含新公钥的 ring,否则步骤② 的 census 永远收敛不到 100%,轮换卡死。
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

  /**
   * 对已组装好的 dispatch authority payload 签名 → __oc_dispatch envelope(RFC-v5-durable-turn
   * -dispatch §2.2)。与 signAuthority/signTurnLease 同构:私钥独占在 master,容器只有公钥。
   * payload.keyId 必须在 ring 内(dispatchSigner 组装时置 = activeKeyId)。载荷字段的业务取值
   * (uid/dispatchId/payloadHash/…)由调用方 dispatch/dispatchSigner 组装,本类只铸签名。
   */
  signDispatchAuthority(payload: DispatchAuthorityPayload): string {
    const sig = cryptoSign(
      null,
      dispatchAuthoritySigningInput(payload),
      this.privateKey(payload.keyId),
    )
    return encodeDispatchAuthorityEnvelope(payload, sig)
  }

  /**
   * Domain-separated, short-lived master → container preview assertion.
   * The container only has the public keyring, so same-UID user processes
   * cannot mint or alter this capability.
   */
  signContainerPreviewAssertion(
    input: ContainerPreviewAssertionInput,
    opts: { now?: number; ttlMs?: number } = {},
  ): { payload: ContainerPreviewBridgeAssertionPayload; envelope: string } {
    const now = opts.now ?? this.now()
    const ttlMs = opts.ttlMs ?? CONTAINER_PREVIEW_ASSERTION_MAX_TTL_MS
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > CONTAINER_PREVIEW_ASSERTION_MAX_TTL_MS) {
      throw new Error('[container-preview] assertion TTL out of range')
    }
    if (!Number.isSafeInteger(input.uid) || input.uid < 1) {
      throw new Error('[container-preview] invalid uid')
    }
    if (!Number.isSafeInteger(input.containerId) || input.containerId < 1) {
      throw new Error('[container-preview] invalid containerId')
    }
    if (!/^[0-9a-f]{32}$/.test(input.sessionId)) {
      throw new Error('[container-preview] invalid sessionId')
    }
    if (!/^[0-9a-f]{64}$/.test(input.targetHash)) {
      throw new Error('[container-preview] invalid targetHash')
    }
    const payload: ContainerPreviewBridgeAssertionPayload = {
      v: CONTAINER_PREVIEW_PROTOCOL_VERSION,
      keyId: this.activeKeyId,
      uid: input.uid,
      containerId: input.containerId,
      sessionId: input.sessionId,
      targetHash: input.targetHash,
      issuedAt: now,
      expiresAt: now + ttlMs,
    }
    const signature = cryptoSign(
      null,
      containerPreviewAssertionSigningInput(payload),
      this.privateKey(payload.keyId),
    )
    return { payload, envelope: encodeContainerPreviewAssertion(payload, signature) }
  }

  // --- 轮换五步(R3-M7)-----------------------------------------------------

  /** 步①:加一把新钥进 ring(默认**不**切签发,先让公钥下发到全部容器)。 */
  addKey(): string {
    const key = generateStoredKey()
    this.store.mutate(
      (cur) => ({ ...cur, keys: [...cur.keys, key] }),
      (next) => this.publicStore.write(toPublicKeyringFile(next)),
    )
    return key.keyId
  }

  /**
   * 步③:切签发私钥。
   * **前提 = 该 keyId 的公钥已下发到全部在跑容器**(轮换步骤②;gate = census.isFullyCovered)。
   * 切早了 = 在跑容器全部 UnknownKey 拒帧。
   */
  activateKeyAfterCensus(
    keyId: string,
    coverage: AuthorityKeyCoverage,
    audit: (entry: {
      action: 'model_authority.key.activate'
      oldKeyId: string
      newKeyId: string
      censusTotal: number
      censusCovering: number
      activatedAt: number
    }) => void,
  ): void {
    const now = this.now()
    if (!this.store.current().keys.some((key) => key.keyId === keyId)) {
      throw new Error(`[model-authority] activateKeyAfterCensus: unknown keyId ${keyId}`)
    }
    if (coverage.keyId !== keyId) {
      throw new Error(`[model-authority] census keyId mismatch: ${coverage.keyId} != ${keyId}`)
    }
    if (coverage.total <= 0) {
      throw new Error('[model-authority] refusing activation without a non-empty census')
    }
    if (
      !coverage.fullyCovered ||
      coverage.covering !== coverage.total ||
      coverage.missing.length !== 0
    ) {
      throw new Error(
        `[model-authority] key ${keyId} is not fully covered ` +
          `(${coverage.covering}/${coverage.total})`,
      )
    }
    const publicFile = this.publicStore.read()
    if (!publicFile?.keys.some((key) => key.keyId === keyId)) {
      throw new Error(`[model-authority] public projection missing keyId ${keyId}`)
    }
    let oldKeyId = ''
    this.store.mutate(
      (cur) => {
        if (!cur.keys.some((k) => k.keyId === keyId)) {
          throw new Error(`[model-authority] activateKeyAfterCensus: unknown keyId ${keyId}`)
        }
        oldKeyId = cur.activeKeyId
        return {
          ...cur,
          activeKeyId: keyId,
          keys: cur.keys.map((key) =>
            key.keyId === oldKeyId
              ? { ...key, deactivatedAt: now }
              : key.keyId === keyId
                ? { ...key, deactivatedAt: undefined }
                : key,
          ),
        }
      },
      undefined,
      () => audit({
        action: 'model_authority.key.activate',
        oldKeyId,
        newKeyId: keyId,
        censusTotal: coverage.total,
        censusCovering: coverage.covering,
        activatedAt: now,
      }),
    )
  }

  /**
   * 步⑤:移除旧公钥(此后该 keyId 的旧签名 → UnknownKey)。
   * 前提 = 已过 ④「旧签名 TTL 耗尽」(最长命票据 = turn lease)。禁止移除 active 钥。
   */
  removeKey(
    keyId: string,
    opts: {
      audit: (entry: {
        action: 'model_authority.key.remove'
        keyId: string
        deactivatedAt: number
        removedAt: number
      }) => void
    },
  ): void {
    const now = this.now()
    let deactivatedAt = 0
    this.store.mutate(
      (cur) => {
        if (keyId === cur.activeKeyId) {
          throw new Error(`[model-authority] removeKey: refusing to remove active keyId ${keyId}`)
        }
        const key = cur.keys.find((k) => k.keyId === keyId)
        if (!key) {
          throw new Error(`[model-authority] removeKey: unknown keyId ${keyId}`)
        }
        if (key.deactivatedAt === undefined) {
          throw new Error(`[model-authority] removeKey: key ${keyId} has no persisted deactivation time`)
        }
        if (now - key.deactivatedAt < TURN_LEASE_TTL_MS) {
          throw new Error(`[model-authority] removeKey: turn lease TTL has not elapsed for ${keyId}`)
        }
        deactivatedAt = key.deactivatedAt
        return { ...cur, keys: cur.keys.filter((k) => k.keyId !== keyId) }
      },
      (next) => this.publicStore.write(toPublicKeyringFile(next)),
      () => opts.audit({
        action: 'model_authority.key.remove',
        keyId,
        deactivatedAt,
        removedAt: now,
      }),
    )
    this.privateKeyCache.delete(keyId)
  }

  // --- 内部 ---------------------------------------------------------------

  /**
   * 私钥 KeyObject(按 keyId 缓存)。
   *
   * **每次都先在当前落盘 ring 里找这把 keyId**:别的进程把它删了(轮换步骤⑤)之后,本
   * 进程不该还能用缓存里的旧私钥继续签 —— 那会签出全站验不过的票(公钥已从容器 env 撤走)。
   * keyId 由公钥派生,"同 keyId 不同私钥"不可能,故按 keyId 缓存 KeyObject 本身是安全的。
   */
  private privateKey(keyId: string): KeyObject {
    const stored = this.store.current().keys.find((k) => k.keyId === keyId)
    if (!stored) throw new Error(`[model-authority] sign: unknown keyId ${keyId}`)
    const cached = this.privateKeyCache.get(keyId)
    if (cached) return cached
    const key = createPrivateKey({
      key: Buffer.from(stored.privatePkcs8B64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
    this.privateKeyCache.set(keyId, key)
    return key
  }
}

function toAuthorityKeyring(
  keys: ReadonlyArray<Pick<StoredKey, 'keyId' | 'publicRawB64u'>>,
): AuthorityKeyring {
  const map = new Map<string, Uint8Array>()
  for (const k of keys) {
    map.set(k.keyId, new Uint8Array(Buffer.from(k.publicRawB64u, 'base64url')))
  }
  return map
}

function toPublicKeyringFile(file: KeyringFile): PublicKeyringFile {
  return {
    v: 1,
    keys: file.keys.map(({ keyId, publicRawB64u, createdAt }) => ({
      keyId,
      publicRawB64u,
      createdAt,
    })),
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
      typeof k?.publicRawB64u !== 'string' ||
      typeof k?.createdAt !== 'number' ||
      !Number.isFinite(k.createdAt) ||
      k.createdAt <= 0 ||
      (k.deactivatedAt !== undefined &&
        (typeof k.deactivatedAt !== 'number' ||
          !Number.isFinite(k.deactivatedAt) ||
          k.deactivatedAt <= 0))
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

/** 公钥投影解析：形状与 keyId 派生关系仍严格校验，但类型上根本不存在私钥字段。 */
function parsePublicKeyringFile(raw: string, path: string): PublicKeyringFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`[model-authority] public keyring file is not valid JSON: ${path}`)
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`[model-authority] public keyring file is not an object: ${path}`)
  }
  const file = parsed as Partial<PublicKeyringFile>
  if (file.v !== 1 || !Array.isArray(file.keys)) {
    throw new Error(`[model-authority] public keyring file shape invalid: ${path}`)
  }
  const seen = new Set<string>()
  for (const key of file.keys) {
    if (
      typeof key?.keyId !== 'string' ||
      typeof key?.publicRawB64u !== 'string' ||
      typeof key?.createdAt !== 'number'
    ) {
      throw new Error(`[model-authority] public keyring entry shape invalid: ${path}`)
    }
    if (seen.has(key.keyId)) {
      throw new Error(`[model-authority] duplicate public keyId ${key.keyId}: ${path}`)
    }
    seen.add(key.keyId)
    const rawKey = Buffer.from(key.publicRawB64u, 'base64url')
    if (rawKey.length !== 32 || deriveKeyId(rawKey) !== key.keyId) {
      throw new Error(`[model-authority] public keyring keyId/publicKey mismatch: ${path}`)
    }
  }
  return { v: 1, keys: file.keys }
}
