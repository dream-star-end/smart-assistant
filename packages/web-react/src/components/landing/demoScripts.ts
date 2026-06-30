import {
  BarChart3,
  Brain,
  Clock,
  Code2,
  Globe,
  type LucideIcon,
  PenLine,
} from "lucide-react";

/** 演示中助手「执行动作」的瞬时提示芯片（联网 / 写记忆 / 建任务…），逐条揭示以展示 agent 能力。 */
export type DemoStep = { label: string };

export type DemoScenario = {
  id: string;
  /** 能力标签（Tab 文案）。 */
  tab: string;
  icon: LucideIcon;
  /** 用户输入（直接整段显示，不打字）。 */
  prompt: string;
  /** 出答案前依次亮起的执行动作（可选）。 */
  steps?: DemoStep[];
  /** 助手回答（逐字打字；\n 保留换行）。 */
  answer: string;
  /** 回答用等宽字体渲染（代码场景）。 */
  mono?: boolean;
};

/**
 * 落地页动态演示脚本 —— 覆盖写作 / 编程 / 联网研究 / 数据分析 / 长期记忆 / 定时自动化，
 * 对应叙事三支柱：开箱即用、越用越好用、越用越懂你。纯展示文案，不发任何真实请求。
 */
export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: "writing",
    tab: "写文案",
    icon: PenLine,
    prompt: "给新品「桂花乌龙拿铁」写一条小红书种草文案",
    answer:
      "🍂 秋天的第一杯，是桂花味的温柔\n\n乌龙茶香打底，桂花甜香收尾，奶香裹着满口秋意～ 不齁不腻，一口入秋！\n\n#秋日限定 #桂花乌龙拿铁 #打工人的快乐",
  },
  {
    id: "coding",
    tab: "写代码",
    icon: Code2,
    prompt: "用 Python 写一个保序去重的函数",
    mono: true,
    answer:
      "def dedup(seq):\n    seen = set()\n    return [x for x in seq\n            if not (x in seen or seen.add(x))]\n\n# 去重同时保留首次出现顺序，O(n)。",
  },
  {
    id: "research",
    tab: "联网研究",
    icon: Globe,
    prompt: "查一下本周可控核聚变有什么新进展，总结要点",
    steps: [{ label: "联网检索 6 个来源" }, { label: "交叉核对事实" }],
    answer:
      "本周要点：\n• 多家托卡马克装置刷新等离子体约束时长纪录\n• 高温超导磁体降本路线获新突破\n• 商业化时间表仍有分歧，2030s 为主流预期\n\n已附 6 条来源链接，可点开溯源。",
  },
  {
    id: "analysis",
    tab: "数据分析",
    icon: BarChart3,
    prompt: "这半年销售额 [12, 15, 14, 19, 23, 28] 万，帮我看趋势",
    answer:
      "整体强势上行：环比平均 +18%，近三月明显加速。\n拐点出现在第 4 个月，建议复盘当月的增长动作，把有效打法复制到下个季度。",
  },
  {
    id: "memory",
    tab: "记住你",
    icon: Brain,
    prompt: "记一下：我是素食者，对花生过敏",
    steps: [{ label: "写入长期记忆" }],
    answer:
      "好的，已经记住 ✅\n以后给你推荐餐厅、菜谱时，会自动避开肉类和花生 —— 不用每次都重新提醒我。越用越懂你。",
  },
  {
    id: "cron",
    tab: "定时自动跑",
    icon: Clock,
    prompt: "每天早上 8 点，把昨天的 AI 行业新闻总结发我",
    steps: [{ label: "创建定时任务" }],
    answer:
      "已经帮你建好定时任务 ⏰\n每天 08:00 自动联网汇总昨日 AI 要闻并推送给你。随时能在「定时任务」里暂停或调整。",
  },
];
