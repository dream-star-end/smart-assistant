import test from "node:test";
import assert from "node:assert/strict";
import { boxFastPathEnabled } from "./boxFastPath.js";

test("one Box fast-path switch defaults on only for selfhost", () => {
  const instance = process.env.OC_INSTANCE_ID;
  const setting = process.env.OC_BOX_FAST_NATIVE;
  try {
    process.env.OC_INSTANCE_ID = "v5-selfhost-sg";
    delete process.env.OC_BOX_FAST_NATIVE;
    assert.equal(boxFastPathEnabled(), true);
    process.env.OC_BOX_FAST_NATIVE = "0";
    assert.equal(boxFastPathEnabled(), false);
    process.env.OC_INSTANCE_ID = "v5-kl-mirror";
    delete process.env.OC_BOX_FAST_NATIVE;
    assert.equal(boxFastPathEnabled(), false);
    process.env.OC_BOX_FAST_NATIVE = "1";
    assert.equal(boxFastPathEnabled(), true);
    process.env.OC_BOX_FAST_NATIVE = "0";
    assert.equal(boxFastPathEnabled(), false);
  } finally {
    if (instance === undefined) delete process.env.OC_INSTANCE_ID;
    else process.env.OC_INSTANCE_ID = instance;
    if (setting === undefined) delete process.env.OC_BOX_FAST_NATIVE;
    else process.env.OC_BOX_FAST_NATIVE = setting;
  }
});
