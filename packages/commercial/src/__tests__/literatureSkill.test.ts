/**
 * literatureSkill — renderLiteratureSkillContent 行为契约。
 *
 * 不碰 DB,纯 string render。覆盖:
 *   - 标题 / POST 路径 / 字段契约出现
 *   - default_size 透传到 prompt 文本(让 LLM 知道默认值,与 proxy 兜底一致)
 *   - 各类失败码守则出现(尤其 429 不重试)
 *   - **关键安全契约**(2026-05-20 修订,v1.0.180 强化):
 *     • prompt **必须**包含容器→master 的 Authorization Bearer 指令 + env 变量名
 *       `OPENCLAUDE_V3_CONTAINER_TOKEN`(否则 LLM 不知道带 header → 调用 100%
 *       401,见 literatureProxy.ts:373 verifyContainerIdentity 强制 Authorization)
 *     • prompt **必须**用 `${ANTHROPIC_BASE_URL%/}/v3/literature/search` 作完整 URL
 *       (v1.0.179 只给相对路径 LLM 编出 https://api.claudeai.chat 公网域名 → DNS
 *       失败,boss 截图反馈)。同时**绝禁**任何公网域名字面量出现在 prompt 文本里
 *       (claudeai.chat / api.anthropic.com 之类一旦出现就会被 LLM 误抄当作可用 host)
 *     • prompt **必须**含强 token 安全守则(echo / printenv / curl -v / --trace /
 *       set -x / /proc/ + "不要打印或回显"),v1.0.179 的弱警告没压住 LLM "先 echo
 *       验证 env" 的惯性,user 1 把 prefix+id+9 hex 都暴露到 UI(boss 截图反馈)
 *     • prompt 仍**绝不**嵌入 `oc-v3.<id>.<secret>` 真实 token 值或 64-char hex
 *       secret(那是 supervisor 物化进 env 的容器身份,不应进入 system prompt)
 *     • DeepXiv 上游 API key 仍**不暴露**(那是 platform→deepxiv.com 凭证,与
 *       容器身份 bearer 是两件事;不在 prompt 里出现 api_key/apikey/X-API-Key)
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

  test("uses ANTHROPIC_BASE_URL env for base URL — never hard-codes public domain", () => {
    // v1.0.180 修复(boss 截图反馈 2026-05-20):
    // v1.0.179 prompt 只写 "POST /v3/literature/search" 相对路径 → LLM 没看到
    // base URL 就自己编了 https://api.claudeai.chat/... → CURLE_COULDNT_RESOLVE_HOST。
    // 修复后必须用 ${ANTHROPIC_BASE_URL%/}/v3/literature/search,且严禁任何
    // 公网域名字面量出现在 prompt 文本(LLM 看到就会误抄当备选)。
    const out = renderLiteratureSkillContent({
      enabled: true,
      token_set: true,
      default_size: 10,
    });
    // 必须出现完整 URL 模板,${ANTHROPIC_BASE_URL%/} 拼接 path
    assert.ok(
      out.includes("${ANTHROPIC_BASE_URL%/}/v3/literature/search"),
      "prompt must show full URL template using ${ANTHROPIC_BASE_URL%/} prefix",
    );
    assert.ok(
      out.includes("ANTHROPIC_BASE_URL"),
      "prompt must name the env var holding container→master gateway base URL",
    );
    // 严禁公网域名字面量
    assert.equal(out.includes("claudeai.chat"), false, "prompt must NOT mention claudeai.chat");
    assert.equal(out.includes("api.anthropic.com"), false, "prompt must NOT mention api.anthropic.com");
    assert.equal(out.includes("anthropic.com"), false, "prompt must NOT mention anthropic.com");
  });

  test("includes strong token-safety section — explicit prohibitions on env echo / debug modes", () => {
    // v1.0.180 修复(boss 截图反馈 2026-05-20):
    // v1.0.179 只说"不要打印或回显" → LLM 仍按"先 echo $TOKEN | head -c 20 验证存在"
    // 的惯性把 prefix + container_id + 9 hex 都暴露到 UI。
    // 修复后必须列举具体被禁操作,并明确告诉 LLM "env 一定有,不需要验证"。
    const out = renderLiteratureSkillContent({
      enabled: true,
      token_set: true,
      default_size: 10,
    });
    // 显式禁止列表
    assert.ok(out.includes("echo"), "prompt must mention echo as forbidden");
    assert.ok(out.includes("printenv"), "prompt must mention printenv as forbidden");
    assert.ok(out.includes("head -c"), "prompt must reject head -c N truncation");
    assert.ok(out.includes("curl -v"), "prompt must reject curl -v");
    assert.ok(out.includes("--trace"), "prompt must reject curl --trace");
    assert.ok(out.includes("set -x"), "prompt must reject shell tracing (set -x)");
    assert.ok(out.includes("/proc/"), "prompt must reject /proc/<pid>/environ reads");
    // 明确 "env 一定有, 不需要验证" 反惯性话术
    assert.match(out, /一定.*注入|env.*一定|不需要.*验证|不应该.*验证/);
    // 401 行为:不要打印 token 来 debug
    assert.match(out, /401[^]*?不要.*(打印|检查|debug)/);
  });

  test("provides safe -w HTTP_STATUS escape hatch for status-code inspection", () => {
    // Codex v1.0.180 code-review feedback (2026-05-20):
    // 仅说"看 status code 和 body 调试" + 模板 curl 没显示 status → 给 LLM 留了
    // "我加 -v 看 status 总可以吧" 的逃生口。修复:模板内置 -w '%{http_code}',
    // 并显式说"如需 status 只允许 -w,严禁 -v / --trace / -i / --include"。
    const out = renderLiteratureSkillContent({
      enabled: true,
      token_set: true,
      default_size: 10,
    });
    // -w '...%{http_code}...' 模板必须出现在 prompt
    assert.ok(out.includes("%{http_code}"), "prompt must show -w '%{http_code}' as the sanctioned way to read status");
    assert.ok(out.includes("HTTP_STATUS"), "prompt must label the status output for LLM parsability");
    // 显式拒绝其它"看 header / status"路径(--include / -i 会回显请求头含 Authorization)
    // 强契约:必须出现在"严禁"句子里,不是某处提到名字就完事
    assert.match(out, /严禁[^。\n]*(?:-i|--include)/, "prompt must explicitly forbid -i / --include (would print Authorization header)");
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
