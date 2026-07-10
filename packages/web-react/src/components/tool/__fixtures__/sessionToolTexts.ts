// 真实会话 fixture(boss 工具卡演示会话 webmrf3jrqke3ce0j, 2026-07-10)。
// 用途:钉死 mcp-memory 现网文本格式与 codex 事件形态,解析器测试必须过真实数据。
// 注意 LIST_REMINDERS_TEXT 第三条标题内嵌换行——这是击穿旧解析器的真实案例,不许"修"fixture。

export const SKILL_LIST_TEXT = "You have 36 skill(s):\n\n## Platform baseline (read-only)\n\n### browser\n用 `oc-browser` 命令行操作真实浏览器(有状态,跨调用共享同一会话):导航、抓 accessibility 快照拿元素 ref、按 ref 点击/输入、截图、等待。用户要打开网页、点按钮、填表单、登录、抓动态页面数据时使用。\ntags: browser, playwright, automation, web\n\n### code-review\n系统化评审代码改动(diff/PR):先 git diff 看全改动,按正确性、安全、性能、可维护性分域清单逐项检查,发现按 critical / warning / suggestion 分级并给可执行的修法。用于交付前自审,或用户要求 review 代码 / 看 PR / 评估改动质量时。\ntags: review, quality, security, diff, pr\n\n### coding-suite\n编程高频任务总纲:读懂现有代码库、规划改动、精确编辑、跑测试/构建/lint 自我验证、code review、根因调试、写测试。把「需求/报错 → 验证通过的代码」串成端到端闭环。用户提编程、改代码、修 bug、写测试、评审代码、重构时,按本 skill 选路,并在完成前给出可运行的验证证据。\ntags: coding, software, debug, test, review, refactor, git\n\n### debugging\n系统化调试:先构造可复现的最小失败用例,再用日志/堆栈/二分/git history 定位根因,再修根因(不 suppress 报错、不靠猜),最后用同一复现用例验证已修好。用于用户报 bug、报错、测试失败、程序跑不起来或行为不符预期时。\ntags: debug, bug, error, repro, root-cause, troubleshoot\n\n### document-writing\n用 Pandoc/Quarto 生成排版美观、公式为 Word 原生可编辑格式的 DOCX/Word 文档。用户要求写报告、论文、方案、含公式 Word、导出 docx 时调用。\n\n### market\n用 `oc-market` 命令行帮用户操作 AI 市场:搜索/查看/安装/卸载技能与智能体,或把用户的技能/智能体发布到市场。当用户想\"找个能做 X 的技能/智能体并装上\"\"我装了哪些\"\"卸载某个\"\"把我这个技能发布到市场\"时使用。\ntags: marketplace, market, skill, agent, install, publish\n\n### memory-management\n如何用 memdir 范式管理长期记忆:…[truncated]";

export const SKILL_SEARCH_NO_MATCH_TEXT = "No matching skills found for \"平台能力\".\nTry a broader query or call `skill_list()` to browse all available skills.\nIf this was a reusable workflow you just validated, create it with `skill_save` after the task is complete.";

export const SKILL_VIEW_TEXT = "[source: platform]\n\n---\nname: platform-capabilities\ndescription: \"OpenClaude (claudeai.chat) 平台核心能力: 多媒体收发规则、内联富内容、htmlpreview、HTML Canvas、界面预览、设计稿还原、交互 demo、小游戏\"\nversion: \"2.1.0\"\ntags: [system, platform, media, rich-content, htmlpreview, canvas, ui-preview]\n---\n\n# claudeai.chat 平台能力\n\n## 多媒体发送给用户\n\n在回复中直接写出文件的**绝对路径**即可,前端自动检测并内联渲染为全尺寸媒体:\n\n| 文件类型 | 呈现方式 | 示例路径 |\n|---------|---------|---------|\n| 图片 (.jpg/.png/.gif/.webp/.svg) | 内联图片,可点击放大 | `/home/agent/.openclaude/generated/photo.jpg` |\n| 音频 (.mp3/.wav/.ogg/.flac/.m4a) | 内联播放器 | `/home/agent/.openclaude/generated/speech.mp3` |\n| 视频 (.mp4/.webm/.mov) | 内联视频播放器 | `/home/agent/.openclaude/generated/video.mp4` |\n| PDF/文档 (.pdf/.doc/.xlsx) | 可点击文档卡片 | `/home/agent/.openclaude/generated/report.pdf` |\n\n### ⚠️ 关键规则\n\n- **必须用绝对路径** (以 / 开头),不要用相对路径\n- **不要用 Markdown 图片语法** `![]()`。直接写裸路径即可\n- 前端只识别裸绝对路径,Markdown 图片语法会导致显示异常\n- 文件先保存到 `/home/agent/.openclaude/generated/` 目录(持久化路径,跨容器重启保留),再把路径告诉用户\n\n✅ 正确: `截图如下:\\n/home/agent/.openclaude/generated/screenshot.png`\n❌ 错误: `![截图](screenshot.png)` 或 `![截图](/home/agent/.openclaude/generated/screenshot.png)`\n\n## 接收用户上传的文件\n\n用户上传的文件保存到 `/home/agent/.openclaude/uploads/` 目录。\n- 文本文件内容直接内联到消息中\n- 图片/音频/视频以 bas…[truncated]";

export const LIST_MCP_RESOURCES_TEXT = "{\"resources\":[]}";

export const LIST_MCP_RESOURCE_TEMPLATES_TEXT = "{\"resourceTemplates\":[]}";

export const LIST_REMINDERS_TEXT = "共 3 个定时提醒/任务:\n- **You are doing a DAILY REFLECTION pass. I…** (ID: `daily-reflection`) — `17 3 * * *` · 重复 · 启用中 · 仅记录 · 下次 2026-07-10T19:17:00.000Z\n- **You are doing a WEEKLY CURATION pass.\n\n1…** (ID: `weekly-curation`) — `31 4 * * 0` · 重复 · 启用中 · 仅记录\n- **Quick skill extraction pass (every 6 hou…** (ID: `skill-check`) — `47 */6 * * *` · 重复 · 启用中 · 仅记录 · 下次 2026-07-10T16:47:00.000Z";

export const CREATE_REMINDER_TEXT = "✅ 提醒已创建: \"工具卡片演示临时提醒，将立刻删除。\"\n⏰ 计划: `0 0 1 1 *`\nID: `remind-mrf3mkmm-lahb` (一次性)";

export const UPDATE_REMINDER_TEXT = "✅ 已修改任务 `remind-mrf3mkmm-lahb`: prompt";

export const DELETE_REMINDER_TEXT = "✅ 已删除任务 `remind-mrf3mkmm-lahb`";

export const DELEGATE_TASK_TEXT = "✅ 委派完成 (agent: office-assistant)\n\n办公助手卡片正常";

export const DELEGATE_TASKS_TEXT = "并行委派 2 个子任务已全部返回:2 成功 / 0 失败。\n\n### 1. ✅ coding-assistant — 工具卡片演示：仅回复“编程助手卡片正常”。不要修改文件。\n✅ 委派完成 (agent: coding-assistant)\n\n编程助手卡片正常\n\n### 2. ✅ research-assistant — 工具卡片演示：仅回复“科研助手卡片正常”。不要联网或写文件。\n✅ 委派完成 (agent: research-assistant)\n\n科研助手卡片正常";

export const SEND_TO_AGENT_TEXT = "✅ 已发送给 agent \"coding-assistant\": \"工具卡片演示：请仅向用户回复“异步委派卡片正常”。不要操作文件。\"\n目标 agent 将在后台处理,结果会推送给用户。";

export const REQUEST_REVIEW_ERROR_TEXT = "error: 委派失败: {\"error\":\"质量审查仅在团队模式的队长回合中可用;当前回合请直接完成任务。\"}";

export const THINKING_HEADLINES_ONLY = "**Planning tool usage strategy**\n\n<!-- -->\n\n**Planning multi-tool demonstration**\n\n<!-- -->**Planning explicit collaboration spawn**\n\n<!-- -->";

export const THINKING_MULTI_SEGMENT = "**Creating generated tool-card-demo.txt file**\n\n<!-- -->**Listing available tools**\n\n<!-- -->**Evaluating safe tool usage and reminders**\n\n<!-- -->\n\n**Planning comprehensive tool demonstration**\n\n<!-- -->\n\n**Scheduling image generation as final step**\n\n<!-- -->**Planning non-destructive execution steps**\n\n<!-- -->\n\n**Designing serialized execution with error handling**\n\n<!-- -->**Improving multiline string handling**\n\n<!-- -->**Debugging template literal parsing**\n\n<!-- -->";

export const SUB_AGENT_STARTED_PAYLOAD = {
  "type": "subAgentActivity",
  "id": "call_OSeMkpl7DvEz4ehD9yVVXfHR",
  "kind": "started",
  "agentThreadId": "019f4cab-3b9c-7ba0-84a3-8291cac3bb19",
  "agentPath": "/root/tool_demo_probe"
} as const;

export const SUB_AGENT_INTERACTED_PAYLOAD = {
  "type": "subAgentActivity",
  "id": "call_C1n9EV0qIWZPSba1X5IzgV4t",
  "kind": "interacted",
  "agentThreadId": "019f4cab-3b9c-7ba0-84a3-8291cac3bb19",
  "agentPath": "/root/tool_demo_probe"
} as const;

export const IMAGE_GENERATION_FAILED_PAYLOAD = {
  "type": "imageGeneration",
  "id": "exec-7114e641-7332-49ce-9ab4-88e5e533bee7",
  "status": "failed",
  "revisedPrompt": "A minimalist square UI test image for an AI tool-card rendering demo: dark navy background, three rounded glowing cards in cyan, amber, and violet, simple geometric icons only, no words, high contrast, clean modern product illustration.",
  "result": ""
} as const;

export const IMAGE_VIEW_PAYLOAD = {
  "type": "imageView",
  "id": "exec-7fef499c-824c-4eb2-b04f-f83ee1eecf63",
  "path": "/home/agent/.openclaude/generated/tool-card-pixel.png"
} as const;
