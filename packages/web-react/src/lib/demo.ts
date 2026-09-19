import type { Message, PublicModel, Session, User } from "./types";

export const DEMO_USER: User = { id: "demo", displayName: "rqmn", roles: ["user"] };

/**
 * 离线预览用的模型列表（?demo=1）。真实工作区一律由 GET /api/public/models 驱动
 * （glm-5.3-zai/deepseek/minimax；Claude 官方模型已全面下线，不再暴露）；这里只是为了
 * 让 demo 模式在零网络下也能展示模型选择器的视觉，刻意与后端权威源解耦、不参与任何请求。
 */
export const DEMO_MODELS: PublicModel[] = [
  { id: "glm-5.3-zai", display_name: "GLM-5.3" },
  { id: "deepseek", display_name: "DeepSeek" },
  { id: "MiniMax-M3", display_name: "MiniMax M3" },
];

const now = Date.now();
const iso = (mins: number) => new Date(now - mins * 60000).toISOString();
const epoch = (mins: number) => now - mins * 60000;

/**
 * 侧栏用时 = updatedAt − createdAt(Session.createdAt 是「整段用时的起点」):缺 createdAt 会让
 * demo 会话行的用时位空掉。这里给每个会话一段合理时长(分钟),与 updatedAt 同源相对当前时刻。
 * messageCount 与下面的 fixture 逐会话对得上:s1 两条,其余会话点开是空态、就标 0 —— 侧栏
 * 不再宣称「8 条消息」而点进去一片空白。
 */
export const DEMO_SESSIONS: Session[] = [
  { id: "s1", title: "把商业版重做成 ChatGPT 风格", ownerUserId: "demo", createdAt: epoch(11), updatedAt: iso(3), messageCount: 2 },
  { id: "s2", title: "锂金属负极枝晶抑制机理综述", ownerUserId: "demo", createdAt: epoch(75), updatedAt: iso(40), messageCount: 0 },
  { id: "s3", title: "A 股多 agent 投研平台方案", ownerUserId: "demo", createdAt: epoch(180), updatedAt: iso(120), messageCount: 0 },
  { id: "s4", title: "杭州四季青 AI 智能体需求评估", ownerUserId: "demo", createdAt: epoch(1530), updatedAt: iso(1500), messageCount: 0 },
  { id: "s5", title: "南山 baseline transfer 计划评阅", ownerUserId: "demo", createdAt: epoch(1700), updatedAt: iso(1600), messageCount: 0 },
  { id: "s6", title: "部署链路巡检与上线清单", ownerUserId: "demo", createdAt: epoch(4025), updatedAt: iso(4000), messageCount: 0 },
];

export const DEMO_MESSAGES: Message[] = [
  {
    id: "m1",
    role: "user",
    content: "帮我把商业版聊天界面基于 ChatGPT 的设计语言完全重做，要更现代、更有设计感。再给个快速排序的 Python 例子。",
    createdAt: iso(3),
  },
  {
    id: "m2",
    role: "assistant",
    createdAt: iso(2),
    content: `没问题。整体会从**设计系统**重新搭起，核心原则是 *克制、留白、层次清晰*：

- **排版**：16px 正文、1.75 行高，标题与正文有明确的视觉层级
- **结构**：助手回答全宽铺排，用户消息走右侧浅灰气泡
- **组件**：悬浮圆角输入区、带语言标签的代码块、可折叠工具卡

下面是快速排序示例：

\`\`\`python
def quicksort(arr):
    if len(arr) <= 1:
        return arr
    pivot = arr[len(arr) // 2]
    left  = [x for x in arr if x < pivot]
    mid   = [x for x in arr if x == pivot]
    right = [x for x in arr if x > pivot]
    return quicksort(left) + mid + quicksort(right)
\`\`\`

平均时间复杂度 \`O(n log n)\`，最坏 \`O(n²)\`（每次划分都极不均衡时）。如果想稳定 \`O(n log n)\`，可以改用归并排序或堆排序。`,
  },
];

/** 每个 demo 会话对应的本地消息 fixture;没登记的会话即空会话(App 的 onDemoSelect 据此切换)。 */
export const DEMO_MESSAGES_BY_SESSION: Readonly<Record<string, Message[]>> = { s1: DEMO_MESSAGES };

/** demo 模式默认选中的模型展示名(App 以 DEMO_MODELS[0] 为初始 modelId,回复文案与之同源)。 */
export const DEMO_DEFAULT_MODEL_NAME: string =
  typeof DEMO_MODELS[0]?.display_name === "string" ? DEMO_MODELS[0].display_name : "所选模型";

export function demoReply(text: string, modelName: string = DEMO_DEFAULT_MODEL_NAME): string {
  return `收到，关于「${text.slice(0, 40)}${text.length > 40 ? "…" : ""}」，我的思路如下：

1. **先拆解目标** —— 明确要解决的核心问题与约束条件
2. **给出方案** —— 兼顾可维护性、扩展性与一致性
3. **落地验证** —— 用最小可验证的步骤先跑通

> 这是演示模式下的本地回复。连接真实后端后，将由 **${modelName}** 等模型实时流式生成。

需要我针对某一步展开吗？`;
}
