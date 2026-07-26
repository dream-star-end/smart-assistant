// 「在对话中创建」技能/智能体/API 连接插件的引导提示词模板。
//
// 设计原则(boss:让小白点点选选就能创建,尽量减少输入):
//  - 模板要求 AI 调当前运行时的专用用户提问工具,用户在问答 UI 点选即可推进;
//  - 一次只问一组问题,信息够了先给**确认摘要**再动手,杜绝自作主张;
//  - 创建动作走既有工具(skill_save / 直写 evals / oc-market),对话里有对应卡片可视化;
//  - 【】里是用户唯一需要填的一句话,发送前可改可不改。
export type ChatCreateKind = 'skill' | 'agent' | 'connector'

export const CHAT_CREATE_TEMPLATES: Record<ChatCreateKind, string> = {
  skill: `我想创建一个新技能,请你全程引导我,让我尽量只做选择题:

1. 先根据我的想法,一次性列出你需要确认的问题。必须调用当前运行时的专用用户提问工具(CCB 用 AskUserQuestion;Codex 用 request_user_input),让我在专用问答 UI 中点选;不要用 Markdown 富块或普通正文模拟选择卡。最多两轮提问,每轮≤3 个问题。
2. 信息足够后,给我一份「创建确认单」:技能名(小写连字符)、触发场景、核心步骤、验收断言(2-3条),等我回复「确认」。
3. 确认后:用 skill_save 创建技能(SKILL.md 按 skill-authoring 规范写:触发条件/步骤/常见坑/验证);再把验收断言写成评测用例存到该技能目录的 evals/evals.json({"version":1,"cases":[{"id","prompt","assertions":[]}]});如有可复用的脚本或参考资料,分别放 scripts/ 和 references/。
4. 最后告诉我:技能已创建,可以去「管理中心 → 技能」查看、运行评测(会消耗积分,需我确认)、或发布到市场。

我的想法:【用一句话描述你想要的技能,例如:把中文论文摘要翻译成地道英文并保留术语】`,

  agent: `我想创建一个专属智能体并发布到市场,请你全程引导我,让我尽量只做选择题:

1. 先根据我的定位,一次性列出需要确认的问题(名字候选、头像 emoji 候选、性格/语气风格、需要的能力:浏览器/研究检索/网页提取、是否依赖某些市场技能)。必须调用当前运行时的专用用户提问工具(CCB 用 AskUserQuestion;Codex 用 request_user_input),让我在专用问答 UI 中点选;不要用 Markdown 富块或普通正文模拟选择卡。最多两轮提问。
2. 信息足够后,给我一份「发布确认单」:名字/slug/一句话介绍/emoji/模型/能力/依赖技能/人设全文,等我回复「确认」。
3. 确认后用 oc-market 发布该智能体(发布后进入平台 AI 审核,不确定或高风险项会转人工复核;把审核状态告诉我,之后可在「市场 → 发布 → 我的发布」跟踪)。
4. 人设(persona)由你按我的定位代写:包含身份、工作方式、行为纪律,不超过 500 行。

我的定位:【用一句话描述这个智能体,例如:懂合同审阅和合规问答的法律顾问】`,

  connector: `我想创建一个 API 连接插件并发布到市场,请你全程引导我,让我尽量只做选择题:

1. 先根据我的目标,最多分两轮确认:连接的服务/API 文档、认证方式(静态令牌/token exchange/OAuth2 BYOA)、固定 API 域名、需要的读取/写入动作、identity 身份探针、分类与适用场景。必须调用当前运行时的专用用户提问工具(CCB 用 AskUserQuestion;Codex 用 request_user_input),让我在专用问答 UI 中点选;不要用 Markdown 富块或普通正文模拟选择卡。每轮≤3题。
2. 信息足够后,运行 oc-market plugin examples 读取容器内置、经过编译器验证的三种完整单文件模板和合法分类；选择最接近的一种,把全部发布信息写入 /tmp/openclaude-plugin.json。不要猜私有 schema,也不要读取容器中不存在的平台源码。不得向我索要或把真实密码、token、client secret、授权码写进文件；社区 OAuth2 必须 BYOA,凭据只能在安装后通过账号授权注入。
3. 运行 oc-market plugin validate --file /tmp/openclaude-plugin.json。必须用返回的 plugin 与 permissionSummary 起草「发布确认单」,逐项展示:名称/slug/版本/可见范围/认证方式/BYOA/所需授权字段/全部固定 origins/identity probe/每个 action 的 HTTP 方法与 read|write|send effect/凭据放置位置/风险提示。校验失败先按结构化错误修正并重新校验；校验成功后等我明确回复「确认」。
4. 只有我确认后,才原样执行校验结果里的 publishCommand。确认后不得再修改草稿；如需修改,必须重新 validate、展示新摘要并让我重新确认。不得自己拼 curl/wget 或直连内部接口。
5. 最后告诉我发布结果:提交后由 AI 自动审核；不确定、内容过大或高风险会转人工复核。可在「市场 → 发布 → 我的发布」实时跟踪；审核通过后「市场 → 发现」会自动刷新展示,安装后到「管理中心 → 插件」统一授权和管理账号。

我的想法:【用一句话描述要连接的服务和希望 AI 能做什么,例如:连接公司内部工单 API,让 AI 查询工单并追加处理备注】`,
}
