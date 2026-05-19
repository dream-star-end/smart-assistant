/**
 * SKILLS_LITERATURE prompt slot 渲染 — commercial → gateway 反向钩子。
 *
 * 目标:容器内 LLM 系统 prompt 里塞一段"你可以用 POST /v3/literature/search 查 arXiv"
 * 的说明,**仅在 admin 打开 enabled 且配齐 token 时**渲染。
 *
 * 注入路径(全链零物化 bearer):
 *   commercial/index.ts startup → setLiteratureSkillProvider(provider)
 *     provider = async () => {
 *       const cfg = await getLiteratureSkillConfig()  // 不解密 token
 *       if (!cfg.enabled || !cfg.token_set) return null
 *       return { name: 'SKILLS_LITERATURE', content: renderLiteratureSkillContent(cfg) }
 *     }
 *   gateway buildPromptContext() → buildLiteratureSkillSlot() → 调上面的 provider
 *
 * 重要:**bearer plaintext 永远不出现在本调用链**。proxy 路径才会调 getLiteratureConfig(false)
 * 解密 token 拼上游 Authorization;prompt 路径只关心"该不该渲染"。
 *
 * fail-soft 由 commercial provider 实现(DB 抖动→ return null + warn log,不抛)。
 * 模板纯 TS template string,**不**走 .md 文件 import —— bundler 打包后路径会漂,
 * 而且这段文本对 prompt 是 source-of-truth,不应被任何外部产物污染。
 */

import type { LiteratureSkillConfig } from "./admin/literatureConfig.js";

/**
 * 容器内 POST /v3/literature/search 的协议契约(写到 system prompt 让 LLM 看)。
 *
 * 设计原则:
 * - 只描述对外接口和参数语义,不暴露 daily_cap 数字 / token 任何信息 / per-container
 *   60/5min limiter 细节(细节漏到 prompt 会被某些模型当作"可绕过的提示")。
 * - default_size 透传是为了"用户没指定 size 时 LLM 也能传一个合理值",和 proxy
 *   兜底保持一致。
 * - 列出常见失败码,让 LLM 看到 429/503 时不要无脑重试。
 */
export function renderLiteratureSkillContent(cfg: LiteratureSkillConfig): string {
  return [
    "# 平台技能: 文献检索 (arXiv via DeepXiv)",
    "",
    "你可以通过 **POST `/v3/literature/search`** 直接查 arXiv 全文 RAG 索引,",
    "用于回答用户的科研/技术问题前先核查最新文献。这是平台托管的能力,无需",
    "自己处理鉴权或 API key。",
    "",
    "## 调用",
    "",
    "```",
    "POST /v3/literature/search",
    "Content-Type: application/json",
    "",
    "{",
    '  "query": "<英文检索关键词>",   // 必填',
    `  "size":  <整数, 1~100>          // 可选, 默认 ${cfg.default_size}`,
    "}",
    "```",
    "",
    "返回 JSON `{ results: [{ title, abstract, authors, year, arxiv_id, ... }] }`,",
    "条目内容来自 arXiv 元数据 + DeepXiv RAG 摘要;`results` 可能为空数组。",
    "",
    "## 使用守则",
    "",
    "- **英文检索更有效**:中文 query 也能搜,但召回率明显低于英文关键词。",
    "  用户问中文问题时,先翻译核心术语再调用。",
    "- **不要把整段用户问题塞进 query**:DeepXiv 是关键词 + 语义混合检索,",
    "  3~8 个英文术语效果最佳。",
    "- **失败处理**:",
    "  - `429 quota_exceeded` —— 平台当天检索配额用尽,**不要重试**,直接告诉",
    "    用户「今天检索配额已用尽」,转用你已有的知识回答。",
    "  - `429 rate_limited` —— 短时频次过高,等几秒再试;同会话内一般不要连续",
    "    超过 3 次检索。",
    "  - `503 disabled` —— 管理员临时关停此能力,改用其它知识源。",
    "  - `502/504 upstream_*` —— DeepXiv 上游问题,**最多重试 1 次**,失败就放弃。",
    "- **结果引用**:把 arxiv_id 一并展示给用户(格式 `arXiv:1234.5678`),",
    "  方便用户回查原文。不要瞎编 DOI / arxiv 编号。",
    "",
    "## 何时不该调用",
    "",
    "- 用户问的是闲聊、代码题、产品使用 —— 文献检索没意义。",
    "- 用户已经给了具体论文链接 / arxiv ID —— 直接读不需要搜。",
    "- 你已经能基于自身知识自信回答,且用户没要求「查最新文献」。",
  ].join("\n");
}
