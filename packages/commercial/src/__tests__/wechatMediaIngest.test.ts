import * as assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  computeWechatMediaDownloadTimeoutMs,
  saveWechatMediaToUserUploads,
  WECHAT_MEDIA_DOWNLOAD_MAX_TIMEOUT_MS,
  WECHAT_MEDIA_DOWNLOAD_MIN_TIMEOUT_MS,
} from "../wechat/imageIngest.js";

const AES_KEY = "00112233445566778899aabbccddeeff";
const MIB = 1024 * 1024;

describe("wechat media ingest save", () => {
  test("download timeout scales for large WeChat files up to the 100MB class", () => {
    const tiny = computeWechatMediaDownloadTimeoutMs(1);
    assert.ok(tiny >= WECHAT_MEDIA_DOWNLOAD_MIN_TIMEOUT_MS);
    assert.ok(tiny <= WECHAT_MEDIA_DOWNLOAD_MIN_TIMEOUT_MS + 1000);
    const fortyNineMb = computeWechatMediaDownloadTimeoutMs(49 * MIB);
    assert.ok(fortyNineMb > 15_000, "49MB should not use the old 15s timeout");
    assert.ok(fortyNineMb > 3 * 60_000, "49MB should get several minutes");
    const hundredMb = computeWechatMediaDownloadTimeoutMs(100 * MIB);
    assert.ok(hundredMb > fortyNineMb);
    assert.ok(hundredMb <= WECHAT_MEDIA_DOWNLOAD_MAX_TIMEOUT_MS);
    assert.equal(
      computeWechatMediaDownloadTimeoutMs(200 * MIB, 100 * MIB),
      hundredMb,
      "declared sizes above the hard byte cap should not extend timeout further",
    );
  });

  test("downloads encrypted file media, decrypts, writes to uploads, and builds attachment prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "oc-wechat-ingest-"));
    try {
      const encrypted = encryptEcb(Buffer.from("%PDF-1.7\nbody"));
      const result = await saveWechatMediaToUserUploads(
        {
          bindingUserId: "42",
          text: "",
          media: [
            {
              kind: "file",
              fullUrl: "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=x",
              aesKeyHex: AES_KEY,
              fileName: "report.pdf",
            },
          ],
        },
        {
          resolveUserMediaDirs: async (userId) => {
            assert.equal(userId, "c:42");
            return { kind: "ok", uid: 42, uploads: root, generated: join(root, "generated") };
          },
          fetchFn: async () =>
            new Response(new Uint8Array(encrypted), {
              status: 200,
              headers: { "content-length": String(encrypted.length) },
            }),
        },
      );
      assert.equal(result.count, 1);
      assert.equal(result.media[0]!.kind, "file");
      assert.match(result.media[0]!.filename, /^wechat-file-[0-9a-f]{32}\.pdf$/);
      assert.match(result.promptText, /report\.pdf/);
      assert.match(result.promptText, /\/home\/agent\/\.openclaude\/uploads\//);
      const saved = await readFile(join(root, result.media[0]!.filename));
      assert.equal(saved.toString("utf8"), "%PDF-1.7\nbody");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("large declared file size uses the extended download path without rejecting metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "oc-wechat-ingest-"));
    try {
      const encrypted = encryptEcb(Buffer.from("APK body placeholder"));
      let sawSignal = false;
      const result = await saveWechatMediaToUserUploads(
        {
          bindingUserId: "42",
          text: "",
          media: [
            {
              kind: "file",
              fullUrl: "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=large",
              aesKeyHex: AES_KEY,
              fileName: "BabyCamera-v3.1.apk",
              size: 100 * MIB,
            },
          ],
        },
        {
          resolveUserMediaDirs: async () => ({
            kind: "ok",
            uid: 42,
            uploads: root,
            generated: join(root, "generated"),
          }),
          fetchFn: (async (_url: unknown, init?: RequestInit) => {
            const signal = init?.signal as AbortSignal | undefined;
            assert.ok(signal, "download should pass an AbortSignal");
            assert.equal(signal.aborted, false);
            sawSignal = true;
            return new Response(new Uint8Array(encrypted), {
              status: 200,
              headers: { "content-length": String(encrypted.length) },
            });
          }) as typeof fetch,
        },
      );
      assert.equal(sawSignal, true);
      assert.equal(result.count, 1);
      assert.equal(result.media[0]!.originalName, "BabyCamera-v3.1.apk");
      assert.match(result.media[0]!.filename, /^wechat-file-[0-9a-f]{32}\.apk$/);
      const saved = await readFile(join(root, result.media[0]!.filename));
      assert.equal(saved.toString("utf8"), "APK body placeholder");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function encryptEcb(plain: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(AES_KEY, "hex"), null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}
