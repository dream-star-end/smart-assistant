/**
 * internalPlatformPromptSlots — master 端 platform prompt slot endpoint 单测。
 *
 * 设计契约(改前先改测试):
 *   - 容器身份双因子校验(同 literatureProxy / anthropicProxy):identity 失败 → 401
 *   - 非 GET → 405,无 side-effect
 *   - SKILLS_LITERATURE:
 *       cfg.enabled=false → 不 emit
 *       cfg.enabled=true && token_set=false → 不 emit
 *       cfg.enabled=true && token_set=true → emit + content 非空 + 不带 canonicalModelId
 *       readLitCfg 抛错 → 该 slot 静默不 emit,整体仍 200(fail-soft)
 *   - MODEL_HINT:
 *       无 ?model query → 不 emit
 *       ?model 命中 pricing 且 extra_system_prompt 非空 → emit + canonicalModelId == row.model_id
 *       ?model 命中 pricing 但 extra_system_prompt = null / 空白 → 不 emit
 *       ?model miss pricing → 不 emit
 *       ?model 超长(>128 bytes)→ 等同没传,只 emit literature(若 enabled)
 *   - 同时 emit literature + model_hint:数组长度=2,名字白名单内
 *   - 都不 emit:`{slots: []}` 仍是合法 200
 *   - 响应头 Cache-Control: no-store
 *
 * 不碰 DB / Redis:identityRepo / readLitCfg / PricingCache._setForTests 全部内存注入。
 *
 * 跑法:npx tsx --test src/__tests__/internalPlatformPromptSlots.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  PLATFORM_PROMPT_SLOTS_PATH,
  makePlatformPromptSlotsHandler,
  type PlatformPromptSlotsResponseBody,
} from "../http/internalPlatformPromptSlots.js";
import type { ContainerIdentityRepo } from "../auth/containerIdentity.js";
import type { LiteratureSkillConfig } from "../admin/literatureConfig.js";
import { PricingCache } from "../billing/pricing.js";
import type { ModelPricing } from "../billing/pricing.js";

// ─── Fixtures ──────────────────────────────────────────────────────

const HOST = "00000000-0000-0000-0000-000000000001";
const IP = "172.30.1.42";

function makeIdentity(containerId: number, userId: number) {
  const secretHex = randomBytes(32).toString("hex");
  const secretHash = createHash("sha256")
    .update(Buffer.from(secretHex, "hex"))
    .digest();
  return { containerId, userId, secretHex, secretHash };
}

function memRepo(
  rows: Array<{
    id: number;
    user_id: number;
    host_uuid: string;
    bound_ip: string;
    secret_hash: Buffer | null;
  }>,
): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(h, ip) {
      return rows.find((r) => r.host_uuid === h && r.bound_ip === ip) ?? null;
    },
  };
}

function makePricing(rows: ModelPricing[]): PricingCache {
  const p = new PricingCache();
  p._setForTests(rows);
  return p;
}

function pricingRow(overrides: Partial<ModelPricing> = {}): ModelPricing {
  return {
    model_id: "claude-opus-4-7",
    display_name: "Claude Opus 4.7",
    input_per_mtok: 0n,
    output_per_mtok: 0n,
    cache_read_per_mtok: 0n,
    cache_write_per_mtok: 0n,
    multiplier: "1.0",
    enabled: true,
    sort_order: 0,
    visibility: "public",
    extra_system_prompt: null,
    updated_at: new Date(0),
    ...overrides,
  };
}

function makeReq(opts: {
  method?: string;
  url?: string;
  authorization?: string;
}): IncomingMessage {
  const em = new EventEmitter() as IncomingMessage & EventEmitter;
  em.method = opts.method ?? "GET";
  em.headers = {};
  if (opts.authorization !== undefined)
    em.headers.authorization = opts.authorization;
  em.url = opts.url ?? PLATFORM_PROMPT_SLOTS_PATH;
  return em;
}

interface MockRes {
  statusCode: number;
  headersSent: boolean;
  headers: Record<string, string>;
  body: string;
  setHeader(k: string, v: string): void;
  writeHead(s: number, h?: Record<string, string>): void;
  end(b?: string): void;
}

function makeRes(): MockRes & ServerResponse {
  const r: MockRes = {
    statusCode: 0,
    headersSent: false,
    headers: {},
    body: "",
    setHeader(k, v) {
      r.headers[k.toLowerCase()] = String(v);
    },
    writeHead(s, h) {
      r.statusCode = s;
      if (h) for (const [k, v] of Object.entries(h)) r.setHeader(k, v);
      r.headersSent = true;
    },
    end(b) {
      r.body = b ?? "";
      r.headersSent = true;
    },
  };
  return r as unknown as MockRes & ServerResponse;
}

function setupValidIdentity() {
  const id = makeIdentity(42, 7);
  const repo = memRepo([
    {
      id: id.containerId,
      user_id: id.userId,
      host_uuid: HOST,
      bound_ip: IP,
      secret_hash: id.secretHash,
    },
  ]);
  const auth = `Bearer oc-v3.${id.containerId}.${id.secretHex}`;
  return { id, repo, auth };
}

const litEnabled: LiteratureSkillConfig = {
  enabled: true,
  token_set: true,
  default_size: 10,
};
const litDisabled: LiteratureSkillConfig = {
  enabled: false,
  token_set: false,
  default_size: 10,
};
const litEnabledNoToken: LiteratureSkillConfig = {
  enabled: true,
  token_set: false,
  default_size: 10,
};

function parseBody(body: string): PlatformPromptSlotsResponseBody {
  return JSON.parse(body) as PlatformPromptSlotsResponseBody;
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("internalPlatformPromptSlots — auth & method gate", () => {
  test("非 GET → 405", async () => {
    const { repo, auth } = setupValidIdentity();
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: repo,
      pricingCache: makePricing([]),
      readLiteratureSkillConfig: async () => litDisabled,
    });
    const req = makeReq({ method: "POST", authorization: auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 405);
  });

  test("identity 失败 → 401(repo 找不到 row)", async () => {
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: memRepo([]), // 空 repo
      pricingCache: makePricing([]),
      readLiteratureSkillConfig: async () => litEnabled,
    });
    const id = makeIdentity(1, 1);
    const req = makeReq({
      authorization: `Bearer oc-v3.${id.containerId}.${id.secretHex}`,
    });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 401);
  });

  test("identity 失败 → 响应体不暴露 errcode 细节", async () => {
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: memRepo([]),
      pricingCache: makePricing([]),
      readLiteratureSkillConfig: async () => litEnabled,
    });
    const req = makeReq({ authorization: "Bearer garbage" });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body) as {
      error: { code: string; message: string };
    };
    assert.equal(body.error.code, "UNAUTHORIZED");
    // 不要在 body.error.message 里泄漏内部 errcode (BAD_TOKEN_FORMAT 等)
    assert.doesNotMatch(body.error.message, /BAD_TOKEN_FORMAT|SECRET_MISMATCH/);
  });

  test("missing Authorization → 401", async () => {
    const { repo } = setupValidIdentity();
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: repo,
      pricingCache: makePricing([]),
      readLiteratureSkillConfig: async () => litEnabled,
    });
    const req = makeReq({}); // no auth
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 401);
  });
});

describe("internalPlatformPromptSlots — SKILLS_LITERATURE slot", () => {
  test("cfg.enabled=false → SKILLS_LITERATURE 不 emit", async () => {
    const { repo, auth } = setupValidIdentity();
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: repo,
      pricingCache: makePricing([]),
      readLiteratureSkillConfig: async () => litDisabled,
    });
    const req = makeReq({ authorization: auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 200);
    const body = parseBody(res.body);
    assert.equal(body.slots.length, 0);
  });

  test("cfg.enabled=true && token_set=false → 不 emit", async () => {
    const { repo, auth } = setupValidIdentity();
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: repo,
      pricingCache: makePricing([]),
      readLiteratureSkillConfig: async () => litEnabledNoToken,
    });
    const req = makeReq({ authorization: auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 200);
    const body = parseBody(res.body);
    assert.equal(body.slots.length, 0);
  });

  test("cfg enabled+token_set → emit + content 非空 + 不带 canonicalModelId", async () => {
    const { repo, auth } = setupValidIdentity();
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: repo,
      pricingCache: makePricing([]),
      readLiteratureSkillConfig: async () => litEnabled,
    });
    const req = makeReq({ authorization: auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 200);
    const body = parseBody(res.body);
    assert.equal(body.slots.length, 1);
    const slot = body.slots[0];
    assert.equal(slot.name, "SKILLS_LITERATURE");
    assert.ok(slot.content.length > 0);
    assert.match(slot.content, /平台技能: 文献检索/);
    assert.equal(slot.canonicalModelId, undefined);
  });

  test("readLitCfg 抛错 → 该 slot 静默不 emit,整体 200(fail-soft)", async () => {
    const { repo, auth } = setupValidIdentity();
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: repo,
      pricingCache: makePricing([]),
      readLiteratureSkillConfig: async () => {
        throw new Error("DB down");
      },
    });
    const req = makeReq({ authorization: auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 200);
    const body = parseBody(res.body);
    assert.equal(body.slots.length, 0);
  });
});

describe("internalPlatformPromptSlots — MODEL_HINT slot", () => {
  test("无 ?model query → 不 emit", async () => {
    const { repo, auth } = setupValidIdentity();
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: repo,
      pricingCache: makePricing([
        pricingRow({ model_id: "m1", extra_system_prompt: "hint" }),
      ]),
      readLiteratureSkillConfig: async () => litDisabled,
    });
    const req = makeReq({ authorization: auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 200);
    const body = parseBody(res.body);
    assert.equal(body.slots.length, 0);
  });

  test("?model 命中 + extra_system_prompt 非空 → emit + 包成与 hook 同型 markdown + canonicalModelId", async () => {
    const { repo, auth } = setupValidIdentity();
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: repo,
      pricingCache: makePricing([
        pricingRow({
          model_id: "deepseek-v4-pro",
          extra_system_prompt: "禁止早 yield",
        }),
      ]),
      readLiteratureSkillConfig: async () => litDisabled,
    });
    const req = makeReq({
      url: `${PLATFORM_PROMPT_SLOTS_PATH}?model=deepseek-v4-pro`,
      authorization: auth,
    });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 200);
    const body = parseBody(res.body);
    assert.equal(body.slots.length, 1);
    const slot = body.slots[0];
    assert.equal(slot.name, "MODEL_HINT");
    assert.equal(slot.canonicalModelId, "deepseek-v4-pro");
    // 必须与 gateway buildModelHintSlot(promptSlots.ts:441-451)字节级一致 ——
    // personal hook 和 v3 远程两条管道给 LLM 看到的 MODEL_HINT 段必须等同。
    assert.equal(
      slot.content,
      "# 模型行为补丁\n\n以下规则用于修正当前模型的默认行为,不要在回答中复述。\n\n禁止早 yield",
    );
  });

  test("?model 命中但 extra_system_prompt = null → 不 emit", async () => {
    const { repo, auth } = setupValidIdentity();
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: repo,
      pricingCache: makePricing([
        pricingRow({ model_id: "m1", extra_system_prompt: null }),
      ]),
      readLiteratureSkillConfig: async () => litDisabled,
    });
    const req = makeReq({
      url: `${PLATFORM_PROMPT_SLOTS_PATH}?model=m1`,
      authorization: auth,
    });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 200);
    const body = parseBody(res.body);
    assert.equal(body.slots.length, 0);
  });

  test("?model 命中但 extra_system_prompt 全空白 → 不 emit", async () => {
    const { repo, auth } = setupValidIdentity();
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: repo,
      pricingCache: makePricing([
        pricingRow({ model_id: "m1", extra_system_prompt: "  \n\t  " }),
      ]),
      readLiteratureSkillConfig: async () => litDisabled,
    });
    const req = makeReq({
      url: `${PLATFORM_PROMPT_SLOTS_PATH}?model=m1`,
      authorization: auth,
    });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 200);
    assert.equal(parseBody(res.body).slots.length, 0);
  });

  test("?model miss pricing → 不 emit", async () => {
    const { repo, auth } = setupValidIdentity();
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: repo,
      pricingCache: makePricing([]), // 空表
      readLiteratureSkillConfig: async () => litDisabled,
    });
    const req = makeReq({
      url: `${PLATFORM_PROMPT_SLOTS_PATH}?model=unknown`,
      authorization: auth,
    });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 200);
    assert.equal(parseBody(res.body).slots.length, 0);
  });

  test("?model 超长(>128 bytes)→ 等同没传,只 emit literature", async () => {
    const { repo, auth } = setupValidIdentity();
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: repo,
      pricingCache: makePricing([
        pricingRow({ model_id: "m1", extra_system_prompt: "x" }),
      ]),
      readLiteratureSkillConfig: async () => litEnabled,
    });
    const huge = "a".repeat(200);
    const req = makeReq({
      url: `${PLATFORM_PROMPT_SLOTS_PATH}?model=${huge}`,
      authorization: auth,
    });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 200);
    const body = parseBody(res.body);
    assert.equal(body.slots.length, 1);
    assert.equal(body.slots[0].name, "SKILLS_LITERATURE");
  });

  test("MODEL_HINT canonicalModelId 取自 row.model_id 而非 raw 入参(防 cardinality 攻击)", async () => {
    // 入参是带日期 alias 的 firstParty 形式,canonicalize 后落到 row.model_id
    const { repo, auth } = setupValidIdentity();
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: repo,
      pricingCache: makePricing([
        pricingRow({
          model_id: "claude-opus-4-7",
          extra_system_prompt: "hint",
        }),
      ]),
      readLiteratureSkillConfig: async () => litDisabled,
    });
    const req = makeReq({
      url: `${PLATFORM_PROMPT_SLOTS_PATH}?model=claude-opus-4-7-20260101-evil-suffix-AAAA`,
      authorization: auth,
    });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 200);
    const body = parseBody(res.body);
    // canonicalize 命中 → emit;canonicalModelId 是 canonical 短名,不含日期/恶意尾巴
    if (body.slots.length === 1) {
      assert.equal(body.slots[0].canonicalModelId, "claude-opus-4-7");
    }
    // 若 canonicalizeModelId 不识别这个长 alias → 不 emit,也合法
  });
});

describe("internalPlatformPromptSlots — combined behavior", () => {
  test("literature + model_hint 都启用 → 两个 slot 都 emit", async () => {
    const { repo, auth } = setupValidIdentity();
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: repo,
      pricingCache: makePricing([
        pricingRow({
          model_id: "deepseek-v4-pro",
          extra_system_prompt: "禁止早 yield",
        }),
      ]),
      readLiteratureSkillConfig: async () => litEnabled,
    });
    const req = makeReq({
      url: `${PLATFORM_PROMPT_SLOTS_PATH}?model=deepseek-v4-pro`,
      authorization: auth,
    });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 200);
    const body = parseBody(res.body);
    assert.equal(body.slots.length, 2);
    const names = new Set(body.slots.map((s) => s.name));
    assert.ok(names.has("SKILLS_LITERATURE"));
    assert.ok(names.has("MODEL_HINT"));
  });

  test("空结果 {slots: []} 是合法 200 响应", async () => {
    const { repo, auth } = setupValidIdentity();
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: repo,
      pricingCache: makePricing([]),
      readLiteratureSkillConfig: async () => litDisabled,
    });
    const req = makeReq({ authorization: auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(parseBody(res.body), { slots: [] });
  });

  test("响应带 Cache-Control: no-store(防中间层缓存)", async () => {
    const { repo, auth } = setupValidIdentity();
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: repo,
      pricingCache: makePricing([]),
      readLiteratureSkillConfig: async () => litEnabled,
    });
    const req = makeReq({ authorization: auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.equal(res.headers["cache-control"], "no-store");
  });

  test("响应 Content-Type 是 application/json; charset=utf-8", async () => {
    const { repo, auth } = setupValidIdentity();
    const handler = makePlatformPromptSlotsHandler({
      identityRepo: repo,
      pricingCache: makePricing([]),
      readLiteratureSkillConfig: async () => litEnabled,
    });
    const req = makeReq({ authorization: auth });
    const res = makeRes();
    await handler(req, res, { hostUuid: HOST, boundIp: IP });
    assert.match(
      res.headers["content-type"] ?? "",
      /application\/json; ?charset=utf-8/,
    );
  });
});
