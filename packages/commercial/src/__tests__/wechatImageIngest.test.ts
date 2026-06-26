import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  assertAllowedWechatImageUrl,
  downloadWechatImageEncrypted,
  saveWechatImagesToUserUploads,
} from "../wechat/imageIngest.js";

const AES_KEY = "00112233445566778899aabbccddeeff";
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

function encryptEcb(buf: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(AES_KEY, "hex"), null);
  return Buffer.concat([cipher.update(buf), cipher.final()]);
}

describe("wechat image ingest URL guard", () => {
  test("allows known WeChat/Tencent CDN hosts only over https", () => {
    assert.equal(
      assertAllowedWechatImageUrl("https://novac2c.cdn.weixin.qq.com/c2c/download?x=1"),
      "https://novac2c.cdn.weixin.qq.com/c2c/download?x=1",
    );
    assert.throws(() => assertAllowedWechatImageUrl("http://novac2c.cdn.weixin.qq.com/x"), /https/);
    assert.throws(() => assertAllowedWechatImageUrl("https://example.com/x"), /host is not allowed/);
  });

  test("validates redirect Location before following it", async () => {
    await assert.rejects(
      () => downloadWechatImageEncrypted(
        "https://novac2c.cdn.weixin.qq.com/c2c/download?x=1",
        (async () => ({
          ok: false,
          status: 302,
          url: "https://novac2c.cdn.weixin.qq.com/c2c/download?x=1",
          headers: new Headers({ location: "https://example.com/redirected" }),
          body: null,
          async arrayBuffer() { return new Uint8Array([1]).buffer; },
        })) as unknown as typeof fetch,
      ),
      /host is not allowed/,
    );
  });

  test("follows a small number of allowed redirects", async () => {
    const encrypted = encryptEcb(JPG);
    const calls: string[] = [];
    const buf = await downloadWechatImageEncrypted(
      "https://novac2c.cdn.weixin.qq.com/c2c/download?x=1",
      (async (url: string) => {
        calls.push(url);
        if (calls.length === 1) {
          return {
            ok: false,
            status: 302,
            url,
            headers: new Headers({ location: "https://cdn.weixin.qq.com/c2c/download?x=2" }),
            body: null,
            async arrayBuffer() { return new Uint8Array([]).buffer; },
          };
        }
        return new Response(new Uint8Array(encrypted), {
          status: 200,
          headers: { "content-length": String(encrypted.length) },
        });
      }) as typeof fetch,
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(buf, encrypted);
  });
});

describe("wechat image ingest save", () => {
  test("downloads encrypted iLink image, decrypts, writes to uploads, and builds vision prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-wechat-img-"));
    try {
      const encrypted = encryptEcb(JPG);
      const result = await saveWechatImagesToUserUploads(
        {
          bindingUserId: "42",
          text: "这图讲了啥",
          images: [
            {
              fullUrl: "https://novac2c.cdn.weixin.qq.com/c2c/download?x=1",
              aesKeyHex: AES_KEY,
            },
          ],
        },
        {
          resolveUserMediaDirs: async (userId) => {
            assert.equal(userId, "c:42");
            return { kind: "ok", uid: 42, uploads: dir, generated: join(dir, "generated") };
          },
          fetchFn: (async () => new Response(new Uint8Array(encrypted), {
            status: 200,
            headers: { "content-length": String(encrypted.length) },
          })) as typeof fetch,
        },
      );
      assert.equal(result.count, 1);
      assert.equal(result.images[0]!.mimeType, "image/jpeg");
      assert.match(result.images[0]!.containerPath, /^\/home\/agent\/\.openclaude\/uploads\/wechat-/);
      assert.deepEqual(readFileSync(join(dir, result.images[0]!.filename)), JPG);
      assert.match(result.promptText, /这图讲了啥/);
      assert.match(result.promptText, /understand_image/);
      assert.match(result.promptText, /image_file/);
      assert.match(result.promptText, /不要说用户没有上传图片/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
