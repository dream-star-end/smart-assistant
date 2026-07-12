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
  enforceModelAuthority,
  type CatalogSource,
} from "../http/proxy/modelAuthorityGate.js";
import {
  MODEL_CATALOG_EPOCH_PATH,
  MODEL_CATALOG_PATH,
} from "../http/internalModelCatalog.js";
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
    const { minted, keyring } = signerFor(s);
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
    });
    assert.equal(d.authorityKind, "bridge_signed");
    assert.equal(d.canonicalModel, "glm-5.2");
    assert.equal(d.executionRevision, s.executionRevision);
    assert.equal(d.securityEpoch, EPOCH);
    assert.equal(d.projectionRevision, null); // 全局 revision 不下发,bridge 路径无 per-uid 投影
    assert.equal(d.authorityTurnId, minted.payload.authorityTurnId);
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
  });

  test("长 turn:authority 已过期、lease 仍有效 → 放行(R4-M1)", async () => {
    const s = snap();
    const { minted, keyring } = signerFor(s);
    const later = Date.now() + AUTHORITY_TTL_MS + 60_000; // 超过 authority TTL,远未到 lease TTL
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
    // 计费:proxy 在 gate 之后把 body.model 归一到 d.canonicalModel,再取 pricing —— 拿到的
    // 是次级模型自己的价格行(便宜),不是主模型的。
    const auxPrice = d.snapshot.pricing.get(d.canonicalModel)!;
    const mainPrice = d.snapshot.pricing.get("glm-5.2")!;
    assert.equal(auxPrice.inputPerMtok, 101n);
    assert.equal(auxPrice.outputPerMtok, 202n);
    assert.notEqual(auxPrice.inputPerMtok, mainPrice.inputPerMtok);
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
  test("epoch 相等 → 放行,kind=local_catalog + projectionRevision 落 usage", async () => {
    const s = snap();
    const token = encodeLocalCatalogToken({
      v: 1,
      kind: "local_catalog",
      projectionRevision: "proj-rev-1",
      securityEpoch: s.securityEpoch.toString(),
    });
    const d = await enforceModelAuthority({
      catalog: source(s),
      keyring: null, // 本地路径不需要 keyring(token 无签名,只承载 epoch)
      headers: headers({ [LOCAL_CATALOG_HEADER]: token }),
      uid: UID,
      containerId: CONTAINER_ID,
      model: "glm-5.2",
    });
    assert.equal(d.authorityKind, "local_catalog");
    assert.equal(d.projectionRevision, "proj-rev-1");
    assert.equal(d.securityEpoch, s.securityEpoch);
  });

  test("epoch 漂移 → MODEL_CONFIG_CHANGED_RETRY_TURN(容器快照旧了)", async () => {
    const s = snap(6n);
    const token = encodeLocalCatalogToken({
      v: 1,
      kind: "local_catalog",
      projectionRevision: "proj-rev-1",
      securityEpoch: "5",
    });
    await expectReject(
      enforceModelAuthority({
        catalog: source(s),
        keyring: null,
        headers: headers({ [LOCAL_CATALOG_HEADER]: token }),
        uid: UID,
        containerId: CONTAINER_ID,
        model: "glm-5.2",
      }),
      "MODEL_CONFIG_CHANGED_RETRY_TURN",
    );
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
