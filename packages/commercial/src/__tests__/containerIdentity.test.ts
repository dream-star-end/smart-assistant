/**
 * V3 Phase 2 Task 2C — 容器身份双因子校验单元测试(多 host 版,D.1a 改造)。
 *
 * 跑法: npx tsx --test src/__tests__/containerIdentity.test.ts
 *
 * 用 in-memory repo;真 PG 路径在 integ 测里覆盖。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  parseContainerToken,
  hashSecret,
  compareHash,
  verifyContainerIdentity,
  ContainerIdentityError,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js";
import { signAccess, verifyAccess, JwtError } from "../auth/jwt.js";

// ------- 辅助:in-memory repo + 测试夹具 ------------------------------------

interface Row {
  id: number;
  user_id: number;
  host_uuid: string;
  bound_ip: string;
  secret_hash: Buffer | null;
}

function memRepo(rows: Row[]): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid: string, boundIp: string) {
      return rows.find((r) => r.host_uuid === hostUuid && r.bound_ip === boundIp) ?? null;
    },
  };
}

function makeSecret(): { hex: string; hash: Buffer } {
  const hex = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(Buffer.from(hex, "hex")).digest();
  return { hex, hash };
}

// 便于编写测试:self host 和一个 remote host 两个常用 uuid
const SELF = "00000000-0000-0000-0000-000000000001";
const REMOTE = "00000000-0000-0000-0000-000000000002";

// ------- parseContainerToken ----------------------------------------------

describe("parseContainerToken", () => {
  test("正常: oc-v3.<id>.<64hex>", () => {
    const sec = "a".repeat(64);
    const r = parseContainerToken(`oc-v3.42.${sec}`);
    assert.equal(r.containerId, 42);
    assert.equal(r.secret, sec);
  });

  test("Bearer 前缀也认", () => {
    const sec = "f".repeat(64);
    const r = parseContainerToken(`Bearer oc-v3.7.${sec}`);
    assert.equal(r.containerId, 7);
    assert.equal(r.secret, sec);
  });

  test("空 / undefined → BAD_TOKEN_FORMAT", () => {
    assert.throws(
      () => parseContainerToken(undefined),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "BAD_TOKEN_FORMAT",
    );
    assert.throws(
      () => parseContainerToken(""),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "BAD_TOKEN_FORMAT",
    );
  });

  test("错前缀 (sk-...)", () => {
    const sec = "0".repeat(64);
    assert.throws(
      () => parseContainerToken(`sk-ant-${sec}`),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "BAD_TOKEN_FORMAT",
    );
  });

  test("非数字 container id", () => {
    assert.throws(
      () => parseContainerToken(`oc-v3.abc.${"0".repeat(64)}`),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "BAD_TOKEN_FORMAT",
    );
  });

  test("secret 长度 != 64", () => {
    assert.throws(
      () => parseContainerToken(`oc-v3.1.${"0".repeat(63)}`),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "BAD_TOKEN_FORMAT",
    );
    assert.throws(
      () => parseContainerToken(`oc-v3.1.${"0".repeat(65)}`),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "BAD_TOKEN_FORMAT",
    );
  });

  test("secret 含非 hex 字符", () => {
    assert.throws(
      () => parseContainerToken(`oc-v3.1.${"g".repeat(64)}`),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "BAD_TOKEN_FORMAT",
    );
  });

  test("container id == 0 不接受(防 0/负数边界)", () => {
    assert.throws(
      () => parseContainerToken(`oc-v3.0.${"0".repeat(64)}`),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "BAD_TOKEN_FORMAT",
    );
  });
});

// ------- hashSecret + compareHash -----------------------------------------

describe("hashSecret + compareHash", () => {
  test("hashSecret 输出 32 bytes", () => {
    const h = hashSecret("a".repeat(64));
    assert.equal(h.length, 32);
  });

  test("同输入 → 同 hash;不同输入 → 不同 hash", () => {
    const a = hashSecret("a".repeat(64));
    const b = hashSecret("a".repeat(64));
    const c = hashSecret("b".repeat(64));
    assert.equal(compareHash(a, b), true);
    assert.equal(compareHash(a, c), false);
  });

  test("compareHash 长度不一致 → false(不抛)", () => {
    const a = randomBytes(32);
    const b = randomBytes(31);
    assert.equal(compareHash(a, b), false);
  });

  test("compareHash 是 timing-safe(sanity:它就是 timingSafeEqual)", () => {
    const a = randomBytes(32);
    const b = Buffer.from(a);
    // sanity: 与 node 内置 timingSafeEqual 一致
    assert.equal(compareHash(a, b), timingSafeEqual(a, b));
  });
});

// ------- verifyContainerIdentity 双因子组合 -------------------------------

describe("verifyContainerIdentity — 正常路径", () => {
  test("两因子都对 → 返 ContainerIdentity", async () => {
    const sec = makeSecret();
    const repo = memRepo([
      { id: 100, user_id: 5, host_uuid: SELF, bound_ip: "172.30.0.10", secret_hash: sec.hash },
    ]);
    const id = await verifyContainerIdentity(
      repo,
      { hostUuid: SELF, boundIp: "172.30.0.10" },
      `Bearer oc-v3.100.${sec.hex}`,
    );
    assert.equal(id.containerId, 100);
    assert.equal(id.userId, 5);
    assert.equal(id.boundIp, "172.30.0.10");
    assert.equal(id.hostUuid, SELF);
  });

  test("同 bound_ip 在不同 host 下独立(multi-host 核心)", async () => {
    const secSelf = makeSecret();
    const secRemote = makeSecret();
    const repo = memRepo([
      { id: 10, user_id: 1, host_uuid: SELF, bound_ip: "172.30.0.20", secret_hash: secSelf.hash },
      { id: 20, user_id: 2, host_uuid: REMOTE, bound_ip: "172.30.0.20", secret_hash: secRemote.hash },
    ]);
    const selfId = await verifyContainerIdentity(
      repo,
      { hostUuid: SELF, boundIp: "172.30.0.20" },
      `oc-v3.10.${secSelf.hex}`,
    );
    assert.equal(selfId.containerId, 10);
    assert.equal(selfId.hostUuid, SELF);

    const remoteId = await verifyContainerIdentity(
      repo,
      { hostUuid: REMOTE, boundIp: "172.30.0.20" },
      `oc-v3.20.${secRemote.hex}`,
    );
    assert.equal(remoteId.containerId, 20);
    assert.equal(remoteId.hostUuid, REMOTE);
  });
});

describe("verifyContainerIdentity — 因子 A 失败", () => {
  test("(host, ip) 没有 active 容器 → UNKNOWN_CONTAINER_IP", async () => {
    const sec = makeSecret();
    const repo = memRepo([
      { id: 100, user_id: 5, host_uuid: SELF, bound_ip: "172.30.0.10", secret_hash: sec.hash },
    ]);
    await assert.rejects(
      verifyContainerIdentity(
        repo,
        { hostUuid: SELF, boundIp: "172.30.0.99" },
        `oc-v3.100.${sec.hex}`,
      ),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "UNKNOWN_CONTAINER_IP",
    );
  });

  test("repo 返回 null(空集)→ UNKNOWN_CONTAINER_IP", async () => {
    const sec = makeSecret();
    const repo = memRepo([]);
    await assert.rejects(
      verifyContainerIdentity(
        repo,
        { hostUuid: SELF, boundIp: "172.30.0.10" },
        `oc-v3.1.${sec.hex}`,
      ),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "UNKNOWN_CONTAINER_IP",
    );
  });

  test("bound_ip 存在但在另一 host → UNKNOWN_CONTAINER_IP(跨 host 查找严格隔离)", async () => {
    const sec = makeSecret();
    const repo = memRepo([
      { id: 100, user_id: 5, host_uuid: SELF, bound_ip: "172.30.0.10", secret_hash: sec.hash },
    ]);
    await assert.rejects(
      verifyContainerIdentity(
        repo,
        { hostUuid: REMOTE, boundIp: "172.30.0.10" },
        `oc-v3.100.${sec.hex}`,
      ),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "UNKNOWN_CONTAINER_IP",
    );
  });
});

describe("verifyContainerIdentity — 因子 B 失败", () => {
  test("token 的 containerId 与 (host, ip) 反查到的 row.id 不符 → CONTAINER_ID_MISMATCH", async () => {
    const sec = makeSecret();
    const repo = memRepo([
      { id: 100, user_id: 5, host_uuid: SELF, bound_ip: "172.30.0.10", secret_hash: sec.hash },
    ]);
    await assert.rejects(
      verifyContainerIdentity(
        repo,
        { hostUuid: SELF, boundIp: "172.30.0.10" },
        `oc-v3.999.${sec.hex}`,
      ),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "CONTAINER_ID_MISMATCH",
    );
  });

  test("secret 不对 → BAD_SECRET", async () => {
    const right = makeSecret();
    const wrong = makeSecret();
    const repo = memRepo([
      { id: 100, user_id: 5, host_uuid: SELF, bound_ip: "172.30.0.10", secret_hash: right.hash },
    ]);
    await assert.rejects(
      verifyContainerIdentity(
        repo,
        { hostUuid: SELF, boundIp: "172.30.0.10" },
        `oc-v3.100.${wrong.hex}`,
      ),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "BAD_SECRET",
    );
  });

  test("row.secret_hash IS NULL → BAD_SECRET", async () => {
    const sec = makeSecret();
    const repo = memRepo([
      { id: 100, user_id: 5, host_uuid: SELF, bound_ip: "172.30.0.10", secret_hash: null },
    ]);
    await assert.rejects(
      verifyContainerIdentity(
        repo,
        { hostUuid: SELF, boundIp: "172.30.0.10" },
        `oc-v3.100.${sec.hex}`,
      ),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "BAD_SECRET",
    );
  });
});

describe("verifyContainerIdentity — token 解析失败优先于 repo", () => {
  test("BAD_TOKEN_FORMAT 早于 IP 查询(repo 不被调用)", async () => {
    let called = 0;
    const repo: ContainerIdentityRepo = {
      async findActiveByHostAndBoundIp() {
        called++;
        return null;
      },
    };
    await assert.rejects(
      verifyContainerIdentity(
        repo,
        { hostUuid: SELF, boundIp: "1.2.3.4" },
        "garbage",
      ),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "BAD_TOKEN_FORMAT",
    );
    assert.equal(called, 0, "repo 不该被调用");
  });
});

describe("verifyContainerIdentity — 攻击场景", () => {
  test("容器 A 的 IP + 容器 B 的合法 token → CONTAINER_ID_MISMATCH(防跨容器拼接)", async () => {
    const secA = makeSecret();
    const secB = makeSecret();
    const repo = memRepo([
      { id: 1, user_id: 11, host_uuid: SELF, bound_ip: "172.30.0.1", secret_hash: secA.hash },
      { id: 2, user_id: 22, host_uuid: SELF, bound_ip: "172.30.0.2", secret_hash: secB.hash },
    ]);
    // 用 IP A 配 token B(secret 也是 B 自己的合法 secret)
    await assert.rejects(
      verifyContainerIdentity(
        repo,
        { hostUuid: SELF, boundIp: "172.30.0.1" },
        `oc-v3.2.${secB.hex}`,
      ),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "CONTAINER_ID_MISMATCH",
    );
  });

  test("猜对 containerId 但 secret 错 → BAD_SECRET(timing-safe)", async () => {
    const sec = makeSecret();
    const repo = memRepo([
      { id: 100, user_id: 5, host_uuid: SELF, bound_ip: "172.30.0.10", secret_hash: sec.hash },
    ]);
    // 用容器自己的 IP 去试 secret
    await assert.rejects(
      verifyContainerIdentity(
        repo,
        { hostUuid: SELF, boundIp: "172.30.0.10" },
        `oc-v3.100.${"0".repeat(64)}`,
      ),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "BAD_SECRET",
    );
  });

  test("cross-host cert 冒用:拿 host-A cert 声称自己是 host-B 的容器 IP → UNKNOWN_CONTAINER_IP", async () => {
    const sec = makeSecret();
    // host REMOTE 上有这个容器
    const repo = memRepo([
      { id: 50, user_id: 5, host_uuid: REMOTE, bound_ip: "172.30.0.10", secret_hash: sec.hash },
    ]);
    // 攻击者以 SELF 身份登 mTLS(cert SAN 是 SELF),却声称自己是 REMOTE 上的容器
    // → caller 传入的 hostUuid 来自 cert(SELF)→ 查 (SELF, 172.30.0.10) → 查不到
    await assert.rejects(
      verifyContainerIdentity(
        repo,
        { hostUuid: SELF, boundIp: "172.30.0.10" },
        `oc-v3.50.${sec.hex}`,
      ),
      (e: unknown) => e instanceof ContainerIdentityError && e.code === "UNKNOWN_CONTAINER_IP",
    );
  });
});

/**
 * AINV-4 —— 容器 token 与 user-scope JWT 的双向身份隔离
 * (`PHASE1-TEST-COVERAGE-PLAN.md` Audit 表 AINV-4 行)。
 *
 * 锁的不变量:容器 token (`oc-v3.<id>.<64hex>`) 不能被 user-scope 路由的 JWT
 * verify 路径接受,反之亦然;两套身份系统在解析层就互相拒绝,后续 user-only
 * 路由(`requireUserVerifyDb`)无法被容器 token 越权调用。
 *
 * 为什么放在 containerIdentity.test.ts:容器 token 与 JWT 的"越界"问题在解析
 * 层就该截住,本测试套件是该解析层的归属;集成层"requireUser → user route"
 * 在 router 测试里被覆盖,本套件只锁解析归属不变量,不去测路由 dispatcher。
 *
 * 攻击模型:
 *   - 攻击者拿到一份合法容器 token,试图把它作为 `Authorization: Bearer <token>`
 *     送到 `/api/me` 或 `/api/orders/...` 这类只接受 JWT 的端点。`extractTokenFromReq`
 *     抽出 token 后,user-scope handler 先调 `verifyAccess` → 必须 throw JwtError
 *     而非"侥幸通过 / 返回 claims"。
 *   - 反向同样:JWT 字符串不能被 `parseContainerToken` 当成合法容器 token 解析,
 *     防止"攻击者把 user JWT 误送到 `/v1/messages` 当成容器身份用"的情况。
 */
describe("AINV-4: container token 与 user JWT 的双向身份隔离", () => {
  const SECRET = randomBytes(64).toString("hex");

  test("容器 token 不能通过 verifyAccess(user-scope 路由的 JWT 闸门)", async () => {
    const containerSecret = randomBytes(32).toString("hex"); // 64 char hex
    const containerToken = `oc-v3.42.${containerSecret}`;
    // user-scope handler 链 (`extractTokenFromReq` → `verifyAccess`) 第一步必拒
    await assert.rejects(
      verifyAccess(containerToken, SECRET),
      (e: unknown) => e instanceof JwtError,
      "verifyAccess 必须把容器 token 当 malformed JWT 拒绝",
    );
  });

  test("合法 JWT 不能通过 parseContainerToken(容器路径的身份闸门)", async () => {
    const issued = await signAccess({ sub: "1", role: "user" }, SECRET);
    // JWT 也是 3 段 dot-separated,parseContainerToken 必须靠 `oc-v3.` 前缀过滤
    assert.throws(
      () => parseContainerToken(issued.token),
      (e: unknown) =>
        e instanceof ContainerIdentityError && e.code === "BAD_TOKEN_FORMAT",
      "parseContainerToken 必须把 JWT 当 malformed container token 拒绝",
    );
  });

  test("`Bearer <jwt>` 也不能通过 parseContainerToken — Bearer 前缀剥离后仍非容器格式", async () => {
    const issued = await signAccess({ sub: "1", role: "user" }, SECRET);
    assert.throws(
      () => parseContainerToken(`Bearer ${issued.token}`),
      (e: unknown) =>
        e instanceof ContainerIdentityError && e.code === "BAD_TOKEN_FORMAT",
    );
  });
});
