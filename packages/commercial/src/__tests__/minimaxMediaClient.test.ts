import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { HttpError } from "../http/util.js";
import {
  isCloneSampleRejected,
  parseCloneConsent,
  sanitizeVoiceSetting,
  sniffCloneSampleMime,
} from "../minimax/mediaClient.js";
import { resolveMiniMaxMediaKey } from "../minimax/mediaKey.js";
import { SystemVoiceCache, generateVoiceId, isGeneratedVoiceId } from "../minimax/voices.js";

describe("resolveMiniMaxMediaKey (OCV5-589 / D12)", () => {
  const env = (v: Record<string, string>) => v as NodeJS.ProcessEnv;

  test("no file configured keeps MINIMAX_TOKEN_PLAN_KEY exactly as before", () => {
    assert.deepEqual(resolveMiniMaxMediaKey(env({ MINIMAX_TOKEN_PLAN_KEY: " tp-key " })), { key: "tp-key", source: "token_plan" });
    assert.deepEqual(resolveMiniMaxMediaKey(env({})), { source: "none" });
  });

  test("a configured file is the only source and is trimmed", () => {
    const r = resolveMiniMaxMediaKey(
      env({ MINIMAX_MEDIA_KEY_FILE: "/etc/x/media.key", MINIMAX_TOKEN_PLAN_KEY: "tp-key" }),
      (p) => {
        assert.equal(p, "/etc/x/media.key");
        return "media-key-123\n";
      },
    );
    assert.deepEqual(r, { key: "media-key-123", source: "file" });
  });

  test("an unreadable or malformed file never falls back to the search key", () => {
    const unreadable = resolveMiniMaxMediaKey(env({ MINIMAX_MEDIA_KEY_FILE: "/nope", MINIMAX_TOKEN_PLAN_KEY: "tp" }), () => {
      throw new Error("ENOENT secret-ish detail");
    });
    assert.equal(unreadable.key, undefined);
    assert.equal(unreadable.source, "none");
    assert.ok(unreadable.error && !unreadable.error.includes("secret-ish"), "error never echoes the underlying failure");
    for (const bad of ["", "two words", "a\nb", "x".repeat(513)]) {
      const r = resolveMiniMaxMediaKey(env({ MINIMAX_MEDIA_KEY_FILE: "/k", MINIMAX_TOKEN_PLAN_KEY: "tp" }), () => bad);
      assert.equal(r.key, undefined, `malformed ${JSON.stringify(bad.slice(0, 10))} is refused`);
      assert.ok(r.error && !r.error.includes(bad.slice(0, 5) || "\u0000"), "error never includes file contents");
    }
  });
});

describe("voice ids and system voice cache (OCV5-589)", () => {
  test("generated ids follow MiniMax voice_id rules and our ownership prefix", () => {
    const id = generateVoiceId(247n, (n) => Buffer.alloc(n, 7));
    assert.equal(id, "oc247xhhhhhhhhhhhh");
    assert.match(id, /^[A-Za-z][A-Za-z0-9]{7,255}$/);
    assert.ok(isGeneratedVoiceId(id));
    assert.ok(!isGeneratedVoiceId("male-qn-qingse"));
    assert.ok(!isGeneratedVoiceId("oc247x1"));
  });

  test("cache refreshes once a day and keeps the last good list when a refresh fails", async () => {
    let now = 0;
    let calls = 0;
    let fail = false;
    const cache = new SystemVoiceCache(async () => {
      calls++;
      if (fail) throw new Error("upstream down");
      return [{ voiceId: `v${calls}`, voiceName: "n", description: [] }];
    }, () => now);
    assert.deepEqual((await cache.get())?.map((v) => v.voiceId), ["v1"]);
    now += 60_000;
    assert.deepEqual((await cache.get())?.map((v) => v.voiceId), ["v1"]);
    assert.equal(calls, 1, "fresh list is reused");
    now += 25 * 3600_000;
    fail = true;
    assert.deepEqual((await cache.get())?.map((v) => v.voiceId), ["v1"], "failed refresh keeps the last good list");
    const cold = new SystemVoiceCache(async () => {
      throw new Error("down");
    });
    assert.equal(await cold.get(), null, "never fetched → null (callers fail closed)");
  });
});

describe("speech voice_setting sanitising (OCV5-589)", () => {
  test("keeps tuning fields in range and drops any voice_id override", () => {
    assert.deepEqual(sanitizeVoiceSetting({ speed: 0.95, vol: 1, pitch: -2, emotion: "calm", voice_id: "someone-else" }), {
      speed: 0.95,
      vol: 1,
      pitch: -2,
      emotion: "calm",
    });
    assert.deepEqual(sanitizeVoiceSetting(undefined), {});
  });

  test("rejects out-of-range or unknown fields", () => {
    for (const bad of [{ speed: 3 }, { vol: 0 }, { pitch: 1.5 }, { emotion: "sarcastic" }, { timbre: 1 }, "x"]) {
      assert.throws(() => sanitizeVoiceSetting(bad), (e: unknown) => e instanceof HttpError && e.status === 400);
    }
  });
});

describe("voice cloning guards (OCV5-589 / D7)", () => {
  test("consent statement is mandatory and normalised", () => {
    assert.deepEqual(parseCloneConsent({ statement: "self_or_authorized", acceptedAt: "2026-10-23T01:02:00+08:00" }), {
      statement: "self_or_authorized",
      acceptedAt: "2026-10-22T17:02:00.000Z",
    });
    for (const bad of [undefined, {}, { statement: "yes", acceptedAt: "2026-10-23" }, { statement: "self_or_authorized", acceptedAt: "soon" }]) {
      assert.throws(() => parseCloneConsent(bad), (e: unknown) => e instanceof HttpError && e.code === "CLONE_CONSENT_REQUIRED");
    }
  });

  test("sample type is sniffed from magic bytes, not trusted from the caller", () => {
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]);
    assert.equal(sniffCloneSampleMime(wav), "audio/wav");
    assert.equal(sniffCloneSampleMime(Buffer.from("ID3\u0004\u0000")), "audio/mpeg");
    assert.equal(sniffCloneSampleMime(Buffer.from([0xff, 0xfb, 0x90, 0x00])), "audio/mpeg");
    assert.equal(sniffCloneSampleMime(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A ")])), "audio/mp4");
    assert.equal(sniffCloneSampleMime(Buffer.from("<svg>")), null);
  });

  test("moderation result uses the official boolean + top-level type fields", () => {
    assert.equal(isCloneSampleRejected({ input_sensitive: false, input_sensitive_type: 0, base_resp: { status_code: 0 } }), false);
    assert.equal(isCloneSampleRejected({ base_resp: { status_code: 0 } }), false);
    assert.equal(isCloneSampleRejected({ input_sensitive: true, input_sensitive_type: 2 }), true);
    assert.equal(isCloneSampleRejected({ input_sensitive: false, input_sensitive_type: 3 }), true);
  });
});
