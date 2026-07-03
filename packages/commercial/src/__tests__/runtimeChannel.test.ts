import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  dockerContainerOwnedByChannel,
  getCodexAccountRuntimeChannel,
  getRuntimeChannel,
  isV5Channel,
} from "../runtimeChannel.js";

// runtimeChannel 是 v3/v5 容器隔离的单一权威(OC_RUNTIME_CHANNEL)。本测试锁住:
//   - 默认 'v3'(未设 env → 现网零行为变化)
//   - 'v5' 生效
//   - 非法值 fail-closed throw(Codex P1a 审要求:防误配 'V5'/' v5 '/typo 污染容器名·卷名·DB 过滤)
// 防回归:若有人日后把 fail-closed 改回静默默认,本测试会红。

describe("runtimeChannel", () => {
  const saved = process.env.OC_RUNTIME_CHANNEL;
  const savedCodex = process.env.OC_CODEX_ACCOUNT_RUNTIME_CHANNEL;
  beforeEach(() => {
    delete process.env.OC_RUNTIME_CHANNEL;
    delete process.env.OC_CODEX_ACCOUNT_RUNTIME_CHANNEL;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.OC_RUNTIME_CHANNEL;
    else process.env.OC_RUNTIME_CHANNEL = saved;
    if (savedCodex === undefined) delete process.env.OC_CODEX_ACCOUNT_RUNTIME_CHANNEL;
    else process.env.OC_CODEX_ACCOUNT_RUNTIME_CHANNEL = savedCodex;
  });

  it("未设 env → 默认 v3(现网零行为变化)", () => {
    assert.equal(getRuntimeChannel(), "v3");
    assert.equal(isV5Channel(), false);
  });

  it("空字符串 / 纯空白 → 默认 v3", () => {
    process.env.OC_RUNTIME_CHANNEL = "";
    assert.equal(getRuntimeChannel(), "v3");
    process.env.OC_RUNTIME_CHANNEL = "   ";
    assert.equal(getRuntimeChannel(), "v3");
  });

  it("OC_RUNTIME_CHANNEL=v5 → v5 + isV5Channel()=true", () => {
    process.env.OC_RUNTIME_CHANNEL = "v5";
    assert.equal(getRuntimeChannel(), "v5");
    assert.equal(isV5Channel(), true);
  });

  it("带前后空白的 'v5' 被 trim 后认作 v5", () => {
    process.env.OC_RUNTIME_CHANNEL = "  v5  ";
    assert.equal(getRuntimeChannel(), "v5");
  });


  it("Codex account channel defaults to runtime channel, but can be overridden", () => {
    assert.equal(getCodexAccountRuntimeChannel(), "v3");
    process.env.OC_RUNTIME_CHANNEL = "v5";
    assert.equal(getCodexAccountRuntimeChannel(), "v5");
    process.env.OC_CODEX_ACCOUNT_RUNTIME_CHANNEL = "v3";
    assert.equal(getCodexAccountRuntimeChannel(), "v3");
  });

  it("invalid Codex account channel fail-closes independently", () => {
    process.env.OC_RUNTIME_CHANNEL = "v5";
    process.env.OC_CODEX_ACCOUNT_RUNTIME_CHANNEL = "prod";
    assert.throws(() => getCodexAccountRuntimeChannel(), /非法 OC_CODEX_ACCOUNT_RUNTIME_CHANNEL/);
  });

  it("非法值(大写/typo/其它 channel)fail-closed throw", () => {
    for (const bad of ["V5", "V3", "v4", "v6", "prod", "x"]) {
      process.env.OC_RUNTIME_CHANNEL = bad;
      assert.throws(() => getRuntimeChannel(), /非法 OC_RUNTIME_CHANNEL/, `应对 '${bad}' 抛错`);
    }
  });
});

describe("dockerContainerOwnedByChannel(非对称归属)", () => {
  it("v5 实例:只认 label==='v5' 的容器", () => {
    assert.equal(dockerContainerOwnedByChannel("v5", "v5"), true);
    assert.equal(dockerContainerOwnedByChannel("v3", "v5"), false);
    assert.equal(dockerContainerOwnedByChannel(undefined, "v5"), false); // 无 label 不归 v5
  });
  it("v3 实例:认 'v3' + 无 label 存量,但不碰 v5", () => {
    assert.equal(dockerContainerOwnedByChannel("v3", "v3"), true);
    assert.equal(dockerContainerOwnedByChannel(undefined, "v3"), true); // 存量无 label 容器归 v3(关键)
    assert.equal(dockerContainerOwnedByChannel("v5", "v3"), false); // v3 不删 v5 容器
  });
});
