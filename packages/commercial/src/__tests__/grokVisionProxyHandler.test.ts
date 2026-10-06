import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Pool } from "pg";

import { InMemoryPreCheckRedis, InsufficientCreditsError } from "../billing/preCheck.js";
import { PricingCache } from "../billing/pricing.js";
import { parseBillingPricing } from "../billing/persistedBillingPricing.js";
import type { ModelCatalogSnapshot } from "../billing/modelCatalog.js";
import type { UserModelAuthz } from "../auth/userModelAuthz.js";
import {
  GROK_VISION_JOURNAL_SOURCE,
  GROK_VISION_MAX_IMAGE_BYTES,
  GROK_VISION_UPSTREAM,
  __resetGrokVisionRateState,
  makeGrokVisionHandler,
  textFromGrokVisionResponse,
  usageFromGrokVisionResponse,
} from "../grok/visionProxy.js";
import {
  GROK_TOKEN_BYTES,
  PNG_BASE64,
  PUBLIC_VISION_AUTHZ,
  VISION_CTX,
  grokVisionSnapshot,
  grokVisionUpstreamPayload,
  visionIdentityRepo,
  visionReq,
  visionRes,
  visionToken,
} from "./helpers/grokVisionFixtures.js";

const CID = 42;
const UID = 7;
const TOKEN = visionToken(CID);
const BILLING_ID = "ab".repeat(16);
const BODY = { image: { mediaType: "image/png", data: PNG_BASE64 }, prompt: "图片上写的数字是什么？" };

function harness(opts: {
  snapshot?: ModelCatalogSnapshot;
  authz?: UserModelAuthz;
  catalogError?: boolean;
  authzError?: boolean;
  insufficient?: boolean;
  journalAdmitted?: boolean;
  upstream?: { statusCode: number; text: string } | Error;
  noAccount?: boolean;
  settle?: "committed" | "waived" | Error;
} = {}) {
  const events: string[] = [];
  const calls = {
    precheck: [] as any[],
    journal: [] as any[],
    upstream: [] as Array<{ url: string; init: any }>,
    settle: [] as any[],
    abort: [] as any[],
    release: [] as any[],
    status: [] as any[],
  };
  const handler = makeGrokVisionHandler({
    identityRepo: visionIdentityRepo(CID, UID),
    getPool: () => ({}) as Pool,
    preCheckRedis: new InMemoryPreCheckRedis(),
    pricing: new PricingCache(),
    catalog: {
      async assertFresh() {
        if (opts.catalogError) throw new Error("stale");
        return opts.snapshot ?? grokVisionSnapshot();
      },
    },
    loadUserModelAuthz: async () => {
      if (opts.authzError) throw new Error("authz down");
      return opts.authz ?? PUBLIC_VISION_AUTHZ;
    },
    newRequestId: () => BILLING_ID,
    pickAccountId: async () => (opts.noAccount ? null : 24n),
    freshToken: async () => Buffer.from(GROK_TOKEN_BYTES),
    requestFn: async (url, init) => {
      events.push("upstream");
      calls.upstream.push({ url, init });
      if (opts.upstream instanceof Error) throw opts.upstream;
      const up = opts.upstream ?? { statusCode: 200, text: JSON.stringify(grokVisionUpstreamPayload()) };
      return { statusCode: up.statusCode, body: { text: async () => up.text } };
    },
    recordStatus: async (accountId, statusCode) => { calls.status.push({ accountId, statusCode }); },
    preCheckWithCostFn: (async (_redis: unknown, input: any) => {
      events.push("precheck");
      calls.precheck.push(input);
      if (opts.insufficient) throw new InsufficientCreditsError(0n, input.maxCost);
      return { maxCost: input.maxCost, balance: 1000n, capped: false, originalMaxCost: input.maxCost,
        reservation: { userId: String(input.userId), requestId: input.requestId } };
    }) as any,
    startInflightJournalFn: (async (_pool: unknown, ctx: any) => {
      events.push("journal");
      calls.journal.push(ctx);
      return opts.journalAdmitted ?? true;
    }) as any,
    settleDurableCodexBillingFn: (async (_deps: unknown, userId: bigint, frame: any) => {
      events.push("settle");
      calls.settle.push({ userId, frame });
      if (opts.settle instanceof Error) throw opts.settle;
      return opts.settle ?? "committed";
    }) as any,
    abortInflightJournalFn: (async (_pool: unknown, requestId: string, reason: string) => {
      events.push("abort");
      calls.abort.push({ requestId, reason });
      return true;
    }) as any,
    releasePreCheckFn: (async (_redis: unknown, handle: any) => {
      events.push("release");
      calls.release.push(handle);
    }) as any,
  });
  const run = async (body: unknown = BODY, method = "POST", auth = TOKEN) => {
    const { res, json } = visionRes();
    await handler(visionReq(method, body, auth), res, VISION_CTX);
    return { status: res.statusCode, json: json() };
  };
  return { run, calls, events };
}

describe("grok vision response parsing", () => {
  it("joins output_text of message items and ignores reasoning items", () => {
    assert.equal(textFromGrokVisionResponse(grokVisionUpstreamPayload({ text: " 785941\n" })), "785941");
    assert.equal(textFromGrokVisionResponse({ output: [{ type: "reasoning", content: [{ type: "output_text", text: "x" }] }] }), "");
    assert.equal(textFromGrokVisionResponse(null), "");
  });

  it("splits cached input and reasoning output into disjoint billing counters", () => {
    assert.deepEqual(
      usageFromGrokVisionResponse({
        usage: {
          input_tokens: 1367,
          input_tokens_details: { cached_tokens: 300 },
          output_tokens: 54,
          output_tokens_details: { reasoning_tokens: 52 },
        },
      }),
      {
        input_tokens: 1067,
        output_tokens: 2,
        reasoning_output_tokens: 52,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 0,
      },
    );
  });

  it("never reports more cached or reasoning tokens than the totals they are part of", () => {
    const usage = usageFromGrokVisionResponse({
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 99 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 99 },
      },
    });
    assert.deepEqual(usage, {
      input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 5,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 0,
    });
  });

  it("returns null when the response has no usable usage object", () => {
    assert.equal(usageFromGrokVisionResponse(grokVisionUpstreamPayload({ usage: null })), null);
    assert.equal(usageFromGrokVisionResponse({ usage: { input_tokens: "1367", output_tokens: 54 } }), null);
    assert.equal(usageFromGrokVisionResponse({ usage: { input_tokens: 1, output_tokens: -1 } }), null);
  });
});

describe("grok vision handler", () => {
  beforeEach(() => __resetGrokVisionRateState());

  it("405 for non-POST", async () => {
    const h = harness();
    const out = await h.run(BODY, "GET");
    assert.equal(out.status, 405);
    assert.deepEqual(h.events, []);
  });

  it("401 without a valid container identity, before anything else runs", async () => {
    const h = harness();
    const out = await h.run(BODY, "POST", "Bearer nope");
    assert.equal(out.status, 401);
    assert.deepEqual(h.events, []);
  });

  it("400 for a malformed body, an unknown field, or a non-base64 image", async () => {
    const h = harness();
    assert.equal((await h.run({ prompt: "q" })).status, 400);
    assert.equal((await h.run({ ...BODY, model: "grok-build-fast" })).status, 400);
    assert.equal((await h.run({ image: { mediaType: "image/png", data: "not base64!" }, prompt: "q" })).status, 400);
    assert.equal((await h.run({ image: { mediaType: "image/svg+xml", data: PNG_BASE64 }, prompt: "q" })).status, 400);
    assert.deepEqual(h.events, []);
  });

  it("400 when the bytes are not the declared image type", async () => {
    const h = harness();
    const out = await h.run({ image: { mediaType: "image/jpeg", data: PNG_BASE64 }, prompt: "q" });
    assert.equal(out.status, 400);
    assert.equal(out.json.error.code, "BAD_IMAGE");
    const text = await h.run({ image: { mediaType: "image/png", data: Buffer.from("hello world!").toString("base64") }, prompt: "q" });
    assert.equal(text.json.error.code, "BAD_IMAGE");
    assert.deepEqual(h.events, []);
  });

  it("413 when the decoded image is over the cap", async () => {
    const h = harness();
    const big = Buffer.alloc(GROK_VISION_MAX_IMAGE_BYTES + 1, 0).toString("base64");
    const out = await h.run({ image: { mediaType: "image/png", data: big }, prompt: "q" });
    assert.equal(out.status, 413);
    assert.deepEqual(h.events, []);
  });

  it("503 when the catalog or the user's model authorization cannot be loaded", async () => {
    const a = harness({ catalogError: true });
    assert.equal((await a.run()).json.error.code, "GROK_VISION_CATALOG_UNAVAILABLE");
    const b = harness({ authzError: true });
    assert.equal((await b.run()).json.error.code, "GROK_VISION_AUTHZ_UNAVAILABLE");
    assert.deepEqual([...a.events, ...b.events], []);
  });

  it("503 when grok-build is disabled, not a grok engine model, or maps to an unknown upstream", async () => {
    for (const snapshot of [
      grokVisionSnapshot({ state: "disabled" }),
      grokVisionSnapshot({ engine: "ccb" }),
      grokVisionSnapshot({ upstreamModelId: "grok-9" }),
    ]) {
      const h = harness({ snapshot });
      const out = await h.run();
      assert.equal(out.status, 503);
      assert.equal(out.json.error.code, "GROK_VISION_MODEL_UNAVAILABLE");
      assert.deepEqual(h.events, []);
    }
  });

  it("403 for a user who may not use grok-build: no reservation, no journal, no upstream call", async () => {
    const denied = harness({ authz: { ...PUBLIC_VISION_AUTHZ, deniedModelIds: new Set(["grok-build"]) } });
    const out = await denied.run();
    assert.equal(out.status, 403);
    assert.equal(out.json.error.code, "GROK_VISION_NOT_AUTHORIZED");
    assert.deepEqual(denied.events, []);
    const adminOnly = harness({ snapshot: grokVisionSnapshot({ price: { visibility: "admin" } }) });
    assert.equal((await adminOnly.run()).status, 403);
    assert.deepEqual(adminOnly.events, []);
  });

  it("402 when credits are insufficient: no journal, no upstream call", async () => {
    const h = harness({ insufficient: true });
    const out = await h.run();
    assert.equal(out.status, 402);
    assert.deepEqual(h.events, ["precheck"]);
  });

  it("409 and releases the reservation when the journal row cannot be admitted", async () => {
    const h = harness({ journalAdmitted: false });
    const out = await h.run();
    assert.equal(out.status, 409);
    assert.deepEqual(h.events, ["precheck", "journal", "release"]);
  });

  it("success: reserve -> journal -> upstream -> settle, then returns the text", async () => {
    const h = harness();
    const out = await h.run();
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, { text: "785941", model: "grok-build" });
    assert.deepEqual(h.events, ["precheck", "journal", "upstream", "settle"]);

    // reservation: 8000 tokens at the output price (1500/Mtok x1.000) = 12 credits
    assert.equal(h.calls.precheck[0].maxCost, 12n);
    assert.equal(h.calls.precheck[0].requestId, BILLING_ID);
    assert.equal(h.calls.precheck[0].userId, BigInt(UID));

    const journal = h.calls.journal[0];
    assert.equal(journal.requestId, BILLING_ID);
    assert.equal(journal.userId, BigInt(UID));
    assert.equal(journal.containerId, BigInt(CID));
    assert.equal(journal.model, "grok-build");
    assert.equal(journal.precheckCredits, 12n);
    assert.equal(journal.ctxJson.source, GROK_VISION_JOURNAL_SOURCE);
    assert.equal(journal.ctxJson.upstreamModelId, "grok-4.7");
    // the price is frozen at admit; settle must not need the live cache
    const frozen = parseBillingPricing(journal.ctxJson.billingPricing, "grok-build");
    assert.equal(frozen?.input_per_mtok, 250n);
    assert.equal(frozen?.output_per_mtok, 1500n);
    assert.equal(frozen?.cache_read_per_mtok, 25n);
    assert.equal(frozen?.multiplier, "1.000");
    // a durable-recovery marker would park the row waiting for a turn tape that never comes
    assert.equal("durableBillingRecovery" in journal.ctxJson, false);
    assert.equal("authorityKind" in journal.ctxJson, false);

    const up = h.calls.upstream[0]!;
    assert.equal(up.url, GROK_VISION_UPSTREAM);
    assert.equal(up.init.headers.authorization, `Bearer ${GROK_TOKEN_BYTES}`);
    assert.equal(up.init.headers["x-grok-model-override"], "grok-build");
    const sent = JSON.parse(up.init.body);
    assert.equal(sent.model, "grok-4.7");
    assert.equal(sent.store, false);
    assert.deepEqual(sent.input[0].content, [
      { type: "input_image", image_url: `data:image/png;base64,${PNG_BASE64}` },
      { type: "input_text", text: BODY.prompt },
    ]);
    assert.equal("tools" in sent, false);

    const settle = h.calls.settle[0];
    assert.equal(settle.userId, BigInt(UID));
    assert.equal(settle.frame.requestId, BILLING_ID);
    assert.equal(settle.frame.status, "success");
    assert.equal(settle.frame.engineSessionId, journal.ctxJson.engineSessionId);
    assert.deepEqual(settle.frame.usage, {
      input_tokens: 1367,
      output_tokens: 2,
      reasoning_output_tokens: 52,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    assert.deepEqual(h.calls.status, [{ accountId: 24n, statusCode: 200 }]);
    assert.deepEqual(h.calls.abort, []);
    assert.deepEqual(h.calls.release, []);
  });

  it("the container cannot pick the model, the upstream model, or the price", async () => {
    const h = harness({ snapshot: grokVisionSnapshot({ upstreamModelId: "grok-4.6" }) });
    const out = await h.run();
    assert.equal(out.status, 200);
    assert.equal(JSON.parse(h.calls.upstream[0]!.init.body).model, "grok-4.6");
    assert.equal(h.calls.journal[0].model, "grok-build");
  });

  for (const [name, upstream, status, code] of [
    ["upstream 500", { statusCode: 500, text: "{}" }, 502, "GROK_UPSTREAM_ERROR"],
    ["upstream 429", { statusCode: 429, text: "{}" }, 502, "GROK_UPSTREAM_ERROR"],
    ["invalid JSON", { statusCode: 200, text: "<html>" }, 502, "GROK_BAD_RESPONSE"],
    ["no answer text", { statusCode: 200, text: JSON.stringify(grokVisionUpstreamPayload({ text: "  " })) }, 502, "GROK_BAD_RESPONSE"],
    ["no usage", { statusCode: 200, text: JSON.stringify(grokVisionUpstreamPayload({ usage: null })) }, 502, "GROK_BAD_RESPONSE"],
    ["timeout", Object.assign(new Error("t"), { name: "HeadersTimeoutError" }), 504, "GROK_UPSTREAM_TIMEOUT"],
    ["network error", new Error("ECONNRESET"), 502, "GROK_UPSTREAM_ERROR"],
  ] as const) {
    it(`${name}: journal aborted, reservation released, nothing settled, no text returned`, async () => {
      const h = harness({ upstream: upstream as any });
      const out = await h.run();
      assert.equal(out.status, status);
      assert.equal(out.json.error.code, code);
      assert.equal("text" in out.json, false);
      assert.deepEqual(h.events, ["precheck", "journal", "upstream", "abort", "release"]);
      assert.deepEqual(h.calls.abort, [{ requestId: BILLING_ID, reason: "grok_vision_upstream_failed" }]);
      assert.deepEqual(h.calls.release, [{ userId: String(UID), requestId: BILLING_ID }]);
      assert.deepEqual(h.calls.settle, []);
    });
  }

  it("no active grok account: aborted and released without an upstream call", async () => {
    const h = harness({ noAccount: true });
    const out = await h.run();
    assert.equal(out.status, 503);
    assert.equal(out.json.error.code, "GROK_VISION_NOT_CONFIGURED");
    assert.deepEqual(h.events, ["precheck", "journal", "abort", "release"]);
  });

  for (const [name, settle] of [
    ["settle throws", new Error("db down")],
    ["settle is waived", "waived"],
  ] as const) {
    it(`${name}: the answer is not returned unbilled`, async () => {
      const h = harness({ settle: settle as any });
      const out = await h.run();
      assert.equal(out.status, 502);
      assert.equal(out.json.error.code, "GROK_VISION_BILLING_FAILED");
      assert.equal("text" in out.json, false);
      assert.equal(JSON.stringify(out.json).includes("785941"), false);
    });
  }

  it("does not leak the subscription token or the billing request id to the container", async () => {
    for (const h of [harness(), harness({ upstream: { statusCode: 401, text: GROK_TOKEN_BYTES } }), harness({ settle: new Error("x") })]) {
      const raw = JSON.stringify((await h.run()).json);
      assert.equal(raw.includes(GROK_TOKEN_BYTES), false);
      assert.equal(raw.includes(BILLING_ID), false);
    }
  });

  it("rate limits per container", async () => {
    const h = harness();
    for (let i = 0; i < 30; i++) assert.equal((await h.run()).status, 200);
    const out = await h.run();
    assert.equal(out.status, 429);
    assert.equal(h.calls.upstream.length, 30);
  });
});
