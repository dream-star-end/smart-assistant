/**
 * literatureSkill — renderLiteratureSkillContent 行为契约。
 *
 * 不碰 DB,纯 string render。覆盖:
 *   - 标题 / POST 路径 / 字段契约出现
 *   - default_size 透传到 prompt 文本(让 LLM 知道默认值,与 proxy 兜底一致)
 *   - 各类失败码守则出现(尤其 429 不重试)
 *   - **关键安全契约**:渲染输入的 LiteratureSkillConfig 不包含 token,出参也绝不
 *     出现 bearer-related 字样(避免 prompt 写出"Authorization Bearer xxx"等
 *     被某些模型当作可解释的字段)
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

  test("never leaks token / bearer / authorization keywords", () => {
    // 关键安全契约:prompt 文本里绝不能出现引导 LLM 关注"鉴权细节"的字样,
    // 也不能出现任何看起来像 token 占位符的内容 —— 容器侧 LLM 不需要知道
    // master 怎么塞 bearer,proxy 路径会做完整鉴权。
    const out = renderLiteratureSkillContent({
      enabled: true,
      token_set: true,
      default_size: 10,
    });
    const lower = out.toLowerCase();
    assert.equal(lower.includes("bearer"), false, "must not mention 'bearer' in prompt");
    assert.equal(lower.includes("authorization:"), false, "must not show Authorization header");
    assert.equal(lower.includes("api_key"), false);
    assert.equal(lower.includes("apikey"), false);
    // token_set boolean 不应被回显
    assert.equal(out.includes("token_set"), false);
    assert.equal(out.includes("enabled"), false);
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
