/**
 * literatureSkill — renderLiteratureSkillContent 行为契约。
 *
 * 不碰 DB,纯 string render。覆盖:
 *   - 标题 / POST 路径 / 字段契约出现
 *   - default_size 透传到 prompt 文本(让 LLM 知道默认值,与 proxy 兜底一致)
 *   - 各类失败码守则出现(尤其 429 不重试)
 *   - **关键安全契约**(2026-05-20 修订):
 *     • prompt **必须**包含容器→master 的 Authorization Bearer 指令 + env 变量名
 *       `OPENCLAUDE_V3_CONTAINER_TOKEN`(否则 LLM 不知道带 header → 调用 100%
 *       401,见 literatureProxy.ts:373 verifyContainerIdentity 强制 Authorization)
 *     • prompt 仍**绝不**嵌入 `oc-v3.<id>.<secret>` 真实 token 值或 64-char hex
 *       secret(那是 supervisor 物化进 env 的容器身份,不应进入 system prompt)
 *     • 旧契约"prompt 不许出现 bearer/authorization"已废止 — 原意图是"proxy 路径
 *       透明注入 bearer",但 literatureProxy 实际没透明注入实现,旧契约和服务端
 *       自相矛盾导致功能不可用(2026-05-20 boss 截图反馈)
 *     • DeepXiv 上游 API key 仍**不暴露**(那是 platform→deepxiv.com 凭证,与
 *       容器身份 bearer 是两件事)
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { renderLiteratureSkillContent } from "../literatureSkill.js";

describe("renderLiteratureSkillContent", () => {
  test("contains heading + POST path + JSON body shape", () => {
    const out = renderLiteratureSkillContent({
      enabled: true,
      token_set: true,
      default_size: 10,
    });
    assert.match(out, /# 平台技能: 文献检索/);
    assert.match(out, /POST `\/v3\/literature\/search`/);
    assert.match(out, /"query":/);
    assert.match(out, /"size":/);
  });

  test("propagates default_size into prompt", () => {
    const out10 = renderLiteratureSkillContent({
      enabled: true,
      token_set: true,
      default_size: 10,
    });
    assert.match(out10, /默认 10/);
    const out25 = renderLiteratureSkillContent({
      enabled: true,
      token_set: true,
      default_size: 25,
    });
    assert.match(out25, /默认 25/);
    assert.equal(out25.includes("默认 10"), false);
  });

  test("documents 429/503/502/504 failure semantics", () => {
    const out = renderLiteratureSkillContent({
      enabled: true,
      token_set: true,
      default_size: 10,
    });
    assert.match(out, /429 quota_exceeded/);
    assert.match(out, /429 rate_limited/);
    assert.match(out, /503 disabled/);
    assert.match(out, /502\/504 upstream_/);
    // 429 quota 守则:不要重试
    assert.match(out, /quota_exceeded[^]*不要重试/);
  });

  test("instructs english query preference (recall optimization)", () => {
    const out = renderLiteratureSkillContent({
      enabled: true,
      token_set: true,
      default_size: 10,
    });
    assert.match(out, /英文检索/);
  });

  test("includes container bearer instruction but never leaks raw token", () => {
    // 关键安全契约(2026-05-20 修订,见文件头注 docstring):
    //   - prompt 必须 显式包含 Authorization Bearer 指令 + env 变量名,否则 LLM
    //     不知道带 header → literatureProxy 一律 401
    //   - prompt 仍绝不能嵌入 `oc-v3.<id>.<secret>` 真实 token 值或 64-char hex secret
    //   - DeepXiv 上游 API key 仍不暴露(api_key/apikey/X-API-Key 等关键字)
    //   - 渲染输入 LiteratureSkillConfig 的 boolean 字段不回显
    const out = renderLiteratureSkillContent({
      enabled: true,
      token_set: true,
      default_size: 10,
    });
    const lower = out.toLowerCase();

    // 必须出现:容器身份 bearer 指令
    assert.match(out, /Authorization:\s*Bearer/, "prompt must instruct caller to send Authorization: Bearer");
    assert.ok(out.includes("OPENCLAUDE_V3_CONTAINER_TOKEN"), "prompt must name the env var holding container bearer");

    // 仍绝禁止:真实 token 值 / DeepXiv 上游 API key 字样
    assert.equal(out.includes("oc-v3."), false, "raw oc-v3.<id>.<secret> token must NEVER appear in prompt");
    assert.equal(/[0-9a-f]{64}/i.test(out), false, "64-char hex secret pattern must NEVER appear in prompt");
    assert.equal(lower.includes("api_key"), false);
    assert.equal(lower.includes("apikey"), false);
    assert.equal(lower.includes("x-api-key"), false);
    // 渲染输入 LiteratureSkillConfig 的 boolean 字段不应被回显
    assert.equal(out.includes("token_set"), false);
    assert.equal(out.includes("enabled"), false); // 注:"disabled" 不含 "enabled" 子串,这条仍然成立
  });

  test("renderer is a pure function of its input — same input gives same output", () => {
    const a = renderLiteratureSkillContent({
      enabled: true,
      token_set: true,
      default_size: 10,
    });
    const b = renderLiteratureSkillContent({
      enabled: true,
      token_set: true,
      default_size: 10,
    });
    assert.equal(a, b);
  });
});
