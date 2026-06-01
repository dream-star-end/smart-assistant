import * as assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { saveWechatMediaToUserUploads } from "../wechat/imageIngest.js";

const AES_KEY = "00112233445566778899aabbccddeeff";

describe("wechat media ingest save", () => {
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
});

function encryptEcb(plain: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(AES_KEY, "hex"), null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}
