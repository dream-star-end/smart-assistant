/**
 * authorityKeyCensus —— **在跑容器的 keyring 覆盖普查**(R3-M7 轮换五步的步骤② gate)。
 *
 * 方案 docs/V5_MODEL_AUTHORITY_PLAN.md §2 轮换五步:
 *   ① 下发新公钥(旧钥保留)→ ② **全容器 attest 新 keyId** → ③ master 切新私钥
 *   → ④ 等旧签名 TTL 耗尽 → ⑤ 删旧公钥
 *
 * 步骤② 之前是一句口号 —— 没有任何数据结构能回答「现在是不是**全部**在跑容器都认得
 * 新公钥了」。运维只能目测,而 ③ 早于 ② 的代价是**全站 UnknownKey 拒帧**(在跑容器
 * 的 env 里没有新公钥,master 却已经用新私钥签票)。本模块把那句口号变成一个可 gate
 * 的谓词:`isFullyCovered(newKeyId)`。
 *
 * 数据来源:容器 gateway 的 hello attestation 帧(`outbound.control.container_attest`)
 * 上报**自己 env ring 的 keyIds + 指纹**(gateway/modelAuthority.buildContainerAttestFrame);
 * bridge 在每条连接 attest 成功时 `record()`,连接终结时 `drop()`。
 *
 * ---------------------------------------------------------------------------
 * 语义边界(不要把它当成什么)
 *
 * - **它统计的是"连接",不是"容器全集"**。没有活跃 bridge 连接的容器(idle / stopped)
 *   不在册 —— 它们下次连上来时会重新 attest;若那时 ring 还是旧的,连接级 attestation
 *   门(bridge)会按 flag 语义处置(拒 + recycle)。所以 census 覆盖 100% 的正确读法是
 *   「此刻所有在服务用户的容器都认得这把钥匙」,这恰好是切私钥所需的条件。
 * - **旧版本容器上报不了 keyIds**(字段是本批次新加的)→ 记为 `keyIdsUnknown`,并且
 *   `isFullyCovered` 对它一律判**不覆盖**(fail-closed:不知道 = 不敢切私钥)。
 * - 它**不做判定**、不参与拒帧,只是可观测面 + 轮换 gate。
 */

/** 一条在跑 bridge 连接的 keyring 自述。 */
export interface AuthorityKeyCensusEntry {
  readonly uid: number
  readonly containerId: number | null
  /** 容器 env ring 的 keyId 集合(字典序;旧版本容器不上报 → 空 + keyIdsUnknown=true)。 */
  readonly keyIds: readonly string[]
  /** protocol keyringFingerprint(容器与 master 同源算法)。 */
  readonly fingerprint: string
  /** 旧版本容器(attest 帧没有 keyIds 字段)→ true。覆盖判定按"不覆盖"处理。 */
  readonly keyIdsUnknown: boolean
  readonly attestedAt: number
}

export interface AuthorityKeyCensusSnapshot {
  /** 在册连接数(= 已 attest 且未断开的 bridge 连接)。 */
  readonly connections: number
  /** keyId → 认得它的连接数。 */
  readonly byKeyId: Record<string, number>
  /** ring 指纹 → 连接数(全站 ring 收敛时应只有一个键)。 */
  readonly byFingerprint: Record<string, number>
  /** 上报不了 keyIds 的旧容器连接数(> 0 → 任何 keyId 都不算全覆盖)。 */
  readonly unknown: number
}

export interface AuthorityKeyCoverage {
  readonly keyId: string
  readonly total: number
  readonly covering: number
  /** 不认得该 keyId 的连接(含 keyIdsUnknown 的旧容器)—— 轮换前要先 recycle 掉它们。 */
  readonly missing: Array<{ uid: number; containerId: number | null; keyIdsUnknown: boolean }>
  /** total > 0 且无 missing。**total = 0 也算 true**:没有在跑容器 = 没人会被切钥切死。 */
  readonly fullyCovered: boolean
}

/**
 * 进程级普查表(master 一份)。
 *
 * key = bridge 的 `connId`(每条连接一个 UUID),不是 containerId ——
 * 同一容器可以有多条连接(多标签页 / 重连窗口),按连接计数才不会漏掉「一条连接还挂在
 * 旧 env 的容器上」这种局面。
 */
export class AuthorityKeyCensus {
  private readonly byConn = new Map<string, AuthorityKeyCensusEntry>()

  /** 连接 attest 成功时登记(同 connId 重复 record = 覆盖,attest 每连接只发生一次)。 */
  record(connId: string, entry: AuthorityKeyCensusEntry): void {
    this.byConn.set(connId, entry)
  }

  /** 连接终结时移除(bridge finalCleanup;幂等)。 */
  drop(connId: string): void {
    this.byConn.delete(connId)
  }

  get size(): number {
    return this.byConn.size
  }

  snapshot(): AuthorityKeyCensusSnapshot {
    const byKeyId: Record<string, number> = {}
    const byFingerprint: Record<string, number> = {}
    let unknown = 0
    for (const e of this.byConn.values()) {
      if (e.keyIdsUnknown) unknown += 1
      byFingerprint[e.fingerprint] = (byFingerprint[e.fingerprint] ?? 0) + 1
      for (const k of e.keyIds) byKeyId[k] = (byKeyId[k] ?? 0) + 1
    }
    return { connections: this.byConn.size, byKeyId, byFingerprint, unknown }
  }

  /**
   * 轮换步骤② 的 gate:全部在跑连接都认得 `keyId` 吗?
   *
   * fail-closed:`keyIdsUnknown` 的连接(旧容器)一律计入 missing —— 「我不知道它认不认得」
   * 与「它不认得」在切私钥这件事上后果相同(切了就全站拒帧),不能乐观处理。
   */
  coverage(keyId: string): AuthorityKeyCoverage {
    const missing: AuthorityKeyCoverage['missing'] = []
    let covering = 0
    for (const e of this.byConn.values()) {
      if (!e.keyIdsUnknown && e.keyIds.includes(keyId)) covering += 1
      else missing.push({ uid: e.uid, containerId: e.containerId, keyIdsUnknown: e.keyIdsUnknown })
    }
    return {
      keyId,
      total: this.byConn.size,
      covering,
      missing,
      fullyCovered: missing.length === 0,
    }
  }

  isFullyCovered(keyId: string): boolean {
    return this.coverage(keyId).fullyCovered
  }

  /** 测试用。 */
  _resetForTests(): void {
    this.byConn.clear()
  }
}

/**
 * master 进程级单例。
 *
 * 为什么是单例而不是 DI 到 bridge:census 的消费者(运维 / 未来的轮换 CLI 或 admin 只读面)
 * 与生产者(每条 bridge 连接)在不同的装配路径上,靠 DI 串起来要在 index.ts 里多穿一层
 * 没有任何判定语义的管道。它是纯观测状态,单例是它的正确形状。bridge 允许注入自己的实例
 * (测试隔离用),缺省即用本单例。
 */
export const authorityKeyCensus = new AuthorityKeyCensus()
