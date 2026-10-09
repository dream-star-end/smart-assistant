/**
 * Intelligent UI(OCV5-361)视觉预览场景:三段典型对话,真实 MessageList 渲染。
 * 本文件只依赖 MessageList,改造前的树上也能跑(用于前后对照);开关关闭的场景在 scenes-iui-off.tsx。
 */
import { useLayoutEffect } from 'react'
import { MessageList } from '../../src/components/MessageRenderer'
import type { CardCallbacks } from '../../src/components/chat/cards'
import type { ChatMessage } from '../../src/lib/chat/model'
import type { Scene } from './types'

const NOW = Date.now()
const noop = () => {}
const cb: CardCallbacks = {
  onRegenerate: noop,
  onContinue: noop,
  onTopUp: noop,
  onStartNewSession: noop,
  onFeedback: noop,
  onRetrySend: noop,
  onQuote: noop,
  onEditResend: noop,
  onOpenModelPicker: noop,
  subscriptionPaid: false,
  resolveRetryTarget: () => undefined,
}

const ui = (v: unknown) => `\n\`\`\`ui\n${JSON.stringify(v)}\n\`\`\`\n`

export const IUI_ROAST = [
  "按 5 人准备了一套周日烤羊腿,用量会随人数自动换算,人数定了改一下就行。",
  ui({
    type: "calculator",
    title: "用量换算",
    inputs: [
      { id: "people", label: "人数", value: 5, min: 2, max: 16, step: 1, unit: "人" },
      { id: "appetite", label: "食量", kind: "select", value: 1, options: [{ label: "正常", value: 1 }, { label: "偏大", value: 1.25 }] },
    ],
    outputs: [
      { id: "lamb", label: "带骨羊腿", formula: "round(people * 0.4 * appetite, 1)", unit: "kg", decimals: 1, primary: true },
      { id: "potato", label: "土豆", formula: "people * 300 * appetite", unit: "g", format: "integer" },
      { id: "carrot", label: "胡萝卜", formula: "people * 150", unit: "g", format: "integer" },
      { id: "minutes", label: "烤制时间", formula: "round(lamb * 45 + 20)", unit: "分钟", format: "integer" },
    ],
    assumptions: ["带骨羊腿每人 400 g", "烤制按每公斤 45 分钟加 20 分钟静置估算,以中心温度 57°C 为准"],
  }),
  ui({
    type: "steps",
    title: "当天流程",
    checkable: true,
    items: [
      { title: "前一晚腌肉", detail: "迷迭香、蒜、橄榄油、盐,冷藏过夜" },
      { title: "提前 1 小时回温" },
      { title: "土豆预煮 8 分钟,沥干摇毛边" },
      { title: "220°C 烤 20 分钟,再转 170°C" },
      { title: "出炉静置 20 分钟后切片" },
    ],
  }),
  ui({ type: "callout", tone: "tip", body: "没有温度计时,用竹签插到最厚处,流出的汁是**浅粉色**就差不多了。" }),
  ui({ type: "suggestions", items: ["改成 8 个人", "加一道素食配菜", "需要提前买些什么?"] }),
].join("\n")

export const IUI_LAPTOPS = [
  "按你说的「常出差、主要写代码、预算 1.5 万内」,三台都能用,差别在重量和续航。",
  ui({
    type: "compare",
    items: [
      { name: "MacBook Air 15", tag: "M4 · 24GB", summary: "续航最长,最省心", pros: ["续航 18 小时", "无风扇静音"], cons: ["外接只能两屏"], recommended: true },
      { name: "ThinkPad X1 Carbon", tag: "Ultra 7 · 32GB", summary: "键盘最好,接口最全", pros: ["1.09 kg 最轻", "键盘手感好"], cons: ["续航一般"] },
      { name: "Framework 13", tag: "Ryzen AI · 32GB", summary: "可升级可维修", pros: ["内存硬盘可换", "Linux 友好"], cons: ["做工略松"] },
    ],
    verdict: "常出差优先续航,选 MacBook Air;离不开 Linux 选 Framework。",
  }),
  ui({
    type: "table",
    title: "关键参数",
    columns: ["机型", { label: "重量", unit: "kg", align: "right" }, { label: "续航", unit: "小时", align: "right" }, { label: "价格", unit: "元", align: "right" }],
    rows: [
      ["MacBook Air 15", 1.51, 18, 12999],
      ["ThinkPad X1 Carbon", 1.09, 11, 14499],
      ["Framework 13", 1.3, 9, 11899],
    ],
    source: "各厂商官网规格页,2026-10;续航为厂商视频播放口径",
  }),
  ui({
    type: "chart",
    kind: "bar",
    title: "实测编译耗时(越低越好)",
    labels: ["MacBook Air 15", "X1 Carbon", "Framework 13"],
    series: [{ name: "冷编译", values: [212, 268, 241] }, { name: "增量", values: [14, 19, 16] }],
    unit: "秒",
    source: "同一仓库 tsc -b,三次取中位数(示例数据)",
  }),
  ui({ type: "suggestions", items: ["预算放到 2 万呢?", "哪台外接显示器最方便?"] }),
].join("\n")

export const IUI_BIKE = [
  "7 速自行车其实就五个部分,按标签切换看每一块。",
  ui({
    type: "tabs",
    title: "7 速自行车",
    tabs: [
      { label: "车架", body: "铝合金三角车架承受全部载荷。**车架尺寸**按身高选:170 cm 左右选 M 码。" },
      { label: "传动", body: "踏板带动链条,后轮的 **7 片飞轮** 让你在爬坡和平路间换挡。\n\n- 爬坡:用大飞轮\n- 平路:用小飞轮" },
      { label: "刹车", body: "前后 V 刹或碟刹。前刹提供约 70% 的制动力,下坡时前后一起捏。" },
      { label: "车把", body: "握把、变速拨杆和刹车手柄都在这里。" },
    ],
  }),
  ui({
    type: "stats",
    items: [
      { label: "常见齿比范围", value: "14–28", unit: "T", basis: "Shimano Tourney 7 速飞轮" },
      { label: "整车重量", value: 13.5, unit: "kg", basis: "通勤铝架款平均值" },
      { label: "保养周期", value: 500, unit: "km", delta: "链条上油", tone: "neutral", basis: "厂商建议" },
    ],
  }),
  ui({
    type: "timeline",
    title: "第一次骑行前",
    items: [
      { time: "出发前", title: "检查胎压", detail: "侧面印的范围,通勤一般 50–60 psi" },
      { time: "上车后", title: "调座高", detail: "脚踩到最低点时膝盖微弯" },
      { time: "骑行中", title: "先换挡再用力", detail: "上坡前提前换到大飞轮" },
    ],
  }),
].join("\n")

let seq = 0
function m(partial: Partial<ChatMessage> & Pick<ChatMessage, "role">): ChatMessage {
  seq += 1
  return { id: partial.id ?? `iui-${seq}`, text: "", ts: NOW - (40 - seq) * 60_000, _source: "server", ...partial }
}

export function conversation(question: string, answer: string): ChatMessage[] {
  seq = 0
  return [m({ role: "user", text: question }), m({ role: "assistant", text: answer, id: "iui-answer" })]
}

export function Timeline({ messages }: { messages: ChatMessage[] }) {
  // 生产 #root 是 position:fixed + 100dvh + overflow:hidden;放开它,移动端才能截到整段对话(同 scenes-messages 的 Page)。
  useLayoutEffect(() => {
    const html = document.documentElement
    const body = document.body
    const root = document.getElementById('root')
    const prev = [html.style.height, body.style.height, body.style.overflow]
    const prevRoot = root ? [root.style.position, root.style.height, root.style.overflow] : null
    html.style.height = 'auto'
    body.style.height = 'auto'
    body.style.overflow = 'visible'
    if (root) {
      root.style.position = 'static'
      root.style.height = 'auto'
      root.style.overflow = 'visible'
    }
    return () => {
      ;[html.style.height, body.style.height, body.style.overflow] = prev
      if (root && prevRoot) [root.style.position, root.style.height, root.style.overflow] = prevRoot
    }
  }, [])
  return (
    <div className="min-h-screen bg-bg">
      <div className="mx-auto max-w-[760px] px-4 py-6">
        <MessageList messages={messages} sending={false} cb={cb} onRespondPermission={noop} sessionId="preview-iui" />
      </div>
    </div>
  )
}

const VIEWPORTS: ("desktop" | "mobile")[] = ["mobile", "desktop"]

export const iuiScenes: Scene[] = [
  {
    id: "iui-roast",
    label: "Intelligent UI · 周日烤羊腿(计算器 + 清单 + 建议)",
    group: "工作区",
    viewports: VIEWPORTS,
    api: {},
    render: () => <Timeline messages={conversation("周日请朋友来家里吃烤羊腿,人数还没定,帮我做个方案", IUI_ROAST)} />,
  },
  {
    id: "iui-laptops",
    label: "Intelligent UI · 笔记本对比(对比卡 + 表格 + 图表)",
    group: "工作区",
    viewports: VIEWPORTS,
    api: {},
    render: () => <Timeline messages={conversation("出差多、主要写代码,1.5 万内买哪台笔记本?", IUI_LAPTOPS)} />,
  },
  {
    id: "iui-bike",
    label: "Intelligent UI · 7 速自行车(分段标签 + 指标 + 时间线)",
    group: "工作区",
    viewports: VIEWPORTS,
    api: {},
    render: () => <Timeline messages={conversation("给我讲讲 7 速自行车的结构", IUI_BIKE)} />,
  },
]

