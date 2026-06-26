import type { Message, Session, User } from "./types";

export const DEMO_USER: User = { id: "demo", displayName: "rqmn", roles: ["user"] };

const now = Date.now();
const iso = (mins: number) => new Date(now - mins * 60000).toISOString();

export const DEMO_SESSIONS: Session[] = [
  { id: "s1", title: "把商业版重做成 ChatGPT 风格", ownerUserId: "demo", updatedAt: iso(3), messageCount: 4 },
  { id: "s2", title: "锂金属负极枝晶抑制机理综述", ownerUserId: "demo", updatedAt: iso(40), messageCount: 8 },
  { id: "s3", title: "A 股多 agent 投研平台方案", ownerUserId: "demo", updatedAt: iso(120), messageCount: 12 },
  { id: "s4", title: "杭州四季青 AI 智能体需求评估", ownerUserId: "demo", updatedAt: iso(1500), messageCount: 6 },
  { id: "s5", title: "南山 baseline transfer 计划评阅", ownerUserId: "demo", updatedAt: iso(1600), messageCount: 9 },
  { id: "s6", title: "部署链路与备份机巡检", ownerUserId: "demo", updatedAt: iso(4000), messageCount: 5 },
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

export function demoReply(text: string): string {
  return `收到，关于「${text.slice(0, 40)}${text.length > 40 ? "…" : ""}」，我的思路如下：

1. **先拆解目标** —— 明确要解决的核心问题与约束条件
2. **给出方案** —— 兼顾可维护性、扩展性与一致性
3. **落地验证** —— 用最小可验证的步骤先跑通

> 这是演示模式下的本地回复。连接真实后端后，将由 **MiniMax-M3** 等模型实时流式生成。

需要我针对某一步展开吗？`;
}
