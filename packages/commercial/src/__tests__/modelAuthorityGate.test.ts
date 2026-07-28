/**
 * 模型权威批次 · 切片 5/6 —— egress 侧每请求 fence + authority 校验(http/proxy/modelAuthorityGate.ts)。
 *
 * 跑法:npx tsx --test packages/commercial/src/__tests__/modelAuthorityGate.test.ts
 *
 * 覆盖(方案 §4 + §8 测试清单):
 *   - 每个独立请求都做一次 epoch fence(单行 SELECT;不做时间缓存 → 调用次数 == 请求数)
 *   - epoch 漂移 → MODEL_CONFIG_CHANGED_RETRY_TURN(R3-m12)
 *   - executionRevision 漂移(master 新 / egress 旧)→ 同码拒(R4-m6)
 *   - 伪造签名 / 换 keyring / 篡改字段 → MODEL_AUTHORITY_INVALID
 *   - body.model ≠ descriptor.canonicalModel → 拒(计费与执行分裂的形状)
 *   - uid / containerId 不匹配 → 拒(跨用户、跨容器复用票据)
 *   - 长 turn:authority 过期但 lease 有效 → 放行(R4-M1);lease 与 authority 不同 turn → 拒
 *   - 本地路径 local_catalog token:epoch 相等放行 / 漂移拒;无凭据 → 拒
 *   - **projectionRevision 由服务端按 uid 的 role/grants 重算**(R1 MAJOR-7):容器自铸 token 里的
 *     值只作比对(不一致 → 告警),绝不落库;authz 读不到 → fail-closed 503
 *   - 不可路由(非 active / codex engine)→ MODEL_NOT_AVAILABLE
 *   - **跨包 header/kind 常量 parity**(容器侧 gateway/modelCatalogClient 是同一份 wire 契约)
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AUTHORITY_HEADER as GW_AUTHORITY_HEADER,
  DEFAULT_SECONDARY_UTILITY_MODEL,
  LOCAL_CATALOG_HEADER as GW_LOCAL_CATALOG_HEADER,
  LOCAL_CATALOG_KIND as GW_LOCAL_CATALOG_KIND,
  MODEL_CATALOG_EPOCH_PATH as GW_CATALOG_EPOCH_PATH,
  MODEL_CATALOG_PATH as GW_CATALOG_PATH,
  TURN_LEASE_HEADER as GW_TURN_LEASE_HEADER,
} from "@openclaude/gateway";
import { AUTHORITY_TTL_MS } from "@openclaude/protocol";

import {
  ModelCatalogSnapshot,
  platformAuxModels,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
} from "../billing/modelCatalog.js";
import {
  AUTHORITY_HEADER,
  LOCAL_CATALOG_HEADER,
  LOCAL_CATALOG_KIND,
  ModelGateReject,
  TURN_LEASE_HEADER,
  encodeLocalCatalogToken,
  enforceModelAuthority as enforceModelAuthorityRaw,
  type CatalogSource,
  type EnforceArgs,
} from "../http/proxy/modelAuthorityGate.js";
import {
  MODEL_CATALOG_EPOCH_PATH,
  MODEL_CATALOG_PATH,
} from "../http/internalModelCatalog.js";
import type { UserModelAuthz } from "../auth/userModelAuthz.js";
import type { Logger } from "../logging/logger.js";
import { AuthoritySigner } from "../ws/authoritySigner.js";

// ─── fixtures ────────────────────────────────────────────────────────────

const UID = 42n;
const CONTAINER_ID = 7n;
const CHALLENGE = "chal-abc";
const EPOCH = 5n;

function entry(over: Partial<ModelCatalogEntry> & Pick<ModelCatalogEntry, "entryId" | "modelId">): ModelCatalogEntry {
  return {
    engine: "ccb",
    providerId: "ark",
    upstreamModelId: null,
    contextWindow: 1_000_000,
    capabilityProfile: {
      supportsVision: false,
      reasoning: { supported: ["high", "max"], codexModelDefault: null },
      ccb: { capabilityZero: true, supportsThinking: true },
    },
    capabilitySchemaVersion: 1,
    state: "active",
    lockVersion: 0,
    ...over,
  };
}

function price(modelId: string, over: Partial<ModelCatalogPricing> = {}): ModelCatalogPricing {
  return {
    modelId,
    displayName: modelId,
    inputPerMtok: 600n,
    outputPerMtok: 2400n,
    cacheReadPerMtok: 120n,
    cacheWritePerMtok: 0n,
    multiplier: "1.000",
    visibility: "public",
    sortOrder: 100,
    defaultEffort: null,
    ...over,
  };
}

const GLM = entry({ entryId: 1, modelId: "glm-5.2" });
const SOL = entry({
  entryId: 2,
  modelId: "gpt-5.6-sol",
  engine: "codex",
  providerId: "codex",
  contextWindow: null,
  capabilityProfile: {
    supportsVision: false,
    reasoning: { supported: ["low", "high"], codexModelDefault: "high" },
    ccb: { capabilityZero: false, supportsThinking: false },
  },
});
const DISABLED = entry({ entryId: 3, modelId: "glm-5.1", state: "disabled" });
/**
 * 平台次级模型(PLATFORM_AUX_MODEL_IDS 的唯一成员;权威源 = gateway
 * DEFAULT_SECONDARY_UTILITY_MODEL,即容器 ANTHROPIC_SMALL_FAST_MODEL 的实际取值)。
 * 故意给它**不同的 provider + 不同的价格**:据此断言 aux 请求按自己的行路由/计费,
 * 而不是被主模型的 descriptor 顶替。
 */
const FLASH = entry({
  entryId: 4,
  modelId: DEFAULT_SECONDARY_UTILITY_MODEL,
  providerId: "deepseek",
  contextWindow: 1_000_000,
});

function snap(epoch = EPOCH, over: { entries?: ModelCatalogEntry[] } = {}): ModelCatalogSnapshot {
  return new ModelCatalogSnapshot({
    entries: over.entries ?? [GLM, SOL, DISABLED, FLASH],
    aliases: new Map([["glm-latest", 1]]),
    pricing: new Map(
      [
        price("glm-5.2"),
        price("gpt-5.6-sol"),
        price("glm-5.1"),
        // 次级模型的真实定价行(便宜得多)—— 计费必须按它,不按 glm-5.2。
        price(DEFAULT_SECONDARY_UTILITY_MODEL, {
          inputPerMtok: 101n,
          outputPerMtok: 202n,
          cacheReadPerMtok: 3n,
        }),
      ].map((p) => [p.modelId, p]),
    ),
    securityEpoch: epoch,
  });
}

/**
 * 带一行 **visibility='admin'** 模型的快照 —— per-uid 投影只有在存在"不是人人可见"的行时
 * 才会随 role/grants 变化(全 public 的 snap() 下 user 与 admin 投影恒等,断不出差异)。
 */
function snapWithAdminModel(epoch = EPOCH): ModelCatalogSnapshot {
  const HAIKU = entry({ entryId: 9, modelId: "claude-haiku-4-5", providerId: null });
  return new ModelCatalogSnapshot({
    entries: [GLM, SOL, DISABLED, FLASH, HAIKU],
    aliases: new Map([["glm-latest", 1]]),
    pricing: new Map(
      [
        price("glm-5.2"),
        price("gpt-5.6-sol"),
        price("glm-5.1"),
        price(DEFAULT_SECONDARY_UTILITY_MODEL),
        price("claude-haiku-4-5", { visibility: "admin" }),
      ].map((p) => [p.modelId, p]),
    ),
    securityEpoch: epoch,
  });
}

/**
 * role + grants 的服务端权威桩(本地路径重算 projectionRevision 用)。
 * **必须显式注入**:不注入 gate 会用进程级默认 loader → 真连 DB。
 */
function authzLoader(authz: UserModelAuthz): (uid: bigint) => Promise<UserModelAuthz> {
  return async () => authz;
}

/** 大多数凭据测试用 public 模型 + 普通用户；关注 authz 的用例可显式覆盖 loader。 */
function enforceModelAuthority(args: EnforceArgs) {
  return enforceModelAuthorityRaw({
    loadUserModelAuthz: authzLoader({ role: "user", grantedModelIds: new Set() }),
    ...args,
  });
}

/** 收集 warn 的 logger 桩(projectionRevision 不一致的告警从这里出)。 */
function silentLogger(
  warns: Array<{ msg: string; fields?: Record<string, unknown> }> = [],
): Logger {
  const log: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn(msg, fields) {
      warns.push({ msg, fields });
    },
    error() {},
    child() {
      return log;
    },
  };
  return log;
}

/** 计数版 CatalogSource:断言"每请求一次 fence"。 */
function source(s: ModelCatalogSnapshot): CatalogSource & { calls: number } {
  const src = {
    calls: 0,
    async assertFresh() {
      src.calls += 1;
      return s;
    },
  };
  return src;
}

function signerFor(snapshot: ModelCatalogSnapshot, over: Partial<Parameters<AuthoritySigner["signBundle"]>[0]> = {}, opts?: Parameters<AuthoritySigner["signBundle"]>[1]) {
  const signer = AuthoritySigner.createEphemeral();
  const descriptor = snapshot.resolve("glm-5.2")!;
  const minted = signer.signBundle(
    {
      uid: Number(UID),
      containerId: Number(CONTAINER_ID),
      connectionChallenge: CHALLENGE,
      canonicalModel: descriptor.canonicalModel,
      engine: descriptor.engine,
      executionDescriptor: {
        capabilityProfile: { supports_vision: false },
        capabilitySchemaVersion: descriptor.capabilitySchemaVersion,
        contextWindow: descriptor.contextWindow ?? 0,
        supportedEfforts: [...descriptor.capabilityProfile.reasoning.supported],
        supportsVision: descriptor.capabilityProfile.supportsVision,
      },
      executionRevision: snapshot.executionRevision,
      securityEpoch: Number(snapshot.securityEpoch),
      auxModels: platformAuxModels(snapshot),
      ...over,
    },
    opts,
  );
  return { signer, minted, keyring: signer.publicKeyring() };
}

function headers(h: Record<string, string | string[]>): Record<string, string | string[]> {
  return h;
}

async function expectReject(p: Promise<unknown>, code: string): Promise<ModelGateReject> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof ModelGateReject, `expected ModelGateReject, got ${String(err)}`);
  assert.equal(err.code, code, `detail=${err.detail}`);
  return err;
}

// ─── wire 契约 parity(commercial fence ↔ gateway client)──────────────────

describe("modelAuthorityGate — 跨包 wire 契约 parity", () => {
  test("header / kind / path 常量两侧同值(任一侧改名 = 生产上凭据静默失联)", () => {
    assert.equal(AUTHORITY_HEADER, GW_AUTHORITY_HEADER);
    assert.equal(TURN_LEASE_HEADER, GW_TURN_LEASE_HEADER);
    assert.equal(LOCAL_CATALOG_HEADER, GW_LOCAL_CATALOG_HEADER);
    assert.equal(LOCAL_CATALOG_KIND, GW_LOCAL_CATALOG_KIND);
    assert.equal(MODEL_CATALOG_PATH, GW_CATALOG_PATH);
    assert.equal(MODEL_CATALOG_EPOCH_PATH, GW_CATALOG_EPOCH_PATH);
  });
});

// ─── fence ───────────────────────────────────────────────────────────────

describe("modelAuthorityGate — 每请求 epoch fence", () => {
  test("每个请求都做一次 fence(无时间缓存:3 个请求 = 3 次 assertFresh)", async () => {
    const s = snap();
    const src = source(s);
    const { minted, keyring } = signerFor(s);
    for (let i = 0; i < 3; i++) {
      await enforceModelAuthority({
        catalog: src,
        keyring,
        headers: headers({ [TURN_LEASE_HEADER]: minted.bundle.lease }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
      });
    }
    assert.equal(src.calls, 3);
  });

  test("epoch 漂移(票据 epoch < DB/快照 epoch)→ MODEL_CONFIG_CHANGED_RETRY_TURN", async () => {
    const oldSnap = snap(5n);
    const { minted, keyring } = signerFor(oldSnap); // 票据按 epoch=5 签
    const newSnap = snap(6n); // 安全变更后:epoch bump
    await expectReject(
      enforceModelAuthority({
        catalog: source(newSnap),
        keyring,
        headers: headers({ [AUTHORITY_HEADER]: minted.bundle.authority }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
      }),
      "MODEL_CONFIG_CHANGED_RETRY_TURN",
    );
  });

  test("executionRevision 漂移(签发方与本进程快照不一致)→ 同码拒(R4-m6)", async () => {
    const s = snap();
    const { minted, keyring } = signerFor(s, { executionRevision: "f".repeat(64) });
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring,
        headers: headers({ [AUTHORITY_HEADER]: minted.bundle.authority }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
      }),
      "MODEL_CONFIG_CHANGED_RETRY_TURN",
    );
  });

  test("快照 unknown / DB 不可达 → MODEL_CATALOG_UNAVAILABLE(fail-closed)", async () => {
    const failing: CatalogSource = {
      async assertFresh() {
        throw new Error("connection refused");
      },
    };
    await expectReject(
      enforceModelAuthority({
        catalog: failing,
        keyring: null,
        headers: headers({}),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
      }),
      "MODEL_CATALOG_UNAVAILABLE",
    );
  });
});

// ─── bridge authority ────────────────────────────────────────────────────

describe("modelAuthorityGate — bridge 签名凭据", () => {
  test("合法 authority + lease → 放行,kind=bridge_signed,带 executionRevision/epoch", async () => {
    const s = snap();
    const issuedAt = 1_800_000_000_000;
    const verifiedAt = issuedAt + 1234;
    const { minted, keyring } = signerFor(s, {}, { now: issuedAt });
    const d = await enforceModelAuthority({
      catalog: source(s),
      keyring,
      headers: headers({
        [AUTHORITY_HEADER]: minted.bundle.authority,
        [TURN_LEASE_HEADER]: minted.bundle.lease,
      }),
      uid: UID,
      containerId: CONTAINER_ID,
      model: "glm-5.2",
      now: verifiedAt,
    });
    assert.equal(d.authorityKind, "bridge_signed");
    assert.equal(d.canonicalModel, "glm-5.2");
    assert.equal(d.executionRevision, s.executionRevision);
    assert.equal(d.securityEpoch, EPOCH);
    assert.equal(d.projectionRevision, null); // 全局 revision 不下发,bridge 路径无 per-uid 投影
    assert.equal(d.authorityTurnId, minted.payload.authorityTurnId);
    assert.equal(d.turnLeaseIssuedAtMs, issuedAt);
    assert.equal(d.turnLeaseVerifiedAtMs, verifiedAt);
    assert.equal(d.descriptor.providerId, "ark");
  });

  test("alias 归一:请求 glm-latest,票据签的是 canonical glm-5.2 → 放行且 canonical 落地", async () => {
    const s = snap();
    const { minted, keyring } = signerFor(s);
    const d = await enforceModelAuthority({
      catalog: source(s),
      keyring,
      headers: headers({ [AUTHORITY_HEADER]: minted.bundle.authority }),
      uid: UID,
      containerId: CONTAINER_ID,
      model: "glm-latest",
    });
    assert.equal(d.canonicalModel, "glm-5.2");
    assert.equal(d.turnLeaseIssuedAtMs, null);
    assert.equal(d.turnLeaseVerifiedAtMs, null);
  });

  test("长 turn:authority 已过期、lease 仍有效 → 放行(R4-M1)", async () => {
    const s = snap();
    const issuedAt = 1_800_000_000_000;
    const { minted, keyring } = signerFor(s, {}, { now: issuedAt });
    const later = issuedAt + AUTHORITY_TTL_MS + 60_000; // 超过 authority TTL,远未到 lease TTL
    const d = await enforceModelAuthority({
      catalog: source(s),
      keyring,
      headers: headers({ [TURN_LEASE_HEADER]: minted.bundle.lease }),
      uid: UID,
      containerId: CONTAINER_ID,
      model: "glm-5.2",
      now: later,
    });
    assert.equal(d.authorityKind, "bridge_signed");
    assert.equal(d.turnLeaseIssuedAtMs, issuedAt);
    assert.equal(d.turnLeaseVerifiedAtMs, later);
    // 同一时刻带**过期的 authority** → 必须拒(不能"有 lease 就不看 authority 的过期")
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring,
        headers: headers({
          [AUTHORITY_HEADER]: minted.bundle.authority,
          [TURN_LEASE_HEADER]: minted.bundle.lease,
        }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
        now: later,
      }),
      "MODEL_AUTHORITY_INVALID",
    );
  });

  test("lease 与 authority 属于不同 turn → LeaseMismatch 拒(跨 turn 降级攻击面)", async () => {
    const s = snap();
    const a = signerFor(s);
    const b = a.signer.signBundle({
      uid: Number(UID),
      containerId: Number(CONTAINER_ID),
      connectionChallenge: CHALLENGE,
      canonicalModel: "glm-5.2",
      engine: "ccb",
      executionDescriptor: {
        capabilityProfile: {},
        capabilitySchemaVersion: 1,
        contextWindow: 1_000_000,
        supportedEfforts: ["high", "max"],
        supportsVision: false,
      },
      executionRevision: s.executionRevision,
      securityEpoch: Number(s.securityEpoch),
      auxModels: platformAuxModels(s),
    });
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring: a.keyring,
        headers: headers({
          [AUTHORITY_HEADER]: a.minted.bundle.authority,
          [TURN_LEASE_HEADER]: b.bundle.lease, // 另一个 turn 的 lease
        }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
      }),
      "MODEL_AUTHORITY_INVALID",
    );
  });

  test("伪造签名(另一把私钥)→ UnknownKey/VerifyFail 拒", async () => {
    const s = snap();
    const legit = signerFor(s);
    const attacker = signerFor(s); // 另一个 ephemeral signer:keyId 与公钥都不同
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring: legit.keyring, // 只信 legit 的公钥
        headers: headers({ [AUTHORITY_HEADER]: attacker.minted.bundle.authority }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
      }),
      "MODEL_AUTHORITY_INVALID",
    );
  });

  test("body.model 与票据 canonicalModel 不符 → 拒(计费/执行分裂)", async () => {
    const s = snap();
    const { minted, keyring } = signerFor(s);
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring,
        headers: headers({ [AUTHORITY_HEADER]: minted.bundle.authority }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "gpt-5.6-sol", // 票据签的是 glm-5.2
      }),
      // codex engine 先被"不该走本代理"拦下 —— 断言拒绝本身即可(两条都 fail-closed)
      "MODEL_NOT_AVAILABLE",
    );
    // 换一个 ccb 模型作为不符对象:用 alias 指向的另一个 active ccb 行不存在,故直接改
    // 票据的 canonicalModel 来制造不符。
    const wrong = signerFor(s, { canonicalModel: "glm-5.1" });
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring: wrong.keyring,
        headers: headers({ [AUTHORITY_HEADER]: wrong.minted.bundle.authority }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
      }),
      "MODEL_AUTHORITY_INVALID",
    );
  });

  test("uid / containerId 不匹配 → 拒(跨用户 / 跨容器复用票据)", async () => {
    const s = snap();
    const { minted, keyring } = signerFor(s);
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring,
        headers: headers({ [AUTHORITY_HEADER]: minted.bundle.authority }),
        uid: 999n,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
      }),
      "MODEL_AUTHORITY_INVALID",
    );
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring,
        headers: headers({ [AUTHORITY_HEADER]: minted.bundle.authority }),
        uid: UID,
        containerId: 999n,
        model: "glm-5.2",
      }),
      "MODEL_AUTHORITY_INVALID",
    );
  });

  test("keyring 未装配 → bridge 凭据一律拒(不退化成信裸 header)", async () => {
    const s = snap();
    const { minted } = signerFor(s);
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring: null,
        headers: headers({ [AUTHORITY_HEADER]: minted.bundle.authority }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
      }),
      "MODEL_AUTHORITY_INVALID",
    );
  });

  test("同名 header 出现多次(数组)→ 拒(不做取第一个的宽容解析)", async () => {
    const s = snap();
    const { minted, keyring } = signerFor(s);
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring,
        headers: headers({ [AUTHORITY_HEADER]: [minted.bundle.authority, "x"] }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
      }),
      "MODEL_AUTHORITY_INVALID",
    );
  });
});

// ─── 本地路径 ─────────────────────────────────────────────────────────────

// ─── 次级模型放行集(BLOCKER 2026-07-12)──────────────────────────────────

describe("modelAuthorityGate — auxModels 次级模型", () => {
  test("aux 模型(WebFetch/WebSearch 的 ANTHROPIC_SMALL_FAST_MODEL)→ 放行", async () => {
    const s = snap();
    const { minted, keyring } = signerFor(s); // 主模型 glm-5.2 + aux=[deepseek-v4-flash]
    const d = await enforceModelAuthority({
      catalog: source(s),
      keyring,
      headers: headers({ [AUTHORITY_HEADER]: minted.bundle.authority }),
      uid: UID,
      containerId: CONTAINER_ID,
      model: DEFAULT_SECONDARY_UTILITY_MODEL,
    });
    assert.equal(d.canonicalModel, DEFAULT_SECONDARY_UTILITY_MODEL);
    assert.equal(d.authorityKind, "bridge_signed");
  });

  test("aux 请求按**自己的行**路由与计费,不被主模型 descriptor 顶替", async () => {
    const s = snap();
    const { minted, keyring } = signerFor(s);
    const d = await enforceModelAuthority({
      catalog: source(s),
      keyring,
      headers: headers({ [AUTHORITY_HEADER]: minted.bundle.authority }),
      uid: UID,
      containerId: CONTAINER_ID,
      model: DEFAULT_SECONDARY_UTILITY_MODEL,
    });
    // descriptor = 次级模型自己的 catalog 行(provider/上游都不是主模型的)
    assert.equal(d.descriptor.canonicalModel, DEFAULT_SECONDARY_UTILITY_MODEL);
    assert.equal(d.descriptor.providerId, "deepseek");
    assert.notEqual(d.descriptor.providerId, s.resolve("glm-5.2")!.providerId);
    // 计费:proxy 在 gate 后直接投影**这个 fenced snapshot**的次级模型价格；不回读
    // 另一 generation 的 PricingCache，也不会被主模型价格顶替。
    const auxPrice = d.snapshot.billingPricingFor(d.canonicalModel)!;
    const mainPrice = d.snapshot.billingPricingFor("glm-5.2")!;
    assert.equal(auxPrice.input_per_mtok, 101n);
    assert.equal(auxPrice.output_per_mtok, 202n);
    assert.notEqual(auxPrice.input_per_mtok, mainPrice.input_per_mtok);
  });

  test("集合外的模型 → 仍拒 MODEL_AUTHORITY_INVALID(放行集不是'任意模型')", async () => {
    const s = snap();
    // 票据只签了主模型,aux 显式为空 —— 模拟"未声明次级模型"的 turn
    const { minted, keyring } = signerFor(s, { auxModels: [] });
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring,
        headers: headers({ [AUTHORITY_HEADER]: minted.bundle.authority }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: DEFAULT_SECONDARY_UTILITY_MODEL,
      }),
      "MODEL_AUTHORITY_INVALID",
    );
  });

  test("turn 内后续请求只带 lease(authority 已过期)→ aux 同样放行(R4-M1 + WebFetch 在 turn 中段)", async () => {
    const s = snap();
    const t0 = 1_800_000_000_000;
    const { minted, keyring } = signerFor(s, {}, { now: t0 });
    const later = t0 + AUTHORITY_TTL_MS + 10 * 60_000; // authority 早过期,lease 仍在
    const d = await enforceModelAuthority({
      catalog: source(s),
      keyring,
      headers: headers({ [TURN_LEASE_HEADER]: minted.bundle.lease }),
      uid: UID,
      containerId: CONTAINER_ID,
      model: DEFAULT_SECONDARY_UTILITY_MODEL,
      now: later,
    });
    assert.equal(d.canonicalModel, DEFAULT_SECONDARY_UTILITY_MODEL);
    assert.equal(d.authorityKind, "bridge_signed");
  });

  test("aux 模型被 disable → 主模型仍放行,aux 请求 MODEL_NOT_AVAILABLE(可路由性先于验票)", async () => {
    // 票据在 aux 还 active 时签发;随后 aux 行被 disable(epoch 会 bump,这里只验可路由性门)
    const before = snap();
    const { minted, keyring } = signerFor(before);
    const after = snap(EPOCH, {
      entries: [GLM, SOL, DISABLED, entry({ ...FLASH, state: "disabled" })],
    });
    await expectReject(
      enforceModelAuthority({
        catalog: source(after),
        keyring,
        headers: headers({ [AUTHORITY_HEADER]: minted.bundle.authority }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: DEFAULT_SECONDARY_UTILITY_MODEL,
      }),
      "MODEL_NOT_AVAILABLE",
    );
  });
});

describe("modelAuthorityGate — 本地路径 local_catalog token", () => {
  test("epoch 相等 → 放行,kind=local_catalog;projectionRevision **服务端重算**", async () => {
    const s = snap();
    const expected = s.projectionRevisionFor({
      uid: UID.toString(),
      role: "user",
      grantedModelIds: new Set(),
    });
    const token = encodeLocalCatalogToken({
      v: 1,
      kind: "local_catalog",
      projectionRevision: expected,
      securityEpoch: s.securityEpoch.toString(),
    });
    const d = await enforceModelAuthority({
      catalog: source(s),
      keyring: null, // 本地路径不需要 keyring(token 无签名,只承载 epoch)
      headers: headers({ [LOCAL_CATALOG_HEADER]: token }),
      uid: UID,
      containerId: CONTAINER_ID,
      model: "glm-5.2",
      loadUserModelAuthz: authzLoader({ role: "user", grantedModelIds: new Set() }),
      logger: silentLogger(),
    });
    assert.equal(d.authorityKind, "local_catalog");
    assert.equal(d.securityEpoch, s.securityEpoch);
    // 落库的那一份 = 按已认证 uid 的当前 role/grants + 本请求快照重算(与 /internal/v3/model-catalog 同源)
    assert.equal(d.projectionRevision, expected);
    assert.equal(d.claimedProjectionRevision, expected);
    assert.equal(d.turnLeaseIssuedAtMs, null);
    assert.equal(d.turnLeaseVerifiedAtMs, null);
  });

  test("visibility 授权取 fenced snapshot：旧 PricingCache 即使仍 public 也不能放行 admin 模型", async () => {
    const s = snapWithAdminModel();
    const authz = { role: "user" as const, grantedModelIds: new Set<string>() };
    const token = encodeLocalCatalogToken({
      v: 1,
      kind: "local_catalog",
      projectionRevision: s.projectionRevisionFor({ uid: UID.toString(), ...authz }),
      securityEpoch: s.securityEpoch.toString(),
    });
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring: null,
        headers: headers({ [LOCAL_CATALOG_HEADER]: token }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "claude-haiku-4-5",
        loadUserModelAuthz: authzLoader(authz),
      }),
      "MODEL_NOT_AVAILABLE",
    );
  });

  test("account hard denial 在 egress gate 生效，且 projection revision 按同一 denial 重算", async () => {
    const s = snap();
    const authz = {
      role: "user" as const,
      grantedModelIds: new Set<string>(),
      deniedModelIds: new Set(["glm-5.2"]),
    };
    const token = encodeLocalCatalogToken({
      v: 1,
      kind: "local_catalog",
      projectionRevision: s.projectionRevisionFor({ uid: UID.toString(), ...authz }),
      securityEpoch: s.securityEpoch.toString(),
    });
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring: null,
        headers: headers({ [LOCAL_CATALOG_HEADER]: token }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
        loadUserModelAuthz: authzLoader(authz),
      }),
      "MODEL_NOT_AVAILABLE",
    );
  });

  test("伪造 projectionRevision(冒充 admin 投影)不改变落库值,且打不一致告警", async () => {
    const s = snapWithAdminModel();
    // 攻击者拿 admin 投影的 hash 塞进 token,想让审计看起来像"在 admin 投影下消费"。
    const adminRevision = s.projectionRevisionFor({
      uid: UID.toString(),
      role: "admin",
      grantedModelIds: new Set(),
    });
    const token = encodeLocalCatalogToken({
      v: 1,
      kind: "local_catalog",
      projectionRevision: adminRevision,
      securityEpoch: s.securityEpoch.toString(),
    });
    const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const userRevision = s.projectionRevisionFor({
      uid: UID.toString(),
      role: "user",
      grantedModelIds: new Set(),
    });
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring: null,
        headers: headers({ [LOCAL_CATALOG_HEADER]: token }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
        loadUserModelAuthz: authzLoader({ role: "user", grantedModelIds: new Set() }),
        logger: silentLogger(warns),
      }),
      "MODEL_CONFIG_CHANGED_RETRY_TURN",
    );
    // grant 写统一 bump epoch 后，同 epoch 的 projection 不一致只能是伪造/陈旧，立即拒。
    assert.equal(warns.length, 1);
    assert.equal(warns[0].msg, "local_catalog_projection_revision_mismatch");
    assert.equal(warns[0].fields?.claimed, adminRevision.slice(0, 12));
    assert.equal(warns[0].fields?.computed, userRevision.slice(0, 12));
  });

  test("token 值与服务端重算一致 → 无告警", async () => {
    const s = snap();
    const authz = { role: "user" as const, grantedModelIds: new Set<string>() };
    const token = encodeLocalCatalogToken({
      v: 1,
      kind: "local_catalog",
      projectionRevision: s.projectionRevisionFor({ uid: UID.toString(), ...authz }),
      securityEpoch: s.securityEpoch.toString(),
    });
    const warns: Array<{ msg: string }> = [];
    await enforceModelAuthority({
      catalog: source(s),
      keyring: null,
      headers: headers({ [LOCAL_CATALOG_HEADER]: token }),
      uid: UID,
      containerId: CONTAINER_ID,
      model: "glm-5.2",
      loadUserModelAuthz: authzLoader(authz),
      logger: silentLogger(warns),
    });
    assert.equal(warns.length, 0);
  });

  test("grants 变了 → 重算值随之变(投影 revision 绑 role/grants,不绑容器自称)", async () => {
    const s = snapWithAdminModel();
    const userAuthz = { role: "user" as const, grantedModelIds: new Set<string>() };
    const adminAuthz = { role: "admin" as const, grantedModelIds: new Set<string>() };
    const tokenFor = (projectionRevision: string) => encodeLocalCatalogToken({
      v: 1, kind: "local_catalog", projectionRevision, securityEpoch: s.securityEpoch.toString(),
    });
    const asUser = await enforceModelAuthority({
      catalog: source(s),
      keyring: null,
      headers: headers({ [LOCAL_CATALOG_HEADER]: tokenFor(s.projectionRevisionFor({ uid: UID.toString(), ...userAuthz })) }),
      uid: UID, containerId: CONTAINER_ID, model: "glm-5.2", logger: silentLogger(),
      loadUserModelAuthz: authzLoader(userAuthz),
    });
    const asAdmin = await enforceModelAuthority({
      catalog: source(s),
      keyring: null,
      headers: headers({ [LOCAL_CATALOG_HEADER]: tokenFor(s.projectionRevisionFor({ uid: UID.toString(), ...adminAuthz })) }),
      uid: UID, containerId: CONTAINER_ID, model: "glm-5.2", logger: silentLogger(),
      loadUserModelAuthz: authzLoader(adminAuthz),
    });
    assert.notEqual(asUser.projectionRevision, asAdmin.projectionRevision);
  });

  test("role/grants 读不到(DB 抖)→ 503 MODEL_CATALOG_UNAVAILABLE(fail-closed,不退回 token 自称值)", async () => {
    const s = snap();
    const token = encodeLocalCatalogToken({
      v: 1,
      kind: "local_catalog",
      projectionRevision: "proj-rev-1",
      securityEpoch: s.securityEpoch.toString(),
    });
    const err = await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring: null,
        headers: headers({ [LOCAL_CATALOG_HEADER]: token }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
        loadUserModelAuthz: async () => {
          throw new Error("PG down");
        },
        logger: silentLogger(),
      }),
      "MODEL_CATALOG_UNAVAILABLE",
    );
    assert.equal(err.status, 503);
  });

  test("epoch 漂移 → MODEL_CONFIG_CHANGED_RETRY_TURN(容器快照旧了;此时不该去读 authz)", async () => {
    const s = snap(6n);
    const token = encodeLocalCatalogToken({
      v: 1,
      kind: "local_catalog",
      projectionRevision: "proj-rev-1",
      securityEpoch: "5",
    });
    let authzCalls = 0;
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring: null,
        headers: headers({ [LOCAL_CATALOG_HEADER]: token }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
        loadUserModelAuthz: async () => {
          authzCalls += 1;
          return { role: "user" as const, grantedModelIds: new Set<string>() };
        },
        logger: silentLogger(),
      }),
      "MODEL_CONFIG_CHANGED_RETRY_TURN",
    );
    assert.equal(authzCalls, 0);
  });

  test("token 形状非法 / 伪装成 bridge kind → 拒", async () => {
    const s = snap();
    const bogus = Buffer.from(
      JSON.stringify({ v: 1, kind: "model_authority", projectionRevision: "x", securityEpoch: "5" }),
      "utf8",
    ).toString("base64url");
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring: null,
        headers: headers({ [LOCAL_CATALOG_HEADER]: bogus }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
      }),
      "MODEL_AUTHORITY_INVALID",
    );
  });

  test("无任何凭据 → 拒(enforce 期不存在裸请求)", async () => {
    const s = snap();
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring: null,
        headers: headers({}),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
      }),
      "MODEL_AUTHORITY_INVALID",
    );
  });
});

// ─── 可路由性 ─────────────────────────────────────────────────────────────

describe("modelAuthorityGate — 可路由性(fence 之后、验票之前)", () => {
  test("非 active 行(disabled)→ MODEL_NOT_AVAILABLE,且不回显 engine/provider", async () => {
    const s = snap();
    const err = await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring: null,
        headers: headers({}),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.1", // disabled
      }),
      "MODEL_NOT_AVAILABLE",
    );
    assert.equal(err.clientMessage, "model not available");
    assert.doesNotMatch(err.clientMessage, /ark|ccb|glm/);
  });

  test("codex engine 不走 anthropic proxy → MODEL_NOT_AVAILABLE", async () => {
    const s = snap();
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring: null,
        headers: headers({}),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "gpt-5.6-sol",
      }),
      "MODEL_NOT_AVAILABLE",
    );
  });
});
