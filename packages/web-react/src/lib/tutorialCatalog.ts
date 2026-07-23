import type { ProductFeatureId } from "./productCapabilities";

export const TUTORIAL_CATALOG_SCHEMA = 2;

/** 每个一等能力都有自己的真实界面录制，禁止多个章节复用同一组媒体。 */
export type TutorialMediaKey = ProductFeatureId;

const TUTORIAL_MEDIA_V3 = new Set<TutorialMediaKey>([
  "agents",
  "artifacts-download",
  "chat-basics",
  "connectors",
  "container-web-preview",
  "files-media",
  "image-create-edit",
  "marketplace-publishing",
  "memory-auto-dream",
  "organization",
  "preferences",
  "schedules-reminders",
  "skills-training",
  "team-mode",
]);
const TUTORIAL_MEDIA_V5 = new Set<TutorialMediaKey>(["container-web-preview"]);

export const TUTORIAL_MEDIA: Record<
  TutorialMediaKey,
  { version: number; poster: string; video: string; caption: string }
> = Object.fromEntries(
  (
    [
      ["chat-basics", "输入目标并发送，随后核对助手返回的完整交付。"],
      ["sessions-history", "搜索会话并切换到“客户研究”，继续已有工作。"],
      ["models-reasoning", "打开模型选择器，比较并切换后续消息使用的模型。"],
      ["files-media", "选择“季度数据.xlsx”，等待上传完成并看到附件卡片。"],
      ["voice-input", "开始录音、停止转写，再校对进入输入框的文字。"],
      ["web-research", "进入真实文献库，上传并查看已解析的研究资料。"],
      ["artifacts-download", "在消息中找到真实成果卡片并触发签名下载。"],
      [
        "container-web-preview",
        "打开真实容器网页预览，选中页面元素并留下修改评论。",
      ],
      ["image-create-edit", "打开生成图片，进入圈选修改并查看下载操作。"],
      ["github-repository", "关联 GitHub，选择仓库与分支并确认绑定。"],
      ["agents", "打开智能体选择器，查看并切换已安装的专业助手。"],
      ["team-mode", "在智能体选择器中开启团队模式并确认队长说明。"],
      ["memory-auto-dream", "进入记忆中心，查看长期记忆与 Auto-Dream 报告。"],
      [
        "schedules-reminders",
        "进入定时任务，查看下一次执行时间并打开新建表单。",
      ],
      ["skills-training", "打开技能详情，查看评测与训练优化入口。"],
      ["connectors", "进入连接器管理，查看已绑定账号与账号绑定入口。"],
      [
        "marketplace-discovery",
        "在 AI 市场搜索“研究”，打开条目详情核对适用场景。",
      ],
      ["marketplace-publishing", "进入创作发布，填写技能定义并查看发布记录。"],
      ["inbox", "打开站内信，筛选未读并展开一条服务通知。"],
      ["preferences", "进入偏好设置，查看默认模型与 Auto-Dream，并切换主题。"],
      ["billing-usage", "打开账户与用量，查看余额、趋势和模型消耗。"],
      ["organization", "进入组织中心，查看成员、共享额度与用量报表。"],
      ["feedback-support", "选择反馈类型，填写复现步骤并看到提交准备状态。"],
    ] as const
  ).map(([id, caption]) => [
    id,
    {
      version: TUTORIAL_MEDIA_V5.has(id)
        ? 5
        : TUTORIAL_MEDIA_V3.has(id)
          ? 3
          : 2,
      poster: `/tutorials/${id}.webp`,
      video: `/tutorials/${id}.webm`,
      caption,
    },
  ]),
) as Record<
  TutorialMediaKey,
  { version: number; poster: string; video: string; caption: string }
>;

export type TutorialStep = { title: string; body: string };

export type TutorialTopic = {
  featureId: ProductFeatureId;
  contentVersion: number;
  intro: string;
  outcome: string;
  scenarios: readonly string[];
  steps: readonly TutorialStep[];
  tips: readonly string[];
  cautions: readonly string[];
  example?: string;
  media: TutorialMediaKey;
  related: readonly ProductFeatureId[];
};

export const TUTORIAL_TOPICS = {
  "chat-basics": {
    featureId: "chat-basics",
    contentVersion: 2,
    intro:
      "Aurora 不是只回答一句话的聊天框，而是能持续执行任务的工作区。你可以像给同事派活一样说明目标、材料、限制和交付格式；过程中会看到思考、工具、进度与阶段结果，任务结束后还能继续追问或让它修改。",
    outcome: "把一个模糊想法变成可核验、可继续迭代的完整交付。",
    scenarios: [
      "写报告、方案与邮件",
      "分析数据或排查问题",
      "连续多轮修改同一份成果",
    ],
    steps: [
      {
        title: "先说结果",
        body: "第一句先讲清最终想拿到什么，例如“一页汇报稿”或“一份可运行脚本”。",
      },
      {
        title: "补充材料与约束",
        body: "告诉它受众、期限、格式、不能做什么；有文件就直接上传，不必手工粘贴全文。",
      },
      {
        title: "观察执行而不是反复催促",
        body: "任务运行时查看进度、工具卡和计划；确需改方向时再停止或追加信息。",
      },
      {
        title: "用反馈完成最后一公里",
        body: "对结果指出具体问题，或使用重新生成、继续、点赞/点踩，让下一轮更贴近预期。",
      },
    ],
    tips: [
      "复杂任务写清“完成标准”，比堆很多提示词更有效。",
      "一次会话尽量围绕同一个目标，相关上下文会自然延续。",
    ],
    cautions: ["涉及转账、发布、删除数据等外部动作，执行前仍应核对确认。"],
    example:
      "把这份会议记录整理成：结论、待办、负责人、截止时间四部分；不确定的信息标出来，不要猜。",
    media: "chat-basics",
    related: ["files-media", "models-reasoning", "sessions-history"],
  },
  "sessions-history": {
    featureId: "sessions-history",
    contentVersion: 2,
    intro:
      "每个会话都保留自己的智能体、上下文和任务轨迹。侧栏可搜索、切换、重命名和删除会话；登录同一账号后，服务端保存的消息与团队结果会在其他设备恢复，长会话还可以按需从云端加载更早记录。",
    outcome: "把不同项目分开管理，并在刷新或换设备后继续原来的工作。",
    scenarios: [
      "按客户或项目建立独立会话",
      "回看旧交付与请求 ID",
      "跨电脑继续长任务",
    ],
    steps: [
      {
        title: "新任务先新建会话",
        body: "点击侧栏“新建会话”或使用 Ctrl/⌘+K，避免把无关项目混在一起。",
      },
      {
        title: "用清晰标题整理",
        body: "首条消息后会生成标题；重要会话可手动重命名，方便侧栏搜索。",
      },
      {
        title: "切换与恢复",
        body: "点击任一会话即可恢复历史；超长历史顶部出现入口时，可继续从云端加载更早内容。",
      },
      {
        title: "谨慎删除",
        body: "删除会话会从账号中移除该会话及其可恢复历史，不等同于仅从侧栏隐藏。",
      },
    ],
    tips: [
      "一个会话一个主目标，检索和续接都更准确。",
      "可收藏式保留关键会话：用统一前缀重命名，例如“客户A｜季度复盘”。",
    ],
    cautions: ["删除不可当作临时归档使用；需要保留的成果请先下载。"],
    media: "sessions-history",
    related: ["chat-basics", "artifacts-download", "agents"],
  },
  "models-reasoning": {
    featureId: "models-reasoning",
    contentVersion: 2,
    intro:
      "顶栏模型选择器决定本会话下一条任务由哪个模型执行；设置里的默认模型和思考深度决定新会话的起点。不同模型在速度、复杂推理、编程与成本上各有侧重，平台会如实显示当前可用范围和计费。",
    outcome: "按任务难度选择合适模型，在响应速度、质量与积分消耗之间取得平衡。",
    scenarios: [
      "快速润色与摘要",
      "复杂规划、数学或代码审查",
      "对同一方案做第二模型复核",
    ],
    steps: [
      {
        title: "先用默认模型",
        body: "日常任务无需频繁切换；只有质量或速度不符合预期时再调整。",
      },
      {
        title: "按能力选择",
        body: "查看模型说明与思考档位；复杂任务提高思考深度，简单任务保持中低档即可。",
      },
      {
        title: "切换只影响后续消息",
        body: "已生成内容不会重算；若想对比，可切换模型后明确要求“独立复核上面的结论”。",
      },
      {
        title: "把常用组合设为默认",
        body: "进入设置 → 偏好，保存默认模型与思考深度，后续新会话自动继承。",
      },
    ],
    tips: [
      "模型越强不代表所有任务都更划算，批量简单处理优先选择速度与成本。",
      "团队模式的队长引擎有独立说明，不完全等同于普通模型选择。",
    ],
    cautions: ["高思考深度通常耗时和积分更多；切换前可先查看账户用量。"],
    media: "models-reasoning",
    related: ["billing-usage", "team-mode", "preferences"],
  },
  "files-media": {
    featureId: "files-media",
    contentVersion: 2,
    intro:
      "输入框左侧的附件按钮可以上传图片、PDF、Word、Excel、音频、视频和常见文本文件。上传完成后，文件会作为本条消息的材料交给智能体；图片可先预览，失败的附件可单独重试或移除。",
    outcome: "直接让 AI 阅读真实材料，而不是复制粘贴后丢失格式与上下文。",
    scenarios: [
      "分析表格与合同",
      "总结 PDF 或录音",
      "根据图片排查问题或生成说明",
    ],
    steps: [
      {
        title: "先选附件",
        body: "点击“+”选择一个或多个文件，等待每个附件显示上传完成。",
      },
      {
        title: "说明材料角色",
        body: "明确哪个文件是数据、模板或参考，以及要读取的页、表、字段或时间段。",
      },
      {
        title: "写清交付格式",
        body: "例如要求生成新 Excel、带引用的报告、对比表，或只回答问题不改原文件。",
      },
      {
        title: "核对结果并下载",
        body: "重点检查关键数字、页码与文件名；AI 生成的成果从消息卡片下载保存。",
      },
    ],
    tips: [
      "文件名写得有意义，多个附件时更容易准确引用。",
      "大文件先说明关注范围，能减少无关读取和积分消耗。",
    ],
    cautions: [
      "不要上传无权处理的个人隐私、密钥或第三方机密；敏感内容先脱敏。",
    ],
    example:
      "读取“销售明细.xlsx”的订单表，按地区和月份汇总收入，并把异常退款写到一个新工作表。",
    media: "files-media",
    related: ["artifacts-download", "image-create-edit", "web-research"],
  },
  "voice-input": {
    featureId: "voice-input",
    contentVersion: 2,
    intro:
      "支持麦克风的浏览器会在输入框右侧显示语音按钮。录音停止后，语音先转成可编辑文字，不会自动发送；你可以补充数字、专有名词和格式要求，再亲自确认提交。",
    outcome: "在移动端或灵感快速出现时，用口述完成长任务描述。",
    scenarios: ["移动端口述需求", "会后快速记录待办", "输入长背景而不方便打字"],
    steps: [
      {
        title: "允许麦克风权限",
        body: "首次点击语音按钮时，在浏览器权限提示中选择允许。",
      },
      {
        title: "完整说完一段",
        body: "尽量按“背景—目标—限制—交付”顺序口述，点击麦克风停止。",
      },
      {
        title: "校对转写",
        body: "重点修改人名、金额、日期、缩写和中英文混排内容。",
      },
      {
        title: "确认后发送",
        body: "转写只进入输入框；检查无误后再点发送，平台不会替你自动提交。",
      },
    ],
    tips: [
      "安静环境、分句清楚会提高转写准确度。",
      "遇到权限失败可在浏览器地址栏的网站设置里重新开放麦克风。",
    ],
    cautions: ["公共场所口述敏感信息前先确认周边环境。"],
    media: "voice-input",
    related: ["chat-basics", "files-media", "preferences"],
  },
  "web-research": {
    featureId: "web-research",
    contentVersion: 2,
    intro:
      "智能体可以搜索公开网页、提取页面与文档、检索论文并整理引用。文献库用于保存你主动上传并完成解析的研究资料；回答中的来源卡片可打开核对，适合需要时效性和证据链的任务。",
    outcome: "得到带来源、能回查的调研结论，而不是只有一段无法验证的概括。",
    scenarios: [
      "行业与竞品调研",
      "论文综述与证据汇总",
      "核对近期政策、价格或产品变化",
    ],
    steps: [
      {
        title: "限定问题和时间范围",
        body: "说明地区、行业、日期截止点和需要排除的来源。",
      },
      {
        title: "要求证据格式",
        body: "让它逐条附来源、发布时间与关键事实，区分事实、推断和建议。",
      },
      {
        title: "抽查原文",
        body: "打开引用卡片核对最关键的数字和结论，不把搜索摘要直接当最终事实。",
      },
      {
        title: "沉淀到文献库",
        body: "把会反复使用的论文或资料上传到管理中心 → 文献库，后续研究可继续引用。",
      },
    ],
    tips: [
      "要求优先官方、论文或一手资料，能显著提高可信度。",
      "告诉 AI 哪些来源不可访问时，要求明确标注而不是补猜。",
    ],
    cautions: ["医疗、法律、金融等高风险结论必须再由专业人士或权威原文确认。"],
    example:
      "调研近 30 天国内主流 AI 办公产品的新功能，只引用官方公告；按产品、变化、发布日期、来源链接做表。",
    media: "web-research",
    related: ["files-media", "artifacts-download", "skills-training"],
  },
  "artifacts-download": {
    featureId: "artifacts-download",
    contentVersion: 3,
    intro:
      "AI 可以把结果写成文件、代码、网页、图表、Office 文档或其他可下载成果。消息里的文件卡是交付入口；支持预览的格式会显示预览操作，其余文件可直接下载后用对应软件核对。",
    outcome: "从“得到建议”升级为“拿到能直接使用的文件”。",
    scenarios: [
      "生成报告、PPT、Excel、Word",
      "交付网页或代码项目",
      "下载图片、图表与数据文件",
    ],
    steps: [
      {
        title: "开头约定文件格式",
        body: "明确需要 .docx、.xlsx、.pptx、PDF、压缩包或网页，避免只得到文本说明。",
      },
      {
        title: "先预览关键内容",
        body: "在消息卡里查看结构、页数、图表和文件名；有预览时先检查再下载。",
      },
      {
        title: "下载并本地打开",
        body: "点击下载，使用对应软件验证公式、版式、链接和可编辑性。",
      },
      {
        title: "继续修改而非重做",
        body: "指出文件名和具体位置，让 AI 在同一会话里修订并交回新版本。",
      },
    ],
    tips: [
      "要求同时附一段变更摘要，方便比较多个版本。",
      "重要成果下载到自己的长期存储，不把会话当唯一文件库。",
    ],
    cautions: [
      "浏览器可能拦截新标签或下载；看到提示时允许当前站点打开或保存文件。",
    ],
    media: "artifacts-download",
    related: ["files-media", "container-web-preview", "sessions-history"],
  },
  "container-web-preview": {
    featureId: "container-web-preview",
    contentVersion: 4,
    intro:
      "当智能体在你的运行容器里启动开发服务器并给出 localhost、127.0.0.1 或 0.0.0.0 地址时，直接点击带“容器预览”标识的链接即可打开原生清晰预览。平台会为本次会话自动分配隔离的临时域名，让网页 DOM 在浏览器里直接渲染和交互；不可用时会自动切换兼容预览。预览会按当前访问设备自动选择桌面或移动视口并铺满可视区；你也可手动切换设备，并点选具体元素逐条留下修改评论。",
    outcome:
      "在同一条开发闭环里完成真实页面验收、精确元素标注和可执行的修改反馈。",
    scenarios: [
      "检查 AI 刚启动的前端页面",
      "逐个标注布局、文案与样式问题",
      "对比桌面端和移动端适配效果",
    ],
    steps: [
      {
        title: "让智能体启动网页并给出地址",
        body: "要求它在容器内运行开发服务器，并在回复中提供完整的 HTTP(S) loopback 地址和端口。",
      },
      {
        title: "点击“容器预览”链接",
        body: "平台会签发一次性授权并自动建立本次会话专用的临时域名；它只转发当前用户容器的目标端口，外部网址和平台管理端口不会进入该通道。",
      },
      {
        title: "操作页面并切换设备",
        body: "在“原生清晰预览”中直接点击、滚动和输入；打开时会自动匹配当前设备并铺满屏幕，需要对照时再用桌面/移动按钮重新载入另一视口，检查响应式布局和触控目标。若页面未就绪，等待自动回退或点右上角切换兼容预览。",
      },
      {
        title: "选择元素并提交修改评论",
        body: "切到“选元素评论”，点选具体元素、写下期望修改，可累计多条；最后添加到输入框，确认内容后再发送给智能体实现并复测。",
      },
    ],
    tips: [
      "尽量选择最具体的按钮、标题或容器，并在评论里同时写明预期效果和设备范围。",
      "一次预览最多保留 20 条评论；可先编辑或删除重复项，加入输入框后也能继续修改。",
    ],
    cautions: [
      "加入对话时不会附带截图，只会写入页面地址、元素选择器、可见文本、位置和你的评论；依赖外部跨域资源的本地页面可能显示不完整。",
      "临时域名仅在当前预览会话内有效；浏览器不支持分区 Cookie 或临时通道异常时，平台会使用兼容预览，清晰度和操作延迟可能略有差异。",
    ],
    example:
      "启动前端后给我可访问地址。我会在移动视口标注需要修改的导航和主按钮；收到元素评论后直接改源码、跑测试并重新启动页面验证。",
    media: "container-web-preview",
    related: ["github-repository", "artifacts-download", "chat-basics"],
  },
  "image-create-edit": {
    featureId: "image-create-edit",
    contentVersion: 2,
    intro:
      "在支持 Image 2 的 GPT 模型下，可以用自然语言生成图片，也可以打开已有图片进行评论、圈选和局部修改。图片编辑会保留你的原图语境，圈选区域越准确，修改越可控。",
    outcome: "完成从概念图到局部修订、导出成品的一条闭环。",
    scenarios: [
      "营销配图与概念草图",
      "修改局部文字、颜色或物体",
      "对截图圈选并提出意见",
    ],
    steps: [
      {
        title: "选择支持的 GPT 模型",
        body: "若编辑入口不可用，先在顶栏切换到支持 Image 2 的模型。",
      },
      {
        title: "描述画面与用途",
        body: "写清主体、构图、风格、比例、文字与使用场景；需要透明背景也要明确提出。",
      },
      {
        title: "圈选局部再修改",
        body: "打开图片，进入圈选编辑，覆盖需要变动的区域并说明要保留的内容。",
      },
      {
        title: "放大核对并下载",
        body: "检查文字、手部、边缘和品牌元素，满意后下载原图；不满意可继续小步迭代。",
      },
    ],
    tips: [
      "一次只改一类问题，比“全部优化一下”更容易保持其余区域不变。",
      "写明“不改人物、不改构图”等保留约束。",
    ],
    cautions: [
      "生成图片按平台规则计费；版权、肖像和商标用途由使用者最终确认。",
    ],
    example:
      "生成一张 16:9 的产品发布会主视觉：深蓝背景、中心是一台轻薄笔记本、右侧留标题区，不要出现品牌 logo。",
    media: "image-create-edit",
    related: ["files-media", "models-reasoning", "artifacts-download"],
  },
  "github-repository": {
    featureId: "github-repository",
    contentVersion: 2,
    intro:
      "把 GitHub 账号授权给平台后，可为当前会话绑定一个仓库和分支。智能体会在绑定的真实代码上下文中查看文件、运行构建和测试，并按你的授权与指令提交或推送改动。仓库绑定是按会话隔离的。",
    outcome: "让编程任务直接落到仓库和分支，而不是只返回一段孤立代码。",
    scenarios: [
      "修复 Bug 并跑测试",
      "实现功能后提交分支",
      "审查仓库结构与性能问题",
    ],
    steps: [
      {
        title: "连接 GitHub",
        body: "点击输入框下方仓库入口，完成 GitHub OAuth 授权。",
      },
      {
        title: "选仓库与分支",
        body: "搜索仓库，确认公开/私有属性和默认分支，再绑定到当前会话。",
      },
      {
        title: "说明改动边界",
        body: "写清目标文件、验收命令、能否改依赖、是否允许提交和推送。",
      },
      {
        title: "检查差异与测试",
        body: "让 AI 汇报改动文件、测试结果和提交信息；在 GitHub 上复核后再合并。",
      },
    ],
    tips: [
      "生产仓库优先使用独立任务分支。",
      "把测试命令和“不要触碰”的目录写进首条任务。",
    ],
    cautions: [
      "授权范围由 GitHub 页面显示；不再使用时可解绑账号或解除当前会话绑定。",
    ],
    example:
      "在当前仓库修复移动端导航溢出；不要升级依赖，补回归测试，构建通过后提交到新分支，不要直接合并。",
    media: "github-repository",
    related: ["agents", "artifacts-download", "team-mode"],
  },
  agents: {
    featureId: "agents",
    contentVersion: 1,
    intro:
      "智能体是一套长期稳定的角色、工作方式和专用能力。点击顶栏头像可以在全能助手、平台预设和已安装智能体之间切换；每个会话记录自己的智能体归属，重新打开时会恢复。",
    outcome: "把专业任务交给更懂该领域、带有合适工具和流程的助手。",
    scenarios: [
      "编程、科研、办公等专业任务",
      "固定语气和交付规范",
      "安装社区专家能力",
    ],
    steps: [
      {
        title: "打开智能体选择器",
        body: "点击顶栏当前助手名称，查看已安装智能体与简介。",
      },
      {
        title: "按任务而不是名字选择",
        body: "查看能力说明、所需工具和适用场景；日常混合任务可继续用全能助手。",
      },
      {
        title: "切换后再下达任务",
        body: "切换只影响当前会话后续执行；旧智能体的迟到结果不会混入新角色。",
      },
      {
        title: "从市场补充",
        body: "没有合适角色时，进入 AI 市场的智能体分类安装，或自己创建发布。",
      },
    ],
    tips: [
      "同一项目尽量保持一个主智能体，减少角色来回切换。",
      "智能体与技能不同：智能体决定角色与工作方式，技能提供一项可复用流程。",
    ],
    cautions: ["社区智能体安装前查看介绍、权限和依赖技能。"],
    media: "agents",
    related: ["team-mode", "marketplace-discovery", "skills-training"],
  },
  "team-mode": {
    featureId: "team-mode",
    contentVersion: 2,
    intro:
      "团队模式由队长拆解任务，并按需委派给已安装的专业智能体并行工作。界面会展示成员进度、工具、结果和各自消耗；队长负责汇总终稿，必要时可请求隐藏审查员复核。它适合真正可拆分的复杂任务。",
    outcome: "让调研、实现、验证等子任务并行推进，同时保留一份统一终稿。",
    scenarios: ["跨领域调研与成稿", "代码实现 + 测试 + 审查", "多方案并行比较"],
    steps: [
      {
        title: "先安装需要的专家",
        body: "团队只能委派当前账号已安装的智能体；先在市场准备好成员。",
      },
      {
        title: "在智能体选择器开启团队模式",
        body: "开启后顶栏会常驻团队标识，并显示真实队长引擎说明。",
      },
      {
        title: "给出可拆分目标",
        body: "说明最终交付和验收标准，让队长自主决定并行分工；不必手工点名每一步。",
      },
      {
        title: "查看团队卡与成本",
        body: "展开成员卡跟踪进度；终稿完成后检查各成员结果和积分明细。",
      },
    ],
    tips: [
      "简单问答不要开团队模式，单助手更快更省。",
      "把互不依赖的子目标写清楚，才能真正并行。",
    ],
    cautions: [
      "成员按各自模型计费，团队总消耗通常高于单助手。停止主任务会级联停止仍在执行的委派。",
    ],
    media: "team-mode",
    related: ["agents", "billing-usage", "marketplace-discovery"],
  },
  "memory-auto-dream": {
    featureId: "memory-auto-dream",
    contentVersion: 2,
    intro:
      "长期记忆保存你的身份、偏好、反馈、项目和参考信息，并按智能体隔离。你可以在管理中心逐条查看、编辑或删除。Auto-Dream 会在允许时整理近期经验、提出记忆变更并生成可审阅报告。",
    outcome: "减少反复交代背景，让助手在长期使用中保持一致并持续改进。",
    scenarios: [
      "记住职业与沟通偏好",
      "保存长期项目背景",
      "复盘近期反馈并清理过时记忆",
    ],
    steps: [
      {
        title: "在对话中明确要求记住",
        body: "用“请记住：……”写出稳定事实；临时任务不要写入长期记忆。",
      },
      {
        title: "按类型管理",
        body: "进入管理中心 → 记忆，在用户偏好、反馈、项目、参考四类中查看条目。",
      },
      {
        title: "定期校正",
        body: "信息变化时直接编辑或删除旧条目，避免新旧事实冲突。",
      },
      {
        title: "审阅 Auto-Dream",
        body: "开启后查看梦境报告里的新增、更新和清理记录，确认它是否符合你的真实情况。",
      },
    ],
    tips: [
      "只记长期稳定、未来会复用的信息。",
      "项目结束后删除或更新项目记忆，回答会更干净。",
    ],
    cautions: ["不要把密码、密钥、身份证号等秘密写进长期记忆。"],
    example:
      "请记住：我负责 B2B SaaS 产品，写方案时优先给结论和可量化指标，不要用空泛营销词。",
    media: "memory-auto-dream",
    related: ["preferences", "schedules-reminders", "skills-training"],
  },
  "schedules-reminders": {
    featureId: "schedules-reminders",
    contentVersion: 2,
    intro:
      "定时任务让智能体在未来某个时间自动执行提示词，并把结果送到网页对话或其他已配置通道。既支持一次性提醒，也支持工作日、每周、每月等周期计划；管理中心可暂停、编辑和删除。",
    outcome: "把重复的信息整理、提醒和例行检查交给系统自动完成。",
    scenarios: ["每日资讯摘要", "每周项目复盘", "未来某时的一次性提醒"],
    steps: [
      {
        title: "在对话中直接描述时间",
        body: "例如“下周一 9 点提醒我提交报表”，系统会创建结构化任务。",
      },
      {
        title: "写清每次要做什么",
        body: "周期任务的提示词应自包含，说明数据范围、格式和失败时怎么处理。",
      },
      {
        title: "选择送达位置",
        body: "网页对话适合查看完整结果；仅记录适合后台留痕，其他通道需先完成绑定。",
      },
      {
        title: "在管理中心维护",
        body: "查看下一次执行时间，按需暂停、修改计划或删除不再需要的任务。",
      },
    ],
    tips: [
      "先用一次性任务验证输出，再改成周期任务。",
      "周期越短成本越高，日报通常不需要每几分钟运行。",
    ],
    cautions: [
      "任务会消耗积分；余额不足或连续错误时系统可能暂停并通知你。提交前请核对表单显示的时区和下一次执行时间。",
    ],
    example:
      "每个工作日 17:30，总结今天这个会话里的完成项、风险和明日第一优先级，发到网页对话。",
    media: "schedules-reminders",
    related: ["memory-auto-dream", "inbox", "connectors"],
  },
  "skills-training": {
    featureId: "skills-training",
    contentVersion: 2,
    intro:
      "技能是一套在特定场景自动启用的可复用工作流程，包含说明、参考资料、脚本和评测用例。管理中心可查看市场安装和个人自建的技能，编辑自己的技能，运行评测，并让训练流程基于失败案例提出改进草稿。",
    outcome: "把一次成功做法固化成稳定流程，并用评测防止后续修改退化。",
    scenarios: [
      "固定报告或翻译流程",
      "封装内部脚本与规范",
      "用真实用例持续优化专业能力",
    ],
    steps: [
      {
        title: "先从真实任务提炼",
        body: "连续成功几次后，让 AI 总结触发条件、步骤、输入输出和常见坑。",
      },
      {
        title: "创建技能与评测",
        body: "在对话中引导创建，或在管理中心编辑正文、文件和 evals 用例。",
      },
      {
        title: "运行评测",
        body: "用代表性任务验证断言；失败先看原因，不要只追求分数。评测会消耗积分。",
      },
      {
        title: "审阅训练草稿",
        body: "AI 训练只生成候选改动；比较差异、留下评论并确认后再合并。",
      },
    ],
    tips: [
      "技能触发条件要具体，避免每个任务都误触发。",
      "评测至少覆盖正常、边界和失败恢复三类。",
    ],
    cautions: [
      "平台基线技能只读；脚本类技能发布前检查外部请求、凭据和删除操作。",
    ],
    media: "skills-training",
    related: ["marketplace-publishing", "marketplace-discovery", "agents"],
  },
  connectors: {
    featureId: "connectors",
    contentVersion: 4,
    intro:
      "插件让智能体在获得授权后读取或写入外部服务。市场负责发现、审核和安装；管理中心只负责账号与授权。除 Notion、飞书、GitHub 和声明式 HTTP 插件外，知识星球支持微信扫码登录及只读内容检索。",
    outcome: "让 AI 在真实业务系统里查数据和执行动作，而不靠手工搬运。",
    scenarios: [
      "读取 Notion 或飞书文档",
      "在 GitHub 上协作开发",
      "检索知识星球的主题、评论、动态、标签、专栏与打卡内容",
      "调用已审核的业务 API 插件",
    ],
    steps: [
      {
        title: "从市场安装插件",
        body: "先查看来源、允许的域名、读取/写入动作和认证方式，再确认安装。",
      },
      {
        title: "绑定账号",
        body: "安装知识星球后会自动打开授权弹层；点击同意并用微信扫码，手机确认后页面会自动显示成功并启用。其他插件按提示 OAuth 授权或填写凭据。",
      },
      {
        title: "在任务里明确账号与动作",
        body: "例如“从工作邮箱读取，不要发送邮件”；写操作前要求先给预览。",
      },
      {
        title: "随时解绑",
        body: "不再使用时在管理中心解绑账号或卸载插件，撤销后后续调用立即失效。",
      },
    ],
    tips: [
      "读写账号分开绑定、备注清楚，可减少选错账号。",
      "知识星球授权后可直接向 AI 描述目标；AI 会自动发现账号并组合只读 action，无需手工提供内部 ID。",
      "首次先做只读查询，确认范围后再允许写入。",
    ],
    cautions: [
      "插件权限来自外部服务；高风险写操作务必检查目标、数量和影响范围。不要在对话里粘贴密钥。",
    ],
    media: "connectors",
    related: [
      "marketplace-discovery",
      "schedules-reminders",
      "marketplace-publishing",
    ],
  },
  "marketplace-discovery": {
    featureId: "marketplace-discovery",
    contentVersion: 3,
    intro:
      "AI 市场汇集三类能力：技能沉淀可复用的方法与流程；智能体组合模型、人设、工具权限和依赖；插件提供可安装、可授权、可审计的外部能力。当前插件分类先支持声明式 HTTP API。",
    outcome: "按任务快速加装专业能力，而不把所有功能塞进一个助手。",
    scenarios: ["寻找专业工作流", "安装领域智能体", "连接新的外部服务"],
    steps: [
      {
        title: "先选类型",
        body: "缺方法与流程选技能；缺长期角色与编排选智能体；缺外部系统能力选插件。三者可以组合，而不是互相替代。",
      },
      {
        title: "搜索并阅读详情",
        body: "查看适用场景、版本、依赖、权限、真实使用信号和发布者说明。",
      },
      {
        title: "安装后完成配置",
        body: "技能可分配给智能体；智能体会出现在选择器；API 连接插件安装后还需到管理中心绑定账号。",
      },
      {
        title: "定期更新与清理",
        body: "在已安装页处理可用更新，卸载不再使用的能力，保持选择列表简洁。",
      },
    ],
    tips: [
      "不知道搜什么时，可使用 AI 导购描述目标，让它推荐候选但不要自动替你授权。",
      "优先选择介绍清楚、版本活跃、风险说明完整的作品。",
    ],
    cautions: [
      "社区作品不等于平台背书；安装前尤其要核对脚本、连接域名与写入权限。",
    ],
    media: "marketplace-discovery",
    related: ["agents", "skills-training", "connectors"],
  },
  "marketplace-publishing": {
    featureId: "marketplace-publishing",
    contentVersion: 3,
    intro:
      "你可以把自己的技能、智能体或插件发布到公共市场。发布页支持由 AI 在对话中生成结构化确认单；提交后自动审核，高风险或不确定内容转人工，状态变化会在市场内实时显示。当前插件发布支持声明式 HTTP API。",
    outcome: "把可复用能力版本化、接受审核，并分享给市场用户。",
    scenarios: ["发布通用技能", "分享专业智能体", "封装受控 API 连接插件"],
    steps: [
      {
        title: "先准备真实可用版本",
        body: "在自己的账号里跑通技能评测、智能体任务或插件身份探针。",
      },
      {
        title: "完善介绍与边界",
        body: "写清适用场景、预期效果、依赖、权限、风险和不适用情况。",
      },
      {
        title: "确认公开内容并提交",
        body: "发布内容会进入公共市场；再次检查说明、依赖和敏感信息，确认后提交审核。",
      },
      {
        title: "处理审核与版本",
        body: "在“我的发布”查看状态和理由，修订后发布新版本；有问题的版本可下架或撤销。",
      },
    ],
    tips: [
      "先用“在对话中创建”完成结构化确认单，小白不必一次填完所有字段。",
      "版本号和变更说明要能让已安装用户判断是否更新。",
    ],
    cautions: [
      "不得发布密钥、个人数据、侵权内容或能绕过权限的脚本；API 插件只能声明允许的固定域名和动作。",
    ],
    media: "marketplace-publishing",
    related: ["skills-training", "connectors", "marketplace-discovery"],
  },
  inbox: {
    featureId: "inbox",
    contentVersion: 2,
    intro:
      "顶栏铃铛汇总服务通知、任务送达、账户提醒和平台公告。未读红点显示需要关注的数量；消息卡可包含格式化正文、图片、图表和链接，并能按全部/未读筛选或一键全部已读。",
    outcome: "在一个位置接收异步任务结果与真正需要处理的服务信息。",
    scenarios: ["定时任务离线送达", "余额或组织提醒", "查看版本与服务公告"],
    steps: [
      {
        title: "关注未读红点",
        body: "点击顶栏铃铛打开站内信，默认先查看未读消息。",
      },
      {
        title: "展开消息详情",
        body: "阅读时间、级别、正文和相关链接；富内容只用于展示，不会在站内信里执行编辑动作。",
      },
      {
        title: "按需标记已读",
        body: "打开单条会自动更新；确认全部处理后再使用“全部已读”。",
      },
      {
        title: "回到对应功能处理",
        body: "任务或账户消息通常会说明下一步，按链接或提示进入管理中心/设置完成操作。",
      },
    ],
    tips: [
      "重要任务同时约定清晰标题，更容易在站内信里识别。",
      "通知偏好在设置中维护。",
    ],
    cautions: ["平台不会通过站内信索要密码或密钥；可疑链接不要输入凭据。"],
    media: "inbox",
    related: ["schedules-reminders", "billing-usage", "preferences"],
  },
  preferences: {
    featureId: "preferences",
    contentVersion: 2,
    intro:
      "设置 → 偏好集中管理浅色/深色主题、默认模型、默认思考深度、通知方式和 Auto-Dream 开关。主题会立即生效，账户偏好会保存到服务端并在其他设备继承。",
    outcome: "让每个新会话从符合你习惯的外观、模型和自动化配置开始。",
    scenarios: [
      "固定默认模型与思考档",
      "切换深色或跟随系统",
      "管理通知和 Auto-Dream",
    ],
    steps: [
      {
        title: "打开偏好分区",
        body: "点击侧栏账户或顶栏余额，再切换到“偏好”。",
      },
      {
        title: "先设置默认值",
        body: "选择常用模型和思考深度；当前会话的人工选择不会被迟到的偏好覆盖。",
      },
      {
        title: "调整外观与通知",
        body: "主题即时切换；只打开真正需要的通知渠道，避免重复提醒。",
      },
      {
        title: "按需开启 Auto-Dream",
        body: "符合套餐条件时可开启自动复盘；随后到记忆中心审阅梦境报告。",
      },
    ],
    tips: [
      "“跟随系统”适合自动日夜切换。",
      "高思考深度作为默认值会增加所有新任务的平均消耗。",
    ],
    cautions: ["浏览器本身可能阻止通知；平台设置不能绕过系统权限。"],
    media: "preferences",
    related: ["models-reasoning", "memory-auto-dream", "billing-usage"],
  },
  "billing-usage": {
    featureId: "billing-usage",
    contentVersion: 2,
    intro:
      "账户与计费页展示套餐、期内积分、长期钱包、充值、订单和收支；用量页按时间、模型、Token、缓存命中和会话拆解消耗。获准使用外部 API 的账号还会看到 API Key 区，普通账号不会显示该入口。",
    outcome: "知道积分从哪里来、花到哪里，并在预算内选择模型和工作方式。",
    scenarios: ["充值或升级套餐", "分析某段时间用量", "核对模型与缓存消耗"],
    steps: [
      {
        title: "先看两个余额桶",
        body: "套餐期内积分通常优先消耗并到期清零，长期钱包用于超额承接；页面会分别标示。",
      },
      {
        title: "用趋势定位消耗",
        body: "切换 24 小时、7 天或 30 天，查看积分、请求、模型和会话分布。",
      },
      {
        title: "核对订单与流水",
        body: "充值/订阅完成后刷新账户，检查订单状态和对应积分流水。",
      },
      {
        title: "按权限管理 API Key",
        body: "仅在页面出现该分区且确需外部调用时创建；明文只显示一次，泄露或不用时立即撤销。",
      },
    ],
    tips: [
      "缓存命中高通常代表长上下文复用更有效，但最终仍以积分流水为准。",
      "团队模式用量会披露成员模型消耗，可与普通会话分开评估。",
    ],
    cautions: [
      "API Key 等同账号凭据，不要发进聊天、截图、代码仓库或日志。支付前核对档位、金额和席位。",
    ],
    media: "billing-usage",
    related: ["models-reasoning", "team-mode", "organization"],
  },
  organization: {
    featureId: "organization",
    contentVersion: 1,
    intro:
      "组织中心提供企业共享积分池、席位订阅、成员与角色、按人月度限额、组织技能、用量报表和发票。普通成员可以使用组织权益；拥有者、管理员与被委派的财务角色各有不同权限。",
    outcome: "让多人在受控预算和权限下共享平台能力，并保留可核对的团队报表。",
    scenarios: [
      "为公司或项目组开通席位",
      "邀请成员并设置限额",
      "查看团队用量与申请发票",
    ],
    steps: [
      {
        title: "创建组织并选档",
        body: "填写组织名称，选择套餐和席位数，支付成功后自动建立组织。",
      },
      {
        title: "邀请与分配角色",
        body: "通过邮箱邀请成员，按最小权限原则设置成员、管理员和财务委派。",
      },
      {
        title: "配置预算与共享能力",
        body: "给成员设置月度限额，安装组织可见技能；组织期内池会按规则优先结算。",
      },
      {
        title: "审阅报表与发票",
        body: "按成员、模型和时间查看消耗；完善发票抬头后，对符合条件的订单申请开票。",
      },
    ],
    tips: [
      "先用少量席位试运行，再按真实使用加席。",
      "管理员负责成员与技能，财务委派只处理计费，职责更清晰。",
    ],
    cautions: [
      "移除成员、调整角色和充值会影响团队权益；操作前核对邮箱、金额和结算范围。",
    ],
    media: "organization",
    related: ["billing-usage", "marketplace-discovery", "inbox"],
  },
  "feedback-support": {
    featureId: "feedback-support",
    contentVersion: 3,
    intro:
      "侧栏的反馈入口可直接打开设置反馈，提交问题、功能建议、体验问题和其他意见；单条回复旁的反馈按钮则会打开消息级反馈。表单只附带明确展示的定位字段，不会自动上传前序对话、文件、工具记录或诊断日志。提交成功后会显示反馈编号。",
    outcome: "用足够的信息让平台团队复现问题、理解需求并跟踪处理。",
    scenarios: ["报告稳定复现的 Bug", "提出功能建议", "反馈移动端或交互体验"],
    steps: [
      {
        title: "选择合适的反馈入口",
        body: "通用问题和建议从侧栏进入反馈页；针对某条 AI 回复的问题，直接点击该回复旁的反馈按钮。",
      },
      {
        title: "快速分类并说明问题",
        body: "选择最接近的类型或原因；如需补充，可写发生时间、操作步骤、预期结果和实际结果。短反馈也能提交，未完成内容会保存在当前账号的本标签页。",
      },
      {
        title: "确认要附带的回复摘录",
        body: "消息级反馈会显示最多 120 字的当前回复摘录，并由你决定是否勾选发送；前序对话和工具记录不会附带。",
      },
      {
        title: "保存反馈编号",
        body: "提交成功会清空表单并返回编号；后续沟通时引用编号能更快定位。",
      },
    ],
    tips: [
      "一次反馈聚焦一个问题，复现成功率更高。",
      "满意回复点一下赞即可完成；点踩会先记录，再让你按需补充原因。",
    ],
    cautions: [
      "紧急账户安全或支付问题不要只依赖普通建议分类，应同时使用官方联系渠道。",
    ],
    example:
      "问题发生于 iPhone Safari：打开某会话后点击图片下载，第一次无响应。复现 3/3；预期下载，实际停留原页。请求 ID：……",
    media: "feedback-support",
    related: ["inbox", "preferences", "sessions-history"],
  },
} as const satisfies Record<ProductFeatureId, TutorialTopic>;

export const TUTORIAL_TOPIC_LIST = Object.values(
  TUTORIAL_TOPICS,
) as TutorialTopic[];

export function tutorialById(id: ProductFeatureId): TutorialTopic {
  return TUTORIAL_TOPICS[id];
}
