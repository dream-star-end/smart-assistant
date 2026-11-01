import assert from "node:assert/strict";
import test from "node:test";
import { emitJsonString, jsonIdentityStamp, proxyBodyUtf8Bytes, stampsEqual } from "./boxPureMemo.js";

function encoded(value: string): string {
  const parts: string[] = [];
  emitJsonString(value, (part) => parts.push(part));
  return parts.join("");
}

test("long JSON strings keep JSON.stringify bytes", () => {
  const samples = ["", "a", "A".repeat(1023), "A".repeat(1024), `${"A".repeat(5000)}+/=`];
  for (let code = 0; code < 128; code += 1) samples.push(String.fromCharCode(code).repeat(1100));
  samples.push("雪".repeat(800), "\n".repeat(400), "\\".repeat(400),
    `${"A".repeat(500)}"quote${"B".repeat(600)}`);
  for (const sample of samples) assert.equal(encoded(sample), JSON.stringify(sample));
});

test("prefix identity follows insertion order and sees short-field edits", () => {
  const payload = "A".repeat(5000);
  const left = jsonIdentityStamp([{ b: 1, a: payload }]);
  const right = jsonIdentityStamp([{ a: payload, b: 1 }]);
  assert.ok(left && right);
  assert.equal(stampsEqual(left, right), false);
  const again = jsonIdentityStamp([{ b: 1, a: payload }]);
  assert.ok(again);
  assert.equal(stampsEqual(left, again), true);
  const box = { b: 1, a: payload };
  const before = jsonIdentityStamp([box]);
  box.b = 2;
  const after = jsonIdentityStamp([box]);
  assert.ok(before && after);
  assert.equal(stampsEqual(before, after), false);
  const hole: unknown[] = ["a"];
  hole.length = 3;
  assert.equal(jsonIdentityStamp(hole), null);
});

test("body byte length matches JSON.stringify when messages are supplied", () => {
  const payload = "A".repeat(2048);
  const bodies: object[] = [
    { model: "m", messages: [{ role: "user", content: payload }], tools: [{ name: "Z" }] },
    { messages: [{ t: "雪" }], model: "m" },
    { model: "m", skip: undefined, messages: [1, null, "ok"], tail: true },
    { model: "m", messages: [] },
    { model: "m", messages: [{ q: "\"\\雪", n: 1 }] },
  ];
  for (const body of bodies) {
    const messages = (body as { messages: unknown }).messages;
    const messagesJson = JSON.stringify(messages);
    assert.equal(proxyBodyUtf8Bytes(body, messagesJson), Buffer.byteLength(JSON.stringify(body)));
  }
  const tricky = { toJSON() { return { messages: [1] }; }, messages: [{ t: payload }] };
  assert.equal(proxyBodyUtf8Bytes(tricky, JSON.stringify(tricky.messages)),
    Buffer.byteLength(JSON.stringify(tricky)));
});
