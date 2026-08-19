import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Spec twin of sanitize_json_text_for_jsonb (0232). Production lives in SQL;
 * this port exists so the odd/even backslash contract can fail closed without PG.
 *
 * A \uXXXX is a real JSON escape only when the run of backslashes immediately
 * before "uXXXX" has odd length: \u0000 is an escape, \\u0000 is a literal
 * backslash plus the text u0000.
 */
export function sanitizeJsonTextForJsonb(src: string): string {
  const n = src.length;
  let i = 0;
  let out = "";
  while (i < n) {
    const slash = src.indexOf("\\", i);
    if (slash < 0) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, slash);
    let bs = 0;
    while (slash + bs < n && src[slash + bs] === "\\") bs += 1;
    const even = (bs >> 1) << 1;
    out += "\\".repeat(even);
    if (bs % 2 === 0) {
      i = slash + bs;
      continue;
    }
    const after = slash + bs;
    const hex = src.slice(after + 1, after + 5);
    if (src[after] === "u" && /^[0-9A-Fa-f]{4}$/.test(hex)) {
      const code = Number.parseInt(hex, 16);
      if (code === 0) {
        out += "\\ufffd";
        i = after + 5;
        continue;
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        const nxt = after + 5;
        const hex2 = src.slice(nxt + 2, nxt + 6);
        if (src[nxt] === "\\" && src[nxt + 1] === "u" && /^[0-9A-Fa-f]{4}$/.test(hex2)) {
          const paired = Number.parseInt(hex2, 16);
          if (paired >= 0xdc00 && paired <= 0xdfff) {
            out += src.slice(slash + even, nxt + 6);
            i = nxt + 6;
            continue;
          }
        }
        out += "\\ufffd";
        i = after + 5;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        out += "\\ufffd";
        i = after + 5;
        continue;
      }
      out += src.slice(slash + even, after + 5);
      i = after + 5;
      continue;
    }
    out += "\\";
    i = slash + even + 1;
  }
  return out;
}

test("replaces \\u0000 escape with \\ufffd", () => {
  assert.equal(sanitizeJsonTextForJsonb('{"a":"\\u0000"}'), '{"a":"\\ufffd"}');
});

test("does not replace even-backslash literal \\\\u0000", () => {
  assert.equal(sanitizeJsonTextForJsonb('{"a":"\\\\u0000"}'), '{"a":"\\\\u0000"}');
});

test("replaces odd-backslash \\\\\\u0000 (literal backslash + NUL escape)", () => {
  assert.equal(sanitizeJsonTextForJsonb('{"a":"\\\\\\u0000"}'), '{"a":"\\\\\\ufffd"}');
});

test("replaces unpaired high and low surrogates", () => {
  assert.equal(sanitizeJsonTextForJsonb('"\\uD800"'), '"\\ufffd"');
  assert.equal(sanitizeJsonTextForJsonb('"\\udc00"'), '"\\ufffd"');
  assert.equal(sanitizeJsonTextForJsonb('"\\uD800\\uD800"'), '"\\ufffd\\ufffd"');
});

test("keeps a valid surrogate pair", () => {
  assert.equal(sanitizeJsonTextForJsonb('"\\uD800\\uDC00"'), '"\\uD800\\uDC00"');
  assert.equal(sanitizeJsonTextForJsonb('"\\ud800\\udc00"'), '"\\ud800\\udc00"');
});

test("does not treat \\\\uD800 as a surrogate escape", () => {
  assert.equal(sanitizeJsonTextForJsonb('"\\\\uD800"'), '"\\\\uD800"');
});
