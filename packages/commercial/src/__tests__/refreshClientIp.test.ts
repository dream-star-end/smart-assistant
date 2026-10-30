import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshClientIpFromRequest } from "../http/util.js";
import { validClientIp } from "../auth/clientIp.js";

test("loopback trusts one CF-Connecting-IP and ignores a spoofed or missing header", () => {
  assert.equal(refreshClientIpFromRequest("127.0.0.1", "203.0.113.10"), "203.0.113.10");
  assert.equal(refreshClientIpFromRequest("::1", "203.0.113.10"), "203.0.113.10");
  assert.equal(refreshClientIpFromRequest("::ffff:127.0.0.1", "203.0.113.10"), "203.0.113.10");
  assert.equal(refreshClientIpFromRequest("127.0.0.1", " 203.0.113.10 "), "203.0.113.10");
  assert.equal(refreshClientIpFromRequest("127.0.0.1", "::ffff:203.0.113.10"), "203.0.113.10");
  assert.equal(refreshClientIpFromRequest("127.0.0.1", undefined), null);
  assert.equal(refreshClientIpFromRequest("127.0.0.1", ""), null);
  assert.equal(refreshClientIpFromRequest("127.0.0.1", "203.0.113.10, 198.51.100.66"), null);
  assert.equal(refreshClientIpFromRequest("127.0.0.1", "not-an-ip"), null);
  assert.equal(refreshClientIpFromRequest("127.0.0.1", "0.0.0.0"), null);
  assert.equal(refreshClientIpFromRequest("127.0.0.1", ["203.0.113.10"]), "203.0.113.10");
  assert.equal(refreshClientIpFromRequest("127.0.0.1", ["203.0.113.10", "198.51.100.66"]), null);
});

test("a non-loopback socket is the client; CF-Connecting-IP cannot override it", () => {
  assert.equal(refreshClientIpFromRequest("203.0.113.8", "198.51.100.9"), "203.0.113.8");
  assert.equal(refreshClientIpFromRequest("::ffff:203.0.113.8", "198.51.100.9"), "203.0.113.8");
  assert.equal(refreshClientIpFromRequest("unknown", "203.0.113.10"), null);
  assert.equal(refreshClientIpFromRequest("", "203.0.113.10"), null);
});

test("validClientIp rejects blanks and wildcards", () => {
  assert.equal(validClientIp(null), null);
  assert.equal(validClientIp(undefined), null);
  assert.equal(validClientIp("  "), null);
  assert.equal(validClientIp("0.0.0.0"), null);
  assert.equal(validClientIp("::"), null);
  assert.equal(validClientIp("::ffff:203.0.113.10"), "203.0.113.10");
});
