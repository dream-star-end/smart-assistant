/**
 * V3 CC 外接 plan Phase 2 — `auth/apiKeyIdentity.ts` unit 测试。
 *
 * 跑法: npx tsx --test src/__tests__/apiKeyIdentity.unit.test.ts
 *
 * 覆盖 plan §4 invariants:
 *   #2 撤销立即生效  — repo.findByPrefix 返 null(active-only)→ strategy 抛 API_KEY_INVALID
 *   #4 timing-safe   — 行为负例(secret 1 字节差异 → API_KEY_INVALID)+
 *                       源码含 `timingSafeEqual(` 调用(轻 grep,非 lint;Codex Phase 2 NIT 采纳)
 *   #6 不调 recordHostRequest — Phase 2 strategy 根本不持该 dep,无需测;Phase 3 wiring 锁
 *   #7(first half)invalid/revoked → IdentityError;副作用 spy 在 Phase 3 integ 锁
 *
 * 行为细分:
 *   - 错误码三分法 MISSING_API_KEY / BAD_API_KEY_FORMAT / API_KEY_INVALID
 *   - last_used_at 5min in-process 节流(closure scope LRU,实例隔离)
 *   - touchLastUsed 失败 → strategy.resolve 不抛 + logger.warn 调用
 *   - LRU evict — 上限 1000 后最旧 key 被驱逐(下次访问不再被节流)
 *   - authorize 委托 authorizeProxyIdentity(loadUserModelAuthz throw / canUseModel false)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { makeApiKeyIdentityStrategy } from "../auth/apiKeyIdentity.js";
import {
  IdentityError,
  AuthzLoadError,
  AuthzDeniedError,
} from "../auth/proxyIdentity.js";
import type {
  ApiKeyRepo,
  ApiKeyRow,
  ApiKeySummary,
  CreatedApiKey,
} from "../auth/apiKeyRepo.js";
import type { PricingCache } from "../billing/pricing.js";

const STRATEGY_FILE = fileURLToPath(
  new URL("../auth/apiKeyIdentity.ts", import.meta.url),
);

/** 测试用 SHA-256(Buffer.from(secretHex, "hex")) — 跟生产 hashApiKeySecret 同型。 */
function hashSecretForTest(secretHex: string): Buffer {
  return createHash("sha256").update(Buffer.from(secretHex, "hex")).digest();
}

/** 制造一行 ApiKeyRow,默认 prefix `abcd1234` + 全 0 hash(我们手动算 hash 替换)。 */
function makeRow(opts: Partial<ApiKeyRow> & { secretHex?: string } = {}): ApiKeyRow {
  const secretHex = opts.secretHex ?? "a".repeat(48);
  return {
    id: opts.id ?? 1n,
    userId: opts.userId ?? 100n,
    label: opts.label ?? "lbl",
    keyPrefix: opts.keyPrefix ?? "abcd1234",
    keyHash: opts.keyHash ?? hashSecretForTest(secretHex),
    createdAt: opts.createdAt ?? new Date("2026-05-18T00:00:00Z"),
    lastUsedAt: opts.lastUsedAt ?? null,
  };
}

interface RepoSpy {
  repo: ApiKeyRepo;
  findByPrefixCalls: string[];
  touchLastUsedCalls: bigint[];
  setFindByPrefixResult: (row: ApiKeyRow | null) => void;
  setTouchError: (err: Error | null) => void;
}

function makeRepoSpy(initialRow: ApiKeyRow | null = null): RepoSpy {
  let row: ApiKeyRow | null = initialRow;
  let touchErr: Error | null = null;
  const findByPrefixCalls: string[] = [];
  const touchLastUsedCalls: bigint[] = [];
  const repo: ApiKeyRepo = {
    async create(): Promise<CreatedApiKey> {
      throw new Error("not used in this test");
    },
    async findByPrefix(prefix: string): Promise<ApiKeyRow | null> {
      findByPrefixCalls.push(prefix);
      return row;
    },
    async list(): Promise<ApiKeySummary[]> {
      return [];
    },
    async revoke(): Promise<boolean> {
      return false;
    },
    async touchLastUsed(id: bigint): Promise<void> {
      touchLastUsedCalls.push(id);
      if (touchErr) throw touchErr;
    },
  };
  return {
    repo,
    findByPrefixCalls,
    touchLastUsedCalls,
    setFindByPrefixResult: (r) => {
      row = r;
    },
    setTouchError: (e) => {
      touchErr = e;
    },
  };
}

/** 假 PricingCache — strategy.resolve 不消费它,只有 authorize 走 authzModels。 */
const FAKE_PRICING = {} as unknown as PricingCache;

/**
 * 默认 UA 用真实 CC CLI 输出形态 `claude-cli/<v> (<USER_TYPE>, <ENTRYPOINT>)`,
 * 让大部分 case 自然过 UA 门控(2026-05-19 新增 §3.5)。需要测 UA 不对的 case
 * 显式传 `ua` 覆盖。
 */
const DEFAULT_CC_UA = "claude-cli/2.1.888 (external, cli)";

function reqWith(
  auth: string | undefined,
  ua: string | undefined = DEFAULT_CC_UA,
): IncomingMessage {
  return {
    headers: { authorization: auth, "user-agent": ua },
  } as unknown as IncomingMessage;
}

const CTX = { hostUuid: "external-api-key", boundIp: "1.2.3.4" };

describe("apiKeyIdentity.resolve — 错误码三分", () => {
  test("无 Authorization 头 → MISSING_API_KEY", async () => {
    const spy = makeRepoSpy();
    const strat = makeApiKeyIdentityStrategy({
      repo: spy.repo,
      pricing: FAKE_PRICING,
      loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set() }),
    });
    await assert.rejects(
      strat.resolve(reqWith(undefined), CTX),
      (err: unknown) => err instanceof IdentityError && err.code === "MISSING_API_KEY",
    );
    assert.equal(spy.findByPrefixCalls.length, 0, "无 token 不应触碰 DB");
  });

  test("空字符串 / 'Bearer ' / 纯空白 → MISSING_API_KEY(三分法锁住)", async () => {
    // Codex Phase 2 code-review MINOR 采纳:有头但 token 为空仍是 missing,
    // 不归 BAD_FORMAT。这是 strategy 契约的强约束,测试要锁住具体错误码。
    const spy = makeRepoSpy();
    const strat = makeApiKeyIdentityStrategy({
      repo: spy.repo,
      pricing: FAKE_PRICING,
      loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set() }),
    });
    for (const auth of ["", "Bearer ", "Bearer    ", "   "]) {
      await assert.rejects(
        strat.resolve(reqWith(auth), CTX),
        (err: unknown) =>
          err instanceof IdentityError && err.code === "MISSING_API_KEY",
        `auth=${JSON.stringify(auth)} 应映射为 MISSING_API_KEY`,
      );
    }
    // 同时锁:这些路径不应触发 DB 查询。
    assert.strictEqual(spy.findByPrefixCalls.length, 0);
  });

  test("格式错误 → BAD_API_KEY_FORMAT,不查 DB", async () => {
    const spy = makeRepoSpy();
    const strat = makeApiKeyIdentityStrategy({
      repo: spy.repo,
      pricing: FAKE_PRICING,
      loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set() }),
    });
    for (const bad of [
      "oc-v3.abcd1234.deadbeef",                             // 错前缀(容器格式)
      "oc-cc.SHORT.deadbeef",                                // prefix 不是 [0-9a-z]{8}
      "oc-cc.ABCD1234." + "a".repeat(48),                    // 大写
      "oc-cc.abcd1234." + "a".repeat(47),                    // secret 47 hex(差 1 字)
      "oc-cc.abcd1234." + "a".repeat(49),                    // secret 49 hex
      "oc-cc.abcd1234." + "g".repeat(48),                    // secret 非 hex
      "Bearer oc-cc.abcd1234." + "a".repeat(50),             // 长度错
      "random garbage",
    ]) {
      await assert.rejects(
        strat.resolve(reqWith(bad), CTX),
        (err: unknown) =>
          err instanceof IdentityError && err.code === "BAD_API_KEY_FORMAT",
        `bad="${bad}"`,
      );
    }
    assert.equal(spy.findByPrefixCalls.length, 0, "格式错误不应触碰 DB");
  });
});

describe("apiKeyIdentity.resolve — §3.5 UA 入站门控(2026-05-19 加)", () => {
  // 不变量:
  //   - UA gate 在 token parse 之前;UA 不对 → 不查 DB
  //   - UA 不对 → 同一 API_KEY_INVALID 错误码(anti-enum,与 unknown/revoked
  //     /secret-mismatch/non-admin 不区分)
  //   - logger.warn 被调,reason='ua_mismatch'
  //   - 合法 prefix 覆盖 ant/external/firstParty + cli/vscode/sdk 各变体
  //   - 大小写不敏感(prefix `^claude-cli/` 用 /i flag)

  function makeLogSpy() {
    const calls: Array<{ event: string; ctx: unknown }> = [];
    return {
      logger: {
        warn: (event: string, ctx: unknown) => {
          calls.push({ event, ctx });
        },
      },
      calls,
    };
  }

  function buildStrat(spy: RepoSpy, logger?: Pick<import("../logging/logger.js").Logger, "warn">) {
    return makeApiKeyIdentityStrategy({
      repo: spy.repo,
      pricing: FAKE_PRICING,
      loadUserModelAuthz: async () => ({
        role: "admin",
        grantedModelIds: new Set(),
      }),
      logger,
    });
  }

  test("非 claude-cli UA → API_KEY_INVALID,不查 DB", async () => {
    const spy = makeRepoSpy();
    const strat = buildStrat(spy);
    const goodToken = "Bearer oc-cc.abcd1234." + "a".repeat(48);
    // 第 7 个 case 故意不走 reqWith 的 default 兜底,直接构造 headers
    // 不含 user-agent 字段,验证"header 缺失"也被 gate 拦(req.headers["user-agent"]
    // === undefined 这条分支)。
    const reqsWithoutUa: IncomingMessage[] = [
      reqWith(goodToken, "curl/8.4.0"),
      reqWith(goodToken, "PostmanRuntime/7.36.0"),
      reqWith(goodToken, "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"),
      reqWith(goodToken, "python-requests/2.31.0"),
      reqWith(goodToken, "claude-code/2.1.888"), // 注意:不是 claude-cli/,故意误伤防混淆
      reqWith(goodToken, ""), // 空 UA
      // 直接构造 req,headers 完全不含 user-agent 字段
      {
        headers: { authorization: goodToken },
      } as unknown as IncomingMessage,
    ];
    for (const req of reqsWithoutUa) {
      await assert.rejects(
        strat.resolve(req, CTX),
        (err: unknown) =>
          err instanceof IdentityError && err.code === "API_KEY_INVALID",
      );
    }
    assert.equal(spy.findByPrefixCalls.length, 0, "UA 不对不应触碰 DB");
  });

  test("logger.warn 在 UA 不对时被调,带 reason=ua_mismatch + uaPreview", async () => {
    const spy = makeRepoSpy();
    const logSpy = makeLogSpy();
    const strat = buildStrat(spy, logSpy.logger);
    await assert.rejects(
      strat.resolve(reqWith("Bearer oc-cc.abcd1234." + "a".repeat(48), "curl/8.4.0"), CTX),
      (err: unknown) => err instanceof IdentityError && err.code === "API_KEY_INVALID",
    );
    assert.equal(logSpy.calls.length, 1, "应记一条 server-side warn");
    assert.equal(logSpy.calls[0]!.event, "api_key_ua_gate_blocked");
    const ctx = logSpy.calls[0]!.ctx as { reason: string; uaPreview: string };
    assert.equal(ctx.reason, "ua_mismatch");
    assert.equal(ctx.uaPreview, "curl/8.4.0");
  });

  test("public error 字符串不外泄具体原因(anti-enum)— UA 不对 vs 未知 key 同 code", async () => {
    const spy = makeRepoSpy(null); // findByPrefix 永远返 null
    const strat = buildStrat(spy);
    const goodToken = "Bearer oc-cc.abcd1234." + "a".repeat(48);
    // UA 不对路径
    let uaErr: IdentityError | null = null;
    try {
      await strat.resolve(reqWith(goodToken, "curl/8.4.0"), CTX);
    } catch (e) {
      if (e instanceof IdentityError) uaErr = e;
    }
    // 未知 key 路径
    let keyErr: IdentityError | null = null;
    try {
      await strat.resolve(reqWith(goodToken, DEFAULT_CC_UA), CTX);
    } catch (e) {
      if (e instanceof IdentityError) keyErr = e;
    }
    assert.ok(uaErr && keyErr, "两路径都应抛 IdentityError");
    assert.equal(uaErr!.code, keyErr!.code, "anti-enum:错误码必须一致");
    // 注:public-facing message 由 commercial router handleError 决定;
    // 这里 IdentityError.message 是 server-internal,handler 当前只透 code。
    // 锁住的是 code 一致即可,不锁 internal message —— 它们故意不同,给运维 grep。
  });

  test("合法 UA prefix 覆盖各 USER_TYPE/ENTRYPOINT 变体 + 大小写不敏感", async () => {
    const secret = "deadbeef".repeat(6);
    const validUAs = [
      "claude-cli/2.1.888 (external, cli)",
      "claude-cli/2.1.888 (ant, vscode-ide)",
      "claude-cli/2.1.888 (firstParty, sdk, agent-sdk/1.0.0)",
      "claude-cli/2.1.888 (external, cli, workload/cron)",
      "claude-cli/0.1.0 (external, cli)", // 老版本号
      "claude-cli/99.99.99 (external, cli)", // 未来版本号
      "Claude-Cli/2.1.888 (external, cli)", // 大小写
      "CLAUDE-CLI/2.1.888", // 全大写无尾巴
      "claude-cli/2.1.888", // 无尾括号
    ];
    for (const ua of validUAs) {
      const spy = makeRepoSpy(makeRow({ id: 7n, secretHex: secret }));
      const strat = buildStrat(spy);
      const identity = await strat.resolve(
        reqWith("Bearer oc-cc.abcd1234." + secret, ua),
        CTX,
      );
      assert.equal(identity.uid, 100n, `ua=${ua} 应通过`);
    }
  });

  test("UA 不对 → 不触发 logger 之外的副作用(不 bump last_used_at)", async () => {
    const spy = makeRepoSpy(makeRow({ id: 7n, secretHex: "a".repeat(48) }));
    const strat = buildStrat(spy);
    await assert.rejects(
      strat.resolve(
        reqWith("Bearer oc-cc.abcd1234." + "a".repeat(48), "curl/8.4.0"),
        CTX,
      ),
      (err: unknown) => err instanceof IdentityError && err.code === "API_KEY_INVALID",
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(spy.touchLastUsedCalls.length, 0, "UA 不对不应 bump");
  });
});

describe("apiKeyIdentity.resolve — invariant #2 撤销立即生效 + #7 first half", () => {
  test("findByPrefix 返 null(prefix 不存在 / 已撤销)→ API_KEY_INVALID", async () => {
    const spy = makeRepoSpy(null);
    const strat = makeApiKeyIdentityStrategy({
      repo: spy.repo,
      pricing: FAKE_PRICING,
      loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set() }),
    });
    const auth = "Bearer oc-cc.abcd1234." + "a".repeat(48);
    await assert.rejects(
      strat.resolve(reqWith(auth), CTX),
      (err: unknown) => err instanceof IdentityError && err.code === "API_KEY_INVALID",
    );
    // 关键:findByPrefix 真的被查询了一次(确认走到了 DB 层,不是被静态格式拒)
    assert.equal(spy.findByPrefixCalls.length, 1);
    assert.equal(spy.findByPrefixCalls[0], "abcd1234");
    // 关键:touchLastUsed 没被调(invariant #7 first half:无副作用)
    assert.equal(spy.touchLastUsedCalls.length, 0);
  });

  test("hash 不匹配(secret 1 字节差异)→ API_KEY_INVALID,touchLastUsed 不调用", async () => {
    // 让 row.keyHash 是真实 secret 的 hash,但请求带的 secret 改一个字节
    const realSecret = "a".repeat(48);
    const fakeSecret = "b" + "a".repeat(47); // 仅首字节差异
    const spy = makeRepoSpy(makeRow({ secretHex: realSecret }));
    const strat = makeApiKeyIdentityStrategy({
      repo: spy.repo,
      pricing: FAKE_PRICING,
      loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set() }),
    });
    await assert.rejects(
      strat.resolve(reqWith("Bearer oc-cc.abcd1234." + fakeSecret), CTX),
      (err: unknown) => err instanceof IdentityError && err.code === "API_KEY_INVALID",
    );
    assert.equal(spy.touchLastUsedCalls.length, 0, "secret 错不应 bump last_used");
  });
});

describe("apiKeyIdentity.resolve — invariant #4 源码使用 timingSafeEqual", () => {
  test("源码必须显式调用 crypto.timingSafeEqual", () => {
    // 行为负例已锁(1 字节差异 → API_KEY_INVALID),此处补一颗轻 grep 钉子
    // 防"未来手滑改成 Buffer.compare/== 而行为暂时仍对"的回归窗口。
    const src = readFileSync(STRATEGY_FILE, "utf8");
    assert.match(src, /timingSafeEqual\(/, "apiKeyIdentity.ts 必须显式调用 timingSafeEqual");
  });
});

describe("apiKeyIdentity.resolve — 成功路径返 containerId=null + bump last_used", () => {
  test("正确 token + hash 匹配 → 返 {uid, containerId: null} + touchLastUsed 调用 1 次", async () => {
    const secret = "deadbeef".repeat(6); // 48 hex chars
    const spy = makeRepoSpy(makeRow({ id: 7n, userId: 200n, secretHex: secret }));
    const strat = makeApiKeyIdentityStrategy({
      repo: spy.repo,
      pricing: FAKE_PRICING,
      loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set() }),
    });
    const identity = await strat.resolve(
      reqWith("Bearer oc-cc.abcd1234." + secret),
      CTX,
    );
    assert.equal(identity.uid, 200n);
    assert.strictEqual(identity.containerId, null, "ApiKey 路径必须返 containerId=null");

    // touchLastUsed 是 fire-and-forget,需 yield 给 microtask 让 .catch chain 跑完
    // (resolve 内 await deps.repo.findByPrefix 是 await 的;touchLastUsed 是同步 Promise 链)
    await new Promise((r) => setImmediate(r));
    assert.equal(spy.touchLastUsedCalls.length, 1);
    assert.equal(spy.touchLastUsedCalls[0], 7n);
  });
});

describe("apiKeyIdentity — last_used_at 5min in-process 节流(closure scope)", () => {
  test("5min 内同 key 第 2 次 resolve → touchLastUsed 不再调用", async () => {
    const secret = "deadbeef".repeat(6);
    const spy = makeRepoSpy(makeRow({ id: 7n, secretHex: secret }));
    let fakeTime = 1_000_000;
    const strat = makeApiKeyIdentityStrategy({
      repo: spy.repo,
      pricing: FAKE_PRICING,
      loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set() }),
      now: () => fakeTime,
    });
    const req = reqWith("Bearer oc-cc.abcd1234." + secret);
    await strat.resolve(req, CTX);
    await new Promise((r) => setImmediate(r));
    assert.equal(spy.touchLastUsedCalls.length, 1);

    // 第 2 次:推进 1 分钟(< 5 min)
    fakeTime += 60_000;
    await strat.resolve(req, CTX);
    await new Promise((r) => setImmediate(r));
    assert.equal(spy.touchLastUsedCalls.length, 1, "5min 内重复 resolve 不应再次 bump");

    // 第 3 次:推进到 4 min 59 sec(仍 < 5 min)
    fakeTime += 60_000 * 3 + 59_000;
    await strat.resolve(req, CTX);
    await new Promise((r) => setImmediate(r));
    assert.equal(spy.touchLastUsedCalls.length, 1, "5min 边界内仍节流");
  });

  test("5min 过后第 2 次 resolve → touchLastUsed 再次调用", async () => {
    const secret = "deadbeef".repeat(6);
    const spy = makeRepoSpy(makeRow({ id: 7n, secretHex: secret }));
    let fakeTime = 1_000_000;
    const strat = makeApiKeyIdentityStrategy({
      repo: spy.repo,
      pricing: FAKE_PRICING,
      loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set() }),
      now: () => fakeTime,
    });
    const req = reqWith("Bearer oc-cc.abcd1234." + secret);
    await strat.resolve(req, CTX);
    await new Promise((r) => setImmediate(r));
    assert.equal(spy.touchLastUsedCalls.length, 1);

    // 推进 5 分钟整(>= 5min 触发再次 bump)
    fakeTime += 5 * 60 * 1000;
    await strat.resolve(req, CTX);
    await new Promise((r) => setImmediate(r));
    assert.equal(spy.touchLastUsedCalls.length, 2, "5min 后允许再次 bump");
  });

  test("touchLastUsed throw → strategy.resolve 不抛 + logger.warn 调用 + cache 仍写入", async () => {
    const warns: Array<{ msg: string; meta?: object }> = [];
    const secret = "deadbeef".repeat(6);
    const spy = makeRepoSpy(makeRow({ id: 99n, secretHex: secret }));
    spy.setTouchError(new Error("db down"));
    let fakeTime = 1_000_000;
    const strat = makeApiKeyIdentityStrategy({
      repo: spy.repo,
      pricing: FAKE_PRICING,
      loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set() }),
      now: () => fakeTime,
      logger: {
        warn: (msg: string, meta?: object) => warns.push({ msg, meta }),
      },
    });
    const req = reqWith("Bearer oc-cc.abcd1234." + secret);

    // resolve 不能因 touch 失败而抛
    const identity = await strat.resolve(req, CTX);
    assert.equal(identity.uid, 100n);
    await new Promise((r) => setImmediate(r));

    assert.equal(warns.length, 1);
    assert.equal(warns[0]!.msg, "api_key_touch_last_used_failed");
    assert.deepStrictEqual(warns[0]!.meta, { keyId: "99", err: "db down" });

    // cache 仍被写入(best-effort 策略:DB 抖动时继续压写,而非 5min 内狂重试)
    // 验证方法:5min 内第 2 次 resolve 仍触发 touchLastUsed 调用?
    // 不应该 — 因为我们写入 cache 锁了 5min 窗口
    fakeTime += 60_000;
    await strat.resolve(req, CTX);
    await new Promise((r) => setImmediate(r));
    assert.equal(spy.touchLastUsedCalls.length, 1, "失败后 cache 已写,5min 内不再压写");
    assert.equal(warns.length, 1, "5min 内被节流,warn 也不应再多");
  });
});

describe("apiKeyIdentity — LRU 上限 1000(closure scope 隔离)", () => {
  test("超过 1000 个 key 后,最旧 key 被驱逐 → 下次访问能再次 bump", async () => {
    const secret = "deadbeef".repeat(6);
    // 用同一 row 行为模拟,但通过 setFindByPrefixResult 切换 id 来访问不同 keyId
    const spy = makeRepoSpy(null);
    let fakeTime = 1_000_000;
    const strat = makeApiKeyIdentityStrategy({
      repo: spy.repo,
      pricing: FAKE_PRICING,
      loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set() }),
      now: () => fakeTime,
    });
    const req = reqWith("Bearer oc-cc.abcd1234." + secret);

    // 第一波:1001 个不同 keyId resolve,每次 fakeTime 递增 1ms(确保 LRU 序稳定)
    for (let i = 1; i <= 1001; i++) {
      spy.setFindByPrefixResult(makeRow({ id: BigInt(i), secretHex: secret }));
      await strat.resolve(req, CTX);
      fakeTime += 1;
    }
    await new Promise((r) => setImmediate(r));
    assert.equal(spy.touchLastUsedCalls.length, 1001, "每个 key 首次 resolve 都触发 bump");

    // 此时 LRU cap=1000,最旧 keyId(=1n)已被驱逐
    // 再次 resolve key=1n,应触发 touchLastUsed(若仍在 cache,5min 内会被节流)
    spy.setFindByPrefixResult(makeRow({ id: 1n, secretHex: secret }));
    await strat.resolve(req, CTX);
    await new Promise((r) => setImmediate(r));
    assert.equal(
      spy.touchLastUsedCalls.length,
      1002,
      "被 LRU 驱逐的 key 再次访问应再次 bump(证明 cap 生效)",
    );
  });

  test("两个 strategy 实例的节流 cache 互相隔离(closure scope 而非 module scope)", async () => {
    const secret = "deadbeef".repeat(6);
    const spyA = makeRepoSpy(makeRow({ id: 7n, secretHex: secret }));
    const spyB = makeRepoSpy(makeRow({ id: 7n, secretHex: secret }));
    const fakeTime = 1_000_000;
    const stratA = makeApiKeyIdentityStrategy({
      repo: spyA.repo,
      pricing: FAKE_PRICING,
      loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set() }),
      now: () => fakeTime,
    });
    const stratB = makeApiKeyIdentityStrategy({
      repo: spyB.repo,
      pricing: FAKE_PRICING,
      loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set() }),
      now: () => fakeTime,
    });
    const req = reqWith("Bearer oc-cc.abcd1234." + secret);

    await stratA.resolve(req, CTX);
    await stratB.resolve(req, CTX);
    await new Promise((r) => setImmediate(r));

    // 两实例都应触发各自 repo 的 touchLastUsed(若 cache 是 module scope,B 会被 A 屏蔽)
    assert.equal(spyA.touchLastUsedCalls.length, 1);
    assert.equal(spyB.touchLastUsedCalls.length, 1);
  });
});

describe("apiKeyIdentity.authorize — 委托 authorizeProxyIdentity", () => {
  test("loadUserModelAuthz throw → AuthzLoadError(cause)", async () => {
    const spy = makeRepoSpy(null);
    const cause = new Error("authz db down");
    const strat = makeApiKeyIdentityStrategy({
      repo: spy.repo,
      pricing: FAKE_PRICING,
      loadUserModelAuthz: async () => {
        throw cause;
      },
    });
    await assert.rejects(
      strat.authorize({ uid: 100n, containerId: null }, {} as never, "claude-opus-4-7"),
      (err: unknown) => err instanceof AuthzLoadError && err.cause === cause,
    );
  });

  test("canUseModel false → AuthzDeniedError(model, role)", async () => {
    // 制造一个 PricingCache stub 让 canUseModel 走 visibility 检查;
    // 最稳的方式是 mock loadUserModelAuthz 返 user role + 空 grants + visibility != public
    const spy = makeRepoSpy(null);
    const pricingStub = {
      get(_modelId: string): { enabled: boolean; visibility: string } | undefined {
        return { enabled: true, visibility: "private" };
      },
    } as unknown as PricingCache;
    const strat = makeApiKeyIdentityStrategy({
      repo: spy.repo,
      pricing: pricingStub,
      loadUserModelAuthz: async () => ({
        role: "user",
        grantedModelIds: new Set<string>(),
      }),
    });
    await assert.rejects(
      strat.authorize({ uid: 100n, containerId: null }, {} as never, "claude-opus-4-7"),
      (err: unknown) =>
        err instanceof AuthzDeniedError &&
        err.role === "user" &&
        err.modelId === "claude-opus-4-7",
    );
  });

  test("canUseModel true → 不抛", async () => {
    const spy = makeRepoSpy(null);
    const pricingStub = {
      get(_modelId: string): { enabled: boolean; visibility: string } | undefined {
        return { enabled: true, visibility: "public" };
      },
    } as unknown as PricingCache;
    const strat = makeApiKeyIdentityStrategy({
      repo: spy.repo,
      pricing: pricingStub,
      loadUserModelAuthz: async () => ({
        role: "user",
        grantedModelIds: new Set<string>(),
      }),
    });
    await assert.doesNotReject(
      strat.authorize({ uid: 100n, containerId: null }, {} as never, "claude-opus-4-7"),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 6 admin-only rollout gate(Layer 2)— resolve 内 role check
//
// 上线决策(plan §3.4):secret 验对后,fetch authz role;非 admin → 同一
// API_KEY_INVALID 错误码(anti-enumeration:不区分 "key 不存在 / 已撤销 /
// 非 admin")。bumpLastUsedThrottled 在 admin gate 之前已 fire,运营可见。
// ════════════════════════════════════════════════════════════════════════════

describe("apiKeyIdentity.resolve — Phase 6 admin-only rollout gate(Layer 2)", () => {
  test("admin role → resolve 成功,返 {uid, containerId: null}", async () => {
    const secret = "deadbeef".repeat(6);
    const spy = makeRepoSpy(makeRow({ id: 7n, userId: 200n, secretHex: secret }));
    let authzCalls = 0;
    const strat = makeApiKeyIdentityStrategy({
      repo: spy.repo,
      pricing: FAKE_PRICING,
      loadUserModelAuthz: async () => {
        authzCalls++;
        return { role: "admin", grantedModelIds: new Set() };
      },
    });
    const identity = await strat.resolve(
      reqWith("Bearer oc-cc.abcd1234." + secret),
      CTX,
    );
    assert.equal(identity.uid, 200n);
    assert.strictEqual(identity.containerId, null);
    assert.equal(authzCalls, 1, "resolve 期间应 fetch 一次 authz 做 role gate");
    // bump 也跑了
    await new Promise((r) => setImmediate(r));
    assert.equal(spy.touchLastUsedCalls.length, 1);
  });

  test("非 admin role(user)→ IdentityError API_KEY_INVALID(anti-enumeration 同型)", async () => {
    const secret = "deadbeef".repeat(6);
    const spy = makeRepoSpy(makeRow({ id: 7n, userId: 200n, secretHex: secret }));
    const strat = makeApiKeyIdentityStrategy({
      repo: spy.repo,
      pricing: FAKE_PRICING,
      loadUserModelAuthz: async () => ({ role: "user", grantedModelIds: new Set() }),
    });
    await assert.rejects(
      strat.resolve(reqWith("Bearer oc-cc.abcd1234." + secret), CTX),
      (err: unknown) =>
        err instanceof IdentityError && err.code === "API_KEY_INVALID",
    );
    // 关键:bumpLastUsedThrottled 在 admin gate 之前触发,运营可见有非 admin 用真 key
    // (Codex Phase 6 plan-review §2 确认顺序)
    await new Promise((r) => setImmediate(r));
    assert.equal(spy.touchLastUsedCalls.length, 1, "secret 已验对 → bump 在 admin gate 前 fire");
  });

  test("loadUserModelAuthz throw → 透传(非 IdentityError),不进 bump 路径意外", async () => {
    // fail-closed:authz 加载失败抛错,handler 上层(proxy/index.ts)映 500 INTERNAL,
    // 不映射为 401。这与 authorize 内的 AuthzLoadError 行为不同(authorize 内显式
    // wrap,resolve 内只是早 fail,proxy/index.ts 走 catch-all 500 路径)。
    const secret = "deadbeef".repeat(6);
    const spy = makeRepoSpy(makeRow({ id: 7n, secretHex: secret }));
    const cause = new Error("authz db down");
    const strat = makeApiKeyIdentityStrategy({
      repo: spy.repo,
      pricing: FAKE_PRICING,
      loadUserModelAuthz: async () => {
        throw cause;
      },
    });
    await assert.rejects(
      strat.resolve(reqWith("Bearer oc-cc.abcd1234." + secret), CTX),
      (err: unknown) => err === cause,
    );
    // bump 还是触发了(它在 authz fetch 之前 fire-and-forget)
    await new Promise((r) => setImmediate(r));
    assert.equal(spy.touchLastUsedCalls.length, 1);
  });

  test("不同失败路径下 bump 行为对比(unknown/revoked/secret-mismatch 不 bump;non-admin 会 bump)", async () => {
    // 这是 Codex Phase 6 plan-review §2 要求的"顺序锁":运营要靠 last_used_at
    // 区分 "有人持真 key 但 role 不对" vs "有人乱试 prefix"。
    const secret = "deadbeef".repeat(6);

    // (a) unknown prefix → 不 bump
    {
      const spy = makeRepoSpy(null);
      const strat = makeApiKeyIdentityStrategy({
        repo: spy.repo,
        pricing: FAKE_PRICING,
        loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set() }),
      });
      await assert.rejects(
        strat.resolve(reqWith("Bearer oc-cc.abcd1234." + secret), CTX),
        (err: unknown) => err instanceof IdentityError && err.code === "API_KEY_INVALID",
      );
      await new Promise((r) => setImmediate(r));
      assert.equal(spy.touchLastUsedCalls.length, 0, "unknown prefix 不 bump");
    }
    // (b) secret mismatch → 不 bump
    {
      const realSecret = "a".repeat(48);
      const wrongSecret = "b" + "a".repeat(47);
      const spy = makeRepoSpy(makeRow({ secretHex: realSecret }));
      const strat = makeApiKeyIdentityStrategy({
        repo: spy.repo,
        pricing: FAKE_PRICING,
        loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set() }),
      });
      await assert.rejects(
        strat.resolve(reqWith("Bearer oc-cc.abcd1234." + wrongSecret), CTX),
        (err: unknown) => err instanceof IdentityError && err.code === "API_KEY_INVALID",
      );
      await new Promise((r) => setImmediate(r));
      assert.equal(spy.touchLastUsedCalls.length, 0, "secret mismatch 不 bump");
    }
    // (c) secret OK + non-admin → bump(已在前面 test 单独锁,此处再次确认对比)
    {
      const spy = makeRepoSpy(makeRow({ secretHex: secret }));
      const strat = makeApiKeyIdentityStrategy({
        repo: spy.repo,
        pricing: FAKE_PRICING,
        loadUserModelAuthz: async () => ({ role: "user", grantedModelIds: new Set() }),
      });
      await assert.rejects(
        strat.resolve(reqWith("Bearer oc-cc.abcd1234." + secret), CTX),
        (err: unknown) => err instanceof IdentityError && err.code === "API_KEY_INVALID",
      );
      await new Promise((r) => setImmediate(r));
      assert.equal(spy.touchLastUsedCalls.length, 1, "secret OK + non-admin 触发 bump");
    }
  });
});
