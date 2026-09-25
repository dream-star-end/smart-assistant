import test from "node:test";
import assert from "node:assert/strict";
import { hashBoxToolInput } from "./boxToolInputHash.js";

test("tool input hash ignores object key order but not semantic changes", () => {
  const first = hashBoxToolInput({ value: "private", options: { b: 2, a: 1 } });
  const same = hashBoxToolInput({ options: { a: 1, b: 2 }, value: "private" });
  assert.equal(first, same);
  assert.notEqual(first, hashBoxToolInput({ options: { a: 1, b: 2 }, value: "other" }));
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("non-JSON, sparse and cyclic tool inputs fail before a journal write", () => {
  const sparse: unknown[] = [];
  sparse.length = 2;
  assert.throws(() => hashBoxToolInput({ values: sparse }), /BOX_TOOL_INPUT_INVALID/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => hashBoxToolInput(cyclic), /BOX_TOOL_INPUT_INVALID/);
  assert.throws(() => hashBoxToolInput({ value: undefined }), /BOX_TOOL_INPUT_INVALID/);
});
