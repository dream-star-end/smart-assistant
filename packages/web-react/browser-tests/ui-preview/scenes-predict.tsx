/**
 * 输入预测(OCV5-375)前后对照:真实 MessageList + 真实 Composer,按会话页的上下结构排。
 *
 * 只依赖改造前就有的组件,旧树上也能跑:截「改造前」时把 AFTER 改成 false(回答里没有 next 块,
 * 输入框也不传 prediction —— 旧 Composer 本来就不认这个属性)。预测值按 lib/inputPrediction 对
 * 这段时间线会得出的结果写成字面量,不 import 新模块,免得旧树打包失败。
 */
import { useLayoutEffect, useRef } from 'react'
import { Composer } from '../../src/components/Composer'
import { writeDraft } from '../../src/lib/composerDraft'
import { conversation, Timeline } from './scenes-iui'
import type { Scene } from './types'

const AFTER = true

const ui = (v: unknown) => `\n\`\`\`ui\n${JSON.stringify(v)}\n\`\`\`\n`

const SOLAR_Q = '做一个带动画的太阳系,行星按真实顺序排,标上名字'
const SOLAR_NEXT = '把木星的四颗伽利略卫星也加到动画里'
const SOLAR_SUGGESTIONS = ['改成可以拖着旋转的三维太阳系', '加上木星的四颗伽利略卫星', '用某一天的真实星历摆放行星位置']
const SOLAR_A = [
  '做好了:八大行星按离太阳由近到远排列,轨道周期按真实比例缩放,鼠标停在行星上会显示名字和公转周期。',
  ui({
    type: 'table',
    title: '行星参数',
    columns: ['行星', { label: '距日', unit: 'AU', align: 'right' }, '公转周期', { label: '卫星数', align: 'right' }],
    rows: [
      ['水星', 0.387, '88 天', 0],
      ['金星', 0.723, '0.62 年', 0],
      ['地球', 1, '1 年', 1],
      ['火星', 1.52, '1.88 年', 2],
      ['木星', 5.2, '11.9 年', 95],
    ],
    highlight: 2,
    source: 'NASA NSSDC 行星数据表',
  }),
  ui({
    type: 'callout',
    tone: 'info',
    title: '为什么图上木星没有那么大',
    body: '真实比例里,海王星会小到看不见,外行星也几乎不动。动画把间距、大小和默认公转都做了压缩,只保留「内圈更快、外圈更慢」。',
  }),
  ui({ type: 'suggestions', items: SOLAR_SUGGESTIONS }),
  ...(AFTER ? [ui({ type: 'next', text: SOLAR_NEXT })] : []),
].join('\n')

const SCRIPT_Q = '把 downloads 目录里超过 30 天的安装包清掉,先别真删,列个清单给我看'
const SCRIPT_NEXT = '好的,删掉吧'
const SCRIPT_A = [
  '扫了一遍 `~/Downloads`,超过 30 天的安装包一共 14 个,合计 **6.8 GB**,清单如下(还没有删除任何文件):',
  ui({
    type: 'table',
    columns: ['文件', { label: '大小', unit: 'MB', align: 'right' }, '最后修改'],
    rows: [
      ['Docker-4.31.dmg', 1520, '2026-07-02'],
      ['Xcode_16.3.xip', 3410, '2026-06-18'],
      ['node-v22.4.pkg', 88, '2026-07-21'],
      ['…另外 11 个', 1790, ''],
    ],
  }),
  '确认没问题的话,我就把这 14 个文件移到废纸篓(可以从废纸篓恢复)。要我现在删除吗?',
  ...(AFTER ? [ui({ type: 'next', text: SCRIPT_NEXT })] : []),
].join('\n')

function Page({ question, answer, draftKey, draft, next, candidates }: {
  question: string
  answer: string
  draftKey: string
  draft: string
  next: string
  candidates: string[]
}) {
  writeDraft(draftKey, draft)
  // Timeline 自带 min-h-screen;移动端截图会把视口拉到文档高度,它跟着变高,输入框就被挤出画面。
  const wrap = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const first = wrap.current?.firstElementChild
    if (first instanceof HTMLElement) first.style.minHeight = '0'
  }, [])
  return (
    <div className="bg-bg">
      <div ref={wrap}>
        <Timeline messages={conversation(question, answer)} />
      </div>
      <div className="mx-auto max-w-[760px] px-4 pb-6">
        <Composer
          draftKey={draftKey}
          onSend={() => {}}
          onUpload={async () => ({ kind: 'image', url: '/api/media/x' })}
          getVoiceToken={() => 'preview-token'}
          onOpenRepo={() => {}}
          repoSelection={null}
          placeholder="和「全能助手」对话…"
          lastUserText={question}
          {...(AFTER ? { prediction: { next: { text: next, source: 'agent' as const }, candidates } } : {})}
        />
      </div>
    </div>
  )
}

const scene = (id: string, label: string, render: () => React.ReactNode): Scene => ({
  id,
  label,
  group: '工作区',
  viewports: ['desktop', 'mobile'],
  api: {},
  render,
})

export const predictScenes: Scene[] = [
  scene('predict-empty', '输入预测 · 回答后空输入框(助手预测的下一句)', () => (
    <Page
      question={SOLAR_Q}
      answer={SOLAR_A}
      draftKey="preview-predict-empty"
      draft=""
      next={SOLAR_NEXT}
      candidates={[SOLAR_NEXT, ...SOLAR_SUGGESTIONS, SOLAR_Q]}
    />
  )),
  scene('predict-typing', '输入预测 · 打字时补全', () => (
    <Page
      question={SOLAR_Q}
      answer={SOLAR_A}
      draftKey="preview-predict-typing"
      draft="改成"
      next={SOLAR_NEXT}
      candidates={[SOLAR_NEXT, ...SOLAR_SUGGESTIONS, SOLAR_Q]}
    />
  )),
  scene('predict-confirm', '输入预测 · 等用户确认时预测答复', () => (
    <Page
      question={SCRIPT_Q}
      answer={SCRIPT_A}
      draftKey="preview-predict-confirm"
      draft=""
      next={SCRIPT_NEXT}
      candidates={[SCRIPT_NEXT, SCRIPT_Q]}
    />
  )),
]
