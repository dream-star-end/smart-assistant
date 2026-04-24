/**
 * V3 Phase 2 Task 2C — 容器身份双因子校验(多 host 版,2026-04-24 D.1a 改造)。
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §3.2 / 03-MVP-CHECKLIST.md Task 2C /
 * docs/v3/D1-plan-draft.md(本次 D.1 多机 identity 改造)。
 *
 * 用途:
 *   anthropicProxy(2D)收到容器内 OpenClaude 发来的 /v1/messages 请求时,
 *   先调本模块验证两个因子,任一失败 → 401。journal 不写、preCheck 不调,
 *   防止外部仿冒容器消耗用户额度。
 *
 * 双因子语义(多 host 版):
 *   - 因子 A(网络):(host_uuid, bound_ip) 必须命中一行 state='active' 的
 *     agent_containers(0030 migration 把 bound_ip 全局唯一改为 per-host 唯一)。
 *     hostUuid 与 boundIp 的来源由 caller 区分:
 *       • self-host 路径:hostUuid = 进程级 SELF_HOST_UUID,boundIp = socket.remoteAddress
 *       • remote-host 路径(master:18443 mTLS):hostUuid = client cert SAN URI 解出,
 *         boundIp = `X-V3-Container-IP` 头(由 node-agent 反代层注入,带 fingerprint
 *         pin 防 cert 泄露;头注入只发生在 node-agent,容器不能伪造,见 D.1c)
 *   - 因子 B(密钥):Authorization 头格式 `Bearer oc-v3.<containerId>.<secret>`
 *     的 secret 经 SHA-256 必须 == 该 row 的 secret_hash。secret 在容器
 *     env 里、在用户文件里都不会出现(supervisor 注入时不写 host fs),
 *     timing-safe compare 杜绝 hash 时序攻击。
 *
 * 不变量:
 *   - 两个因子**必须都过**才返身份;A 单过、B 单过都返 401(并记不同 errcode
 *     方便定位攻击模式但**不外泄给容器** — 401 message 永远是
 *     "container identity verification failed",errcode 仅出现在 server log)
 *   - row 必须 state='active' 才认。'vanished' / NULL / 任何其他态 → 401
 *   - 不再校验 row.host_uuid == ctx.hostUuid:`findActiveByHostAndBoundIp`
 *     的 WHERE 已把 host_uuid 钉死(queries.ts:145),重复校验是冗余防御(Codex D.1 Q6)
 *
 * 不做的:
 *   - 不做 hot map — M1 多 host 仍是每请求 1 行 + 1 次 SHA,<100µs 撑得住;
 *     LISTEN/NOTIFY 留给 P1
 *   - 不做 rate-limit per-IP — 那归 anthropicProxy(2D)统一管
 *   - 不做 docker inspect 反查自愈 — 单机 master 内 supervisor 即刻可见,
 *     多 host 间同步由 hostHealth poll 负责
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { findActiveByHostAndBoundIp } from "../compute-pool/queries.js";

export class ContainerIdentityError extends Error {
  constructor(
    /** 内部 errcode,只进 log 不返给客户端 */
    readonly code:
      | "BAD_TOKEN_FORMAT"
      | "UNKNOWN_CONTAINER_IP"
      | "CONTAINER_NOT_ACTIVE"
      | "CONTAINER_ID_MISMATCH"
      | "BAD_SECRET",
    message: string,
  ) {
    super(message);
    this.name = "ContainerIdentityError";
  }
}

export interface ContainerIdentity {
  /** agent_containers.id */
  containerId: number;
  /** agent_containers.user_id(签发该容器时绑定;ephemeral 一次性) */
  userId: number;
  /** agent_containers.bound_ip(给上游 anthropicProxy 写 log 用) */
  boundIp: string;
  /** agent_containers.host_uuid(多 host 审计需要) */
  hostUuid: string;
}

/**
 * 解析 `oc-v3.<containerId>.<secret>` 格式 token。
 *
 * 严格语法:
 *   - 必须以 `oc-v3.` 起头(常量,严格大小写)
 *   - 中段是 base10 整数 containerId(支持 BigInt 范围,但本接口 number
 *     表达;MVP 单库 < 2^53 个容器,够了)
 *   - 末段是 secret,长度必须正好 64 个 hex 字符(对应 32 字节随机)
 *
 * 任何不符合 → BAD_TOKEN_FORMAT。
 *
 * 设计取舍:secret 用 hex 而非 base64 / base64url,因为容器内 env 有 shell
 * 转义风险,hex 字符集最安全;且固定 64 字符长度让任何长度异常立刻可见。
 */
export function parseContainerToken(raw: string | undefined): {
  containerId: number;
  secret: string;
} {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ContainerIdentityError("BAD_TOKEN_FORMAT", "missing bearer token");
  }
  // Authorization header 形如 `Bearer <token>`,允许调用方传 raw token
  // 也允许带 Bearer 前缀
  const trimmed = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw.trim();
  // ^oc-v3\.(\d+)\.([0-9a-f]{64})$
  const m = /^oc-v3\.(\d+)\.([0-9a-f]{64})$/.exec(trimmed);
  if (!m) {
    throw new ContainerIdentityError("BAD_TOKEN_FORMAT", "token does not match oc-v3.<id>.<secret>");
  }
  const cid = Number.parseInt(m[1]!, 10);
  if (!Number.isSafeInteger(cid) || cid <= 0) {
    throw new ContainerIdentityError("BAD_TOKEN_FORMAT", "container_id must be a positive integer");
  }
  return { containerId: cid, secret: m[2]! };
}

/** SHA-256(secret as hex string) → Buffer(32) */
export function hashSecret(secretHex: string): Buffer {
  // secret 是 64 hex 字符;hash 输入应是其原始字节(32 bytes),不是字符串
  // —— supervisor 入库时也是这么算的(见 3C provision)
  const bytes = Buffer.from(secretHex, "hex");
  return createHash("sha256").update(bytes).digest();
}

/**
 * Timing-safe compare 两个 32 字节 hash。长度不一致直接 false(timingSafeEqual
 * 长度不一致会抛,我们提前判断给一个明确的 false)。
 */
export function compareHash(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 校验上下文。由 caller 显式提供两个定位信息:
 *   - hostUuid:self-host 路径用 SELF_HOST_UUID 常量;remote-host 路径从
 *     mTLS client cert SAN URI 解出(见 certAuthority.verifyIncomingHostCert,D.1b)
 *   - boundIp:self-host 路径用 socket.remoteAddress;remote-host 路径从
 *     `X-V3-Container-IP` 头取(node-agent L7 反代注入,见 D.1c)
 */
export interface ContainerIdentityContext {
  hostUuid: string;
  boundIp: string;
}

/**
 * DB 接口最小化:本模块只需要"按 (host, boundIp) 反查 active container row"的能力。
 * 抽象成 deps 让单测可注入纯内存版,不必拖 PG。
 */
export interface ContainerIdentityRepo {
  /**
   * 返回 host_uuid=hostUuid AND bound_ip=boundIp AND state='active' 的行(0 或 1 行)。
   * M1 多 host: `(host_uuid, bound_ip)` partial UNIQUE 索引保证 active 集合内唯一
   * (见 migration 0030)。
   */
  findActiveByHostAndBoundIp(
    hostUuid: string,
    boundIp: string,
  ): Promise<{
    id: number;
    user_id: number;
    bound_ip: string;
    host_uuid: string;
    secret_hash: Buffer | null;
  } | null>;
}

/**
 * 默认 repo。底层调 compute-pool/queries 的模块级 getPool() singleton。
 *
 * 不接受 Pool 入参 —— 即使传进来我们也用不上,签名诚实一点,避免 caller 误以为
 * 可以注入测试 pool。测试路径请直接用 memRepo(见 containerIdentity.test.ts)。
 */
export function createPgIdentityRepo(): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid: string, boundIp: string) {
      const r = await findActiveByHostAndBoundIp(hostUuid, boundIp);
      if (!r) return null;
      return {
        id: r.id,
        user_id: r.user_id,
        bound_ip: r.bound_ip,
        host_uuid: r.host_uuid,
        secret_hash: r.secret_hash,
      };
    },
  };
}

/**
 * 入口:跑双因子校验。成功 → 返 ContainerIdentity;失败 → throw
 * ContainerIdentityError(调用方通常翻译成 401 给容器,errcode 进 log)。
 *
 * 流程:
 *   1) 解析 token 拿 (claimedContainerId, claimedSecret)。失败 → BAD_TOKEN_FORMAT
 *   2) 用 (ctx.hostUuid, ctx.boundIp) 查 active row。无 → UNKNOWN_CONTAINER_IP
 *   3) row.id 必须 == claimedContainerId(防"用容器 A 的 IP + 容器 B 的 token"
 *      跨容器拼装)。失败 → CONTAINER_ID_MISMATCH
 *   4) row.secret_hash 必须存在 + timing-safe compare hash(claimedSecret)。
 *      失败 → BAD_SECRET
 *   5) 返 ContainerIdentity
 *
 * 调用方必须把 ContainerIdentityError catch 住,翻成 HTTP 401 response,
 * **errcode 不能放进 response body** — 只进服务端 log,避免给攻击者反馈。
 */
export async function verifyContainerIdentity(
  repo: ContainerIdentityRepo,
  ctx: ContainerIdentityContext,
  authorizationHeader: string | undefined,
): Promise<ContainerIdentity> {
  const { containerId: claimedCid, secret } = parseContainerToken(authorizationHeader);

  const row = await repo.findActiveByHostAndBoundIp(ctx.hostUuid, ctx.boundIp);
  if (!row) {
    throw new ContainerIdentityError(
      "UNKNOWN_CONTAINER_IP",
      `no active container for host=${ctx.hostUuid} ip=${ctx.boundIp}`,
    );
  }
  if (row.id !== claimedCid) {
    throw new ContainerIdentityError(
      "CONTAINER_ID_MISMATCH",
      `host=${ctx.hostUuid} ip=${ctx.boundIp} → container ${row.id} but token claims ${claimedCid}`,
    );
  }
  if (!row.secret_hash) {
    // active 行竟然没 secret_hash:0012 没有 NOT NULL(M1 单 host 我们不强约束),
    // 但 supervisor.provision 必须填,fallback 视为 BAD_SECRET
    throw new ContainerIdentityError(
      "BAD_SECRET",
      `container ${row.id} has no secret_hash on file`,
    );
  }
  const candidate = hashSecret(secret);
  if (!compareHash(candidate, row.secret_hash)) {
    throw new ContainerIdentityError("BAD_SECRET", `secret mismatch for container ${row.id}`);
  }

  return {
    containerId: row.id,
    userId: row.user_id,
    boundIp: row.bound_ip,
    hostUuid: row.host_uuid,
  };
}
