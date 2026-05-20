/**
 * SKILLS_LITERATURE prompt slot 渲染 — commercial → gateway 反向钩子。
 *
 * 目标:容器内 LLM 系统 prompt 里塞一段"你可以用 POST /v3/literature/search 查 arXiv"
 * 的说明,**仅在 admin 打开 enabled 且配齐 token 时**渲染。
 *
 * 注入路径(本路径不解密 DeepXiv 上游 token):
 *   commercial/index.ts startup → setLiteratureSkillProvider(provider)
 *     provider = async () => {
 *       const cfg = await getLiteratureSkillConfig()  // 不解密 token
 *       if (!cfg.enabled || !cfg.token_set) return null
 *       return { name: 'SKILLS_LITERATURE', content: renderLiteratureSkillContent(cfg) }
 *     }
 *   gateway buildPromptContext() → buildLiteratureSkillSlot() → 调上面的 provider
 *
 * 重要 — 两种 "bearer" 不能混淆:
 *   1) **DeepXiv 上游 API token**(DB 加密,平台→deepxiv.com 的凭证):**永远不出现
 *      在本调用链**。proxy 路径才会调 getLiteratureConfig(false) 解密拼上游
 *      Authorization;prompt 路径只关心"该不该渲染"。
 *   2) **容器→master 的 oc-v3 身份 bearer**(容器 env `OPENCLAUDE_V3_CONTAINER_TOKEN`):
 *      与 (1) 完全无关,是 verifyContainerIdentity() 要求的双因子之一(见
 *      literatureProxy.ts:373)。**必须**在渲染文本里告知 LLM "调用时带
 *      `Authorization: Bearer <env 值>`",否则 LLM 不带 header → 401。env 名
 *      是公开常量(supervisor 注入清单的一部分),不算 secret;token 真实值
 *      不嵌入 prompt 文本。
 *
 * Base URL — 容器内调用必须用 `${ANTHROPIC_BASE_URL}`(supervisor 注入,self host =
 * http://172.30.0.1:18791,remote host = http://172.30.X.1:18791;`/v3/literature/search`
 * 与 anthropic `/v1/messages` 共用同一 listener,见 commercial/src/index.ts:1057)。
 * 不暴露具体 IP 字面量 — `$ANTHROPIC_BASE_URL` 已经对 self/remote 拓扑透明。
 * Prompt 里**绝不**写任何公网域名(claudeai.chat / api.anthropic.com 等)作为
 * 反例提示 —— 出现在 prompt 里就会被 LLM 当成"可用 base url 之一"误抄。
 *
 * Token 安全(v1.0.180 强化,见文件头 docstring):
 *   - v1.0.179 prompt 弱警告"不要打印或回显"没压住 LLM 的"先 echo 验证"惯性
 *     (boss 截图 2026-05-20 user 1 跑 `echo $TOKEN | head -c 20` 把 prefix+id+9 hex
 *     都暴露到 UI)
 *   - 新版列举具体禁止操作 + 解释"env 一定有,不需要验证" + "401 不是 token 问题"
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
 * - 只描述对外接口和参数语义,不暴露 daily_cap 数字 / DeepXiv 上游 API key 任何
 *   信息 / per-container 60/5min limiter 细节(细节漏到 prompt 会被某些模型当作
 *   "可绕过的提示")。
 * - Base URL 用 `$ANTHROPIC_BASE_URL`(supervisor 已注入,跨 self/remote host
 *   透明)。**不**写裸 IP 也**不**写公网域名,prompt 里出现公网域名会被 LLM 误抄。
 * - 容器身份 bearer 必须显式说明(否则 LLM 不带 Authorization → 401);但只暴露
 *   env 变量名 `OPENCLAUDE_V3_CONTAINER_TOKEN`,**不**嵌入 `oc-v3.*` 真实 token
 *   值。env 名是 supervisor 注入清单的公开常量,不算 secret。
 * - Token 安全 section 列举具体禁止操作(echo / printenv / curl -v / set -x /
 *   读 /proc/<pid>/environ 等),靠 prompt 直接关死 LLM"验证后调用"的惯性。
 * - default_size 透传是为了"用户没指定 size 时 LLM 也能传一个合理值",和 proxy
 *   兜底保持一致。
 * - 列出常见失败码,让 LLM 看到 429/503 时不要无脑重试。
 */
export function renderLiteratureSkillContent(cfg: LiteratureSkillConfig): string {
  return [
    "# 平台技能: 文献检索 (arXiv via DeepXiv)",
    "",
    "你可以通过 **POST `/v3/literature/search`** 直接查 arXiv 全文 RAG 索引,",
    "用于回答用户的科研/技术问题前先核查最新文献。DeepXiv 上游凭证由平台托管,",
    "你**不需要**也**不应该**关心 API key — 但容器→master 这一跳需要带容器",
    "身份 bearer(下面会说明)。",
    "",
    "## ⚠️ Token 安全 — 严格遵守",
    "",
    "`OPENCLAUDE_V3_CONTAINER_TOKEN` 在每个容器启动时**一定**被平台注入,",
    "你不需要也不应该验证它是否存在,直接拼进 curl 即可。",
    "",
    "**严禁** 任何形式让该 env 的值出现在 stdout / stderr / 对话 UI:",
    "",
    "- 不要 `echo $OPENCLAUDE_V3_CONTAINER_TOKEN`、`printenv` / `env` / `set` / `printf $...`",
    "- 不要 `echo $... | head -c N`、`${VAR:0:N}` 字串切片 ——",
    "  即便截断也是泄漏(prefix + 容器编号 + 部分 secret 足以被复用攻击),**截断也不行**",
    "- 不要 `curl -v` / `curl --trace` / `curl --trace-ascii` 调试请求头",
    "- 不要 `set -x` / `bash -x` 让 shell 把展开后的命令回显",
    "- 不要读 `/proc/*/environ` 或 `/proc/self/environ`",
    "- 调用 **失败时也不要打印 token 来 debug**:401 不是 \"token 缺失\" 问题(env",
    "  一定有),通常是网络或服务端问题,只看 HTTP 状态码和 response body 即可",
    "",
    "curl 自己**不会**把 `-H` 头打印到 stdout(除非加 `-v`),所以直接 shell 展开即可,",
    "安全。",
    "",
    "## 调用",
    "",
    "```sh",
    `curl -sS -X POST "\${ANTHROPIC_BASE_URL%/}/v3/literature/search" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Authorization: Bearer \${OPENCLAUDE_V3_CONTAINER_TOKEN}" \\`,
    `  -d '{"query": "<英文检索关键词>", "size": ${cfg.default_size}}' \\`,
    `  -w '\\nHTTP_STATUS:%{http_code}\\n'`,
    "```",
    "",
    "如需查看 HTTP 状态码,**只允许** 加 `-w '\\nHTTP_STATUS:%{http_code}\\n'`",
    "(已在上面模板里);**严禁** 用 `-v` / `--trace` / `--trace-ascii` / `-i` /",
    "`--include` —— 这些会把请求头(含 Authorization)一并打印,等价于 token 泄漏。",
    "",
    "Base URL 必须用 `$ANTHROPIC_BASE_URL`(容器启动时由平台注入,指向容器→master",
    "的平台内部网关,与 anthropic `/v1/messages` 共用同一 listener)。**不要发明或",
    "猜测任何公网 API host**(容器 egress 拦不通,只能走 `$ANTHROPIC_BASE_URL`)。",
    "",
    "- 字段:`query` (string, 必填,建议英文 3~8 个术语);",
    `  \`size\` (int, 1~100, 可选, 默认 ${cfg.default_size})。`,
    "- 鉴权:仅 `Authorization: Bearer ${OPENCLAUDE_V3_CONTAINER_TOKEN}`。",
    "  **不要** 加 `X-OC-Nonce` / `X-OC-Bridge-Nonce` 或任何其它 auth header —",
    "  那些属于完全不同的内部通道,本接口一律 401。",
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
    "  - `401` —— **不要** 打印或检查 token 来 debug(env 一定有),直接告诉用户",
    "    「文献检索鉴权异常」,转用你已有的知识回答。",
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
