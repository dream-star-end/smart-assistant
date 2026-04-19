import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadKmsKey, KmsKeyError, zeroBuffer, KMS_KEY_BYTES } from "../crypto/keys.js";
import { encrypt, decrypt, AeadError, NONCE_BYTES } from "../crypto/aead.js";

/** 生成测试用 32 字节 key,返回 { key, b64 } 便于不同测试场景 */
function freshKey(): { key: Buffer; b64: string } {
  const key = randomBytes(KMS_KEY_BYTES);
  return { key, b64: key.toString("base64") };
}

describe("crypto.keys.loadKmsKey", () => {
  test("loads a valid 32-byte base64 key", () => {
    const { key, b64 } = freshKey();
    const loaded = loadKmsKey({ OPENCLAUDE_KMS_KEY: b64 });
    assert.equal(loaded.length, KMS_KEY_BYTES);
    assert.ok(loaded.equals(key));
  });

  test("throws when env var is missing", () => {
    assert.throws(() => loadKmsKey({}), (err: unknown) => {
      return err instanceof KmsKeyError && /not set/i.test((err as Error).message);
    });
  });

  test("throws when env var is empty string", () => {
    assert.throws(() => loadKmsKey({ OPENCLAUDE_KMS_KEY: "" }), KmsKeyError);
  });

  test("throws when decoded length ≠ 32 (too short)", () => {
    const short = randomBytes(16).toString("base64");
    assert.throws(
      () => loadKmsKey({ OPENCLAUDE_KMS_KEY: short }),
      (err: unknown) =>
        err instanceof KmsKeyError &&
        /must decode to exactly 32 bytes/i.test((err as Error).message) &&
        /got 16/.test((err as Error).message),
    );
  });

  test("throws when decoded length ≠ 32 (too long)", () => {
    const long = randomBytes(48).toString("base64");
    assert.throws(
      () => loadKmsKey({ OPENCLAUDE_KMS_KEY: long }),
      (err: unknown) =>
        err instanceof KmsKeyError && /got 48/.test((err as Error).message),
    );
  });

  test("error message does not leak raw env value", () => {
    const secret = randomBytes(8).toString("base64");
    try {
      loadKmsKey({ OPENCLAUDE_KMS_KEY: secret });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof KmsKeyError);
      assert.ok(
        !(err as Error).message.includes(secret),
        "error message must not contain the raw secret",
      );
    }
  });
});

describe("crypto.keys.zeroBuffer", () => {
  test("fills buffer with zeros in place", () => {
    const b = Buffer.from("supersecret!!!");
    zeroBuffer(b);
    for (const byte of b) {
      assert.equal(byte, 0);
    }
  });
});

describe("crypto.aead.encrypt/decrypt", () => {
  test("roundtrip: plaintext survives encrypt → decrypt", () => {
    const { key } = freshKey();
    const plaintext = "sk-ant-sid01-REDACTED-secret-token-abc123";
    const { ciphertext, nonce } = encrypt(plaintext, key);
    assert.ok(ciphertext.length > plaintext.length, "ciphertext includes tag");
    assert.equal(nonce.length, NONCE_BYTES);
    const back = decrypt(ciphertext, nonce, key);
    assert.equal(back, plaintext);
  });

  test("roundtrip: with AAD", () => {
    const { key } = freshKey();
    const plaintext = "refresh-token-xyz";
    const aad = Buffer.from("user:42");
    const { ciphertext, nonce } = encrypt(plaintext, key, aad);
    const back = decrypt(ciphertext, nonce, key, aad);
    assert.equal(back, plaintext);
  });

  test("decrypt fails when AAD does not match", () => {
    const { key } = freshKey();
    const { ciphertext, nonce } = encrypt("plain", key, Buffer.from("user:42"));
    assert.throws(
      () => decrypt(ciphertext, nonce, key, Buffer.from("user:99")),
      AeadError,
    );
  });

  test("decrypt fails when a single ciphertext byte is flipped", () => {
    const { key } = freshKey();
    const { ciphertext, nonce } = encrypt("hello world", key);
    const mutated = Buffer.from(ciphertext);
    mutated[0] = mutated[0] ^ 0x01;
    assert.throws(() => decrypt(mutated, nonce, key), AeadError);
  });

  test("decrypt fails when tag is truncated", () => {
    const { key } = freshKey();
    const { ciphertext, nonce } = encrypt("payload", key);
    const truncated = ciphertext.subarray(0, ciphertext.length - 1);
    assert.throws(() => decrypt(truncated, nonce, key), AeadError);
  });

  test("decrypt fails when nonce does not match", () => {
    const { key } = freshKey();
    const { ciphertext } = encrypt("nonce-binding", key);
    const wrongNonce = Buffer.alloc(NONCE_BYTES, 0);
    assert.throws(() => decrypt(ciphertext, wrongNonce, key), AeadError);
  });

  test("decrypt fails when key is different", () => {
    const { key: k1 } = freshKey();
    const { key: k2 } = freshKey();
    const { ciphertext, nonce } = encrypt("key-binding", k1);
    assert.throws(() => decrypt(ciphertext, nonce, k2), AeadError);
  });

  test("nonce is unique across 1000 successive encryptions", () => {
    const { key } = freshKey();
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const { nonce } = encrypt("same-plaintext", key);
      seen.add(nonce.toString("hex"));
    }
    assert.equal(seen.size, 1000, "all 1000 nonces must be unique");
  });

  test("encrypt throws on wrong key length", () => {
    const short = randomBytes(16);
    assert.throws(() => encrypt("x", short), AeadError);
  });

  test("decrypt throws on wrong nonce length", () => {
    const { key } = freshKey();
    const { ciphertext } = encrypt("x", key);
    assert.throws(
      () => decrypt(ciphertext, Buffer.alloc(8), key),
      (err: unknown) => err instanceof AeadError && /nonce must be 12/.test((err as Error).message),
    );
  });

  test("decrypt throws when ciphertext is shorter than tag", () => {
    const { key } = freshKey();
    assert.throws(
      () => decrypt(Buffer.alloc(8), Buffer.alloc(NONCE_BYTES), key),
      AeadError,
    );
  });

  test("encrypt accepts Buffer plaintext", () => {
    const { key } = freshKey();
    const pt = Buffer.from([0x00, 0x01, 0xff]);
    const { ciphertext, nonce } = encrypt(pt, key);
    // Note: decrypt() returns UTF-8 string; 0xff alone is not valid UTF-8,
    // v8 will replace it with U+FFFD. We just want to prove encrypt()
    // didn't choke on a raw Buffer input.
    assert.ok(ciphertext.length > 0);
    const back = decrypt(ciphertext, nonce, key);
    assert.equal(typeof back, "string");
  });

  test("same plaintext encrypted twice yields different ciphertext (nonce randomness)", () => {
    const { key } = freshKey();
    const a = encrypt("identical", key);
    const b = encrypt("identical", key);
    assert.ok(!a.ciphertext.equals(b.ciphertext), "ciphertexts must differ (random nonce)");
    assert.ok(!a.nonce.equals(b.nonce), "nonces must differ");
  });
});
