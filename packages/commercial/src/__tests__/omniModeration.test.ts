import * as assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  hardCategoriesFromModerationBody,
  omniCategoryLabels,
  omniHardHit,
  OMNI_MODERATION_MODEL,
  OMNI_MODERATION_URL,
} from "../openai/omniModeration.js";

describe("omni moderation body", () => {
  test("keeps hard categories and ignores harassment-only flags", () => {
    const categories = hardCategoriesFromModerationBody({
      results: [
        {
          flagged: true,
          categories: {
            harassment: true,
            "sexual/minors": true,
            violence: false,
            hate: true,
          },
        },
      ],
    });
    assert.deepEqual(categories, ["sexual/minors", "hate"]);
    assert.equal(omniCategoryLabels(categories), "未成年色情、仇恨");
    assert.deepEqual(
      hardCategoriesFromModerationBody({
        results: [{ flagged: true, categories: { harassment: true } }],
      }),
      [],
    );
  });
});

describe("omniHardHit", () => {
  test("does not call the API without a usable key", async () => {
    let calls = 0;
    const missed = await omniHardHit({
      apiKey: "sk-test\nsecret",
      text: "hello there",
      fetchImpl: async () => {
        calls += 1;
        throw new Error("should not be called");
      },
    });
    assert.equal(missed.hit, false);
    assert.equal(calls, 0);
    const blank = await omniHardHit({ apiKey: "  ", text: "hello there", fetchImpl: async () => {
      calls += 1;
      throw new Error("should not be called");
    } });
    assert.equal(blank.hit, false);
    assert.equal(calls, 0);
  });

  test("posts omni-moderation-latest and reports a hard hit", async () => {
    const seen: string[] = [];
    const result = await omniHardHit({
      apiKey: "sk-test-not-a-real-key-9876",
      text: "a violent request",
      images: [{ body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) }],
      fetchImpl: async (url, init) => {
        assert.equal(String(url), OMNI_MODERATION_URL);
        assert.doesNotMatch(String(url), /sk-test/);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        assert.equal(headers.Authorization, "Bearer sk-test-not-a-real-key-9876");
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, OMNI_MODERATION_MODEL);
        assert.equal(body.input[0].type, "text");
        assert.equal(body.input[1].type, "image_url");
        assert.match(body.input[1].image_url.url, /^data:image\/png;base64,/);
        assert.equal(String(init?.body).includes("sk-test-not-a-real-key-9876"), false);
        seen.push(headers.Authorization);
        return new Response(JSON.stringify({
          results: [{ flagged: true, categories: { violence: true, harassment: true } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(result.hit, true);
    assert.deepEqual(result.categories, ["violence"]);
    assert.equal(seen.length, 1);
  });

  test("uses its own short timeout and returns a miss when the call aborts", async () => {
    const started = Date.now();
    const result = await omniHardHit({
      apiKey: "sk-test-not-a-real-key-9876",
      text: "ordinary coding help please",
      timeoutMs: 40,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        const safety = setTimeout(() => reject(new Error("moderation timeout did not fire")), 2_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(safety);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      }),
    });
    assert.equal(result.hit, false);
    assert.deepEqual(result.categories, []);
    assert.ok(Date.now() - started < 1_500);
  });

  test("a failed or empty moderation call falls through", async () => {
    const http = await omniHardHit({
      apiKey: "sk-test-not-a-real-key-9876",
      text: "ordinary coding help please",
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    assert.equal(http.hit, false);
    const thrown = await omniHardHit({
      apiKey: "sk-test-not-a-real-key-9876",
      text: "ordinary coding help please",
      fetchImpl: async () => {
        throw new Error("network");
      },
    });
    assert.equal(thrown.hit, false);
    const clean = await omniHardHit({
      apiKey: "sk-test-not-a-real-key-9876",
      text: "ordinary coding help please",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.input, "ordinary coding help please");
        return new Response(JSON.stringify({
          results: [{ flagged: false, categories: { violence: false, harassment: false } }],
        }), { status: 200 });
      },
    });
    assert.equal(clean.hit, false);
  });
});
