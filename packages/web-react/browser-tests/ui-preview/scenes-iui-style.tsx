/**
 * Intelligent UI 视觉风格选型(OCV5-416):同一段对话分别套四种外框风格,真实 MessageList 渲染。
 *   now      现状:白底浮起卡片(描边 + 两层阴影)
 *   glass    玻璃拟态:半透明 + 背景模糊 + 高光描边;为了让模糊有东西可透,对话区铺一层环境光
 *   seamless 无缝嵌入:去掉外框和底色,内容与正文左对齐,只保留卡内的浅色分区
 *   tonal    分层(推荐):展示类(表格/图表/指标/步骤/时间线…)无缝嵌入;要操作的(计算器/表单/测验/成稿/对比/行情…)
 *            放在无阴影的浅色调面板里,面板内的输入控件反衬为白底
 * 风格只在本文件的 <style> 里按 [data-iui-style] 覆盖,不改 production CSS;选定后再落到 styles.css。
 */
import { IUI_BIKE, IUI_LAPTOPS, IUI_ROAST, Timeline, conversation } from './scenes-iui'
import type { Scene } from './types'

type Variant = 'now' | 'glass' | 'seamless' | 'tonal'

/** 需要操作或自成一体的组件:分层方案里放面板;其余为展示类,无缝嵌入。 */
const PANEL_KINDS = ['calculator', 'form', 'quiz', 'draft', 'recipe', 'route', 'quote', 'kline', 'intraday', 'stocklist']
const panel = PANEL_KINDS.map((k) => `[data-iui="${k}"]`).join(',')

const CSS = `
/* ── 玻璃拟态 ── */
[data-iui-style="glass"] .bg-bg {
  background:
    radial-gradient(55% 28% at 12% 8%, color-mix(in srgb, var(--iui-c1) 24%, transparent), transparent 72%),
    radial-gradient(45% 26% at 92% 34%, color-mix(in srgb, var(--iui-c2) 20%, transparent), transparent 72%),
    radial-gradient(50% 26% at 18% 62%, color-mix(in srgb, var(--iui-c5) 18%, transparent), transparent 72%),
    radial-gradient(50% 24% at 88% 90%, color-mix(in srgb, var(--iui-c4) 16%, transparent), transparent 72%),
    var(--bg);
}
[data-iui-style="glass"] {
  --iui-surface: rgb(255 255 255 / 0.52);
  --iui-sunken: color-mix(in srgb, var(--fg) 3.5%, transparent);
  --iui-ring: rgb(255 255 255 / 0.75);
  --iui-shadow: inset 0 1px 0 rgb(255 255 255 / 0.9), 0 12px 32px -14px rgb(40 30 100 / 0.22);
  --iui-shadow-lift: inset 0 1px 0 rgb(255 255 255 / 0.9), 0 16px 40px -16px rgb(40 30 100 / 0.3);
}
.dark [data-iui-style="glass"] {
  --iui-surface: rgb(255 255 255 / 0.045);
  --iui-sunken: rgb(255 255 255 / 0.04);
  --iui-ring: rgb(255 255 255 / 0.1);
  --iui-shadow: inset 0 1px 0 rgb(255 255 255 / 0.08), 0 12px 32px -14px rgb(0 0 0 / 0.7);
  --iui-shadow-lift: inset 0 1px 0 rgb(255 255 255 / 0.1), 0 16px 40px -16px rgb(0 0 0 / 0.8);
}
[data-iui-style="glass"] :is(.oc-iui-card, .oc-iui-compare-card, .oc-iui-suggestion) {
  -webkit-backdrop-filter: blur(22px) saturate(170%); backdrop-filter: blur(22px) saturate(170%);
}
[data-iui-style="glass"] .oc-iui-card { border-radius: 20px; }

/* ── 无缝嵌入(seamless 全部;tonal 的展示类) ── */
[data-iui-style="seamless"] { --iui-surface: var(--bg); }
[data-iui-style="seamless"] .oc-iui-card,
[data-iui-style="tonal"] .oc-iui-card:not(${panel}) {
  --iui-surface: var(--bg);
  margin-inline: -16px; background: transparent; box-shadow: none; border-radius: 0; overflow: visible;
}
[data-iui-style="seamless"] .oc-iui-card > .oc-iui-foot,
[data-iui-style="tonal"] .oc-iui-card:not(${panel}) > .oc-iui-foot { border-top: 0; padding-top: 4px; }
[data-iui-style="seamless"] .oc-iui-calc-inputs,
[data-iui-style="seamless"] .oc-iui-recipe-steps { margin: 4px 16px 0; border-top: 0; border-radius: 14px; }
[data-iui-style="seamless"] .oc-iui-calc-basis,
[data-iui-style="tonal"] .oc-iui-calc-basis { border-top: 0; }
[data-iui-style="seamless"] .oc-iui-compare-card,
[data-iui-style="seamless"] .oc-iui-suggestion { background: transparent; box-shadow: 0 0 0 1px var(--iui-line); }
[data-iui-style="seamless"] .oc-iui-compare-card.is-recommended { box-shadow: 0 0 0 1.5px var(--accent); }
/* 无缝时标题区用一条细线和正文分开,不再靠外框 */
[data-iui-style="seamless"] .oc-iui-card > .oc-iui-head:not(.is-actions-only),
[data-iui-style="tonal"] .oc-iui-card:not(${panel}) > .oc-iui-head:not(.is-actions-only) { padding-top: 6px; }

/* ── 分层:面板类 ── */
[data-iui-style="tonal"] {
  --iui-panel: color-mix(in srgb, var(--fg) 3.4%, var(--bg));
  --iui-panel-in: var(--surface);
  --iui-panel-ring: transparent;
}
.dark [data-iui-style="tonal"] {
  --iui-panel: color-mix(in srgb, var(--fg) 5%, var(--bg));
  --iui-panel-in: color-mix(in srgb, var(--fg) 9%, var(--bg));
  --iui-panel-ring: rgb(255 255 255 / 0.05);
}
[data-iui-style="tonal"] .oc-iui-card:is(${panel}) {
  --iui-surface: var(--iui-panel-in);
  --iui-sunken: var(--iui-panel-in);
  border-radius: 20px; background: var(--iui-panel); box-shadow: inset 0 0 0 1px var(--iui-panel-ring);
}
[data-iui-style="tonal"] .oc-iui-card:is(${panel}) .oc-iui-calc-inputs { margin: 0 8px 8px; border-top: 0; border-radius: 14px; }
[data-iui-style="tonal"] .oc-iui-compare-card,
[data-iui-style="tonal"] .oc-iui-suggestion { background: var(--iui-panel); box-shadow: inset 0 0 0 1px var(--iui-panel-ring); }
[data-iui-style="tonal"] .oc-iui-compare-card.is-recommended { box-shadow: inset 0 0 0 1.5px var(--accent); background: color-mix(in srgb, var(--accent) 5%, var(--bg)); }
[data-iui-style="tonal"] .oc-iui-suggestion:hover:not(:disabled) { background: color-mix(in srgb, var(--fg) 6%, var(--bg)); }
`

const CONVS: { key: string; label: string; question: string; answer: string }[] = [
  { key: 'roast', label: '计算器 + 清单 + 提示 + 建议', question: '周日请朋友来家里吃烤羊腿,人数还没定,帮我做个方案', answer: IUI_ROAST },
  { key: 'laptops', label: '对比卡 + 表格 + 图表', question: '出差多、主要写代码,1.5 万内买哪台笔记本?', answer: IUI_LAPTOPS },
  { key: 'bike', label: '分段标签 + 指标 + 时间线', question: '给我讲讲 7 速自行车的结构', answer: IUI_BIKE },
]
const VARIANTS: { key: Variant; label: string }[] = [
  { key: 'now', label: '现状' },
  { key: 'glass', label: '玻璃拟态' },
  { key: 'seamless', label: '无缝嵌入' },
  { key: 'tonal', label: '分层(推荐)' },
]

export const iuiStyleScenes: Scene[] = VARIANTS.flatMap((v) =>
  CONVS.map(
    (c): Scene => ({
      id: `iuistyle-${v.key}-${c.key}`,
      label: `IUI 风格 · ${v.label} · ${c.label}`,
      group: '工作区',
      viewports: ['mobile', 'desktop'],
      api: {},
      render: () => (
        <div data-iui-style={v.key}>
          <style>{CSS}</style>
          <Timeline messages={conversation(c.question, c.answer)} />
        </div>
      ),
    }),
  ),
)
