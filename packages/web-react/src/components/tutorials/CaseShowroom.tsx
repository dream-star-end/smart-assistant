import { SignatureGallery, SignatureDetail } from './SignatureShowcases'
import type { SignatureWork } from '../../lib/tutorialSignatureWorks'
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Download, ExternalLink, FileText } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { TUTORIAL_SHOWCASES, showcaseAsset, showcaseTask, type TutorialShowcase } from '../../lib/tutorialShowcase'
import type { TutorialCase, TutorialCaseId } from '../../lib/tutorialCaseCatalog'
import { cn } from '../../lib/utils'
import { Button } from '../ui'

type Props = { onSelect: (id: TutorialCaseId) => void; onRun?: (item: TutorialCase) => void; actionLabel?: string }
function ResultCover({ item }: { item: TutorialShowcase }) {
  const mint = item.theme === 'mint'
  const [failed, setFailed] = useState(false)
  if (!failed) return (
    <div className="relative overflow-hidden border-b border-border bg-[#f3f6ef]">
      <img src={'/tutorials/showcase-covers/' + item.caseId + '.png'} alt={item.title + '实际看板截图'} width={1024} height={740} loading="lazy" onError={() => setFailed(true)} className="aspect-[16/10] w-full object-contain object-center" />
      <span className="absolute bottom-3 right-3 rounded-full border border-white/30 bg-[#102b29]/90 px-3 py-1.5 text-caption text-white shadow-sm">真实作品 · 点开可交互</span>
    </div>
  )
  return (
    <div className={cn('relative flex min-h-[260px] flex-col justify-between overflow-hidden p-6 text-white sm:p-8', mint ? 'bg-[#102b29]' : 'bg-[#152442]')}>
      <div className={cn('pointer-events-none absolute -right-10 -top-16 h-64 w-64 rounded-full blur-3xl', mint ? 'bg-emerald-300/15' : 'bg-sky-300/15')} />
      <div className="relative flex items-center justify-between text-caption">
        <span className="font-medium tracking-widest text-white/70">{mint ? 'DEMAND EXPLORER' : 'MARKET BRIEF'}</span>
        <span className="rounded-full border border-white/20 px-2.5 py-1 text-white/80">可交互成果</span>
      </div>
      <div className="relative my-7 grid grid-cols-3 gap-3" aria-label="实作结果摘要">
        {item.evidence.metrics.slice(0, 3).map((metric) => <div key={metric.label} className="min-w-0 border-l border-white/20 pl-3">
          <strong className={cn('block whitespace-nowrap text-[16px] font-semibold tracking-tight sm:text-[20px]', mint ? 'text-emerald-200' : 'text-sky-200')}>{metric.value}</strong>
          <span className="mt-2 block text-[11px] leading-5 text-white/65">{metric.label}</span>
        </div>)}
      </div>
      <div className="relative flex items-center justify-between border-t border-white/15 pt-4 text-caption text-white/65"><span>真实计算 · 数据和报告一起交付</span><ArrowUpRight size={17} /></div>
    </div>
  )
}

export function CaseShowroom({ onSelect, onRun, actionLabel }: Props) {
  const [activeWork, setActiveWork] = useState<SignatureWork | null>(null)
  if (activeWork) return <SignatureDetail key={activeWork.id} work={activeWork} onBack={() => setActiveWork(null)} onRun={onRun} actionLabel={actionLabel} />
  return (
    <section className="mx-auto max-w-6xl px-4 pb-10 pt-8 sm:px-8 sm:pt-12">
      <SignatureGallery onSelect={setActiveWork} />
      <h2 className="text-[24px] font-semibold tracking-tight text-fg">还有这些，能直接用在工作里。</h2>
      <p className="mt-2 text-meta text-muted">从真实数据到可核对的结果。继续探索这些公开数据实作。</p>
      <div className="mt-9 grid gap-6 lg:grid-cols-2">
        {TUTORIAL_SHOWCASES.map((item) => <article key={item.caseId} className="overflow-hidden rounded-3xl border border-border bg-surface shadow-sm">
          <ResultCover item={item} />
          <div className="p-5 sm:p-6">
            <p className="text-caption font-semibold text-accent">{item.category}</p>
            <h2 className="mt-2 text-balance text-[22px] font-semibold leading-8 tracking-tight text-fg">{item.title}</h2>
            <p className="mt-3 text-meta leading-6 text-muted">{item.lead}</p>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={() => onSelect(item.caseId)} aria-label={'查看成果：' + item.title}>查看成果 <ArrowRight size={15} /></Button>
              {onRun && <Button variant="ghost" onClick={() => onRun(showcaseTask(item))} aria-label={'做一个我的版本：' + item.title}>{actionLabel === '登录后试用' ? '登录后做我的版本' : '做一个我的版本'}</Button>}
            </div>
          </div>
        </article>)}
      </div>
      <p className="mt-6 text-caption leading-6 text-faint">公开数据实作 · 每份成果附原始输入、计算结果与校验记录。展示的是本次样例交付，不是完整会话回放，也不是对所有任务效果的承诺。</p>
    </section>
  )
}

export function ShowcaseDetail({ item, onBack, onRun, actionLabel }: Omit<Props, 'onSelect'> & { item: TutorialShowcase; onBack: () => void }) {
  const [preview, setPreview] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [slow, setSlow] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])
  useEffect(() => {
    if (!preview || loaded) return
    const timer = setTimeout(() => setSlow(true), 8000)
    return () => clearTimeout(timer)
  }, [preview, loaded])
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(item.prompt)
      setCopied(true); setCopyFailed(false)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1800)
    } catch { setCopyFailed(true) }
  }
  return (
    <article className="mx-auto max-w-5xl px-4 pb-12 pt-5 sm:px-8" data-showcase-id={item.caseId}>
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 rounded text-meta text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"><ArrowLeft size={14} /> 返回案例展厅</button>
      <div className="mt-6 flex flex-wrap items-center gap-2 text-caption"><span className="rounded-full bg-accent-soft px-3 py-1 font-medium text-accent">{item.category}</span><span className="text-muted">公开数据实作 · 非完整会话回放</span></div>
      <h1 className="mt-4 max-w-3xl text-balance text-[29px] font-semibold leading-tight tracking-tight text-fg sm:text-[38px]">{item.title}</h1>
      <p className="mt-3 max-w-3xl text-body leading-7 text-muted">{item.lead}</p>
      <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-surface" aria-label="实际交付成果">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="flex items-center gap-2 text-meta font-semibold text-fg"><FileText size={16} /> 先看看，最后做出了什么</h2>
          <a href={showcaseAsset(item, 'dashboard.html')} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-caption text-accent">独立打开看板 <ExternalLink size={13} /></a>
        </div>
        {preview ? <>
          {!loaded && <p role="status" className="px-4 py-3 text-caption text-muted">{slow ? '预览加载较慢，可以用上方链接独立打开看板。' : '正在打开交互看板…'}</p>}
          <iframe title={item.title + '交互看板'} src={showcaseAsset(item, 'dashboard.html')} sandbox="allow-scripts" referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} className="h-[570px] w-full border-0 bg-[#f5f7fa]" />
        </> : <div>
          <ResultCover item={item} />
          <div className="flex flex-wrap items-center justify-between gap-3 bg-surface px-5 py-4"><p className="text-meta text-muted">不是截图。切换条件，亲手探索这份数据。</p><Button variant="primary" onClick={() => setPreview(true)}>打开交互看板 <ArrowUpRight size={15} /></Button></div>
        </div>}
        <div className="flex flex-wrap gap-x-5 gap-y-3 border-t border-border px-4 py-4 text-meta">
          <a href={showcaseAsset(item, 'report.md')} download className="inline-flex items-center gap-1.5 text-accent"><Download size={14} /> 下载分析报告</a>
          <a href={showcaseAsset(item, 'derived.csv')} download className="inline-flex items-center gap-1.5 text-accent"><Download size={14} /> 下载分析数据</a>
          <a href={showcaseAsset(item, 'manifest.json')} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-muted"><Check size={14} /> 查看校验记录</a>
        </div>
      </section>
      <section className="mt-8 grid gap-6 md:grid-cols-[.8fr_1.2fr]" aria-label="从需求到成果">
        <div className="rounded-2xl bg-surface p-5"><h2 className="text-caption font-semibold text-muted">从这样一个需求开始</h2><blockquote className="mt-3 text-[18px] font-medium leading-8 text-fg">“{item.request}”</blockquote><p className="mt-3 text-caption text-faint">案例任务说明，不是用户原话或聊天回放。</p></div>
        <div><h2 className="text-title font-semibold text-fg">值得看的，不只是最后一张图</h2><ol className="mt-4 space-y-4">{item.evidence.highlights.map((step, index) => <li key={step.title} className="flex gap-3"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-caption font-semibold text-accent">{index + 1}</span><div><h3 className="text-meta font-semibold text-fg">{step.title}</h3><p className="mt-1 text-meta leading-6 text-muted">{step.body}</p></div></li>)}</ol></div>
      </section>
      <section className="mt-8 rounded-2xl border border-accent/20 bg-accent-soft p-5 sm:p-7">
        <h2 className="text-[22px] font-semibold text-fg">换成你的问题，会做出什么？</h2><p className="mt-2 text-meta leading-6 text-muted">不用照抄案例。告诉它你的目标，再补上材料，先确认范围再开始。</p>
        <div className="mt-4 flex flex-wrap gap-3">{onRun && <Button variant="primary" onClick={() => onRun(showcaseTask(item))}>{actionLabel === '登录后试用' ? '登录后做我的版本' : '做一个我的版本'} <ArrowRight size={15} /></Button>}<Button variant="secondary" onClick={() => void copyPrompt()}>{copied ? '已复制' : '复制任务指令'}</Button></div>
        <p className="mt-3 text-caption text-muted">{actionLabel === '登录后试用' ? '登录后回到案例，可带入可修改的任务指令。不会自动发送；运行后正常计费。' : onRun ? '会带入可修改的任务指令，不会自动发送；开始运行后按所选模型正常计费。' : '复制指令后，回到对话修改并发送。'}</p>
        {copyFailed && <p role="status" className="mt-3 text-caption text-warning">未能复制，请展开下方任务指令手动复制。</p>}
        <details className="mt-4 text-meta text-muted"><summary className="cursor-pointer">查看任务指令</summary><p className="mt-3 select-text whitespace-pre-wrap leading-7">{item.prompt}</p></details>
      </section>
      <details className="mt-7 rounded-xl border border-border p-4 text-caption text-muted"><summary className="cursor-pointer font-medium">数据来源、生成时间与适用边界</summary><p className="mt-3 leading-6">成果生成时间：{item.evidence.generatedAt}。数据所属年份见看板与报告；生成时间不代表数据是最新的。</p><ul className="mt-2 list-disc space-y-1 pl-5">{item.evidence.limitations.map((line) => <li key={line}>{line}</li>)}</ul><ul className="mt-3 space-y-2">{item.evidence.inputs.map((input) => <li key={input.path}><a className="break-all text-accent underline" href={input.path} target="_blank" rel="noopener noreferrer">{input.path.split('/').pop()}</a></li>)}</ul></details>
    </article>
  )
}
