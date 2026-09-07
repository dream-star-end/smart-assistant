import { ArrowLeft, ArrowRight, Download, ExternalLink, Play, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { SIGNATURE_WORKS, signatureAsset, signatureTask, type SignatureWork } from '../../lib/tutorialSignatureWorks'
import type { TutorialCase } from '../../lib/tutorialCaseCatalog'
import { Button } from '../ui'

type RunProps = { onRun?: (item: TutorialCase) => void; actionLabel?: string }
function WorkCover({ work }: { work: SignatureWork }) {
  const [failed, setFailed] = useState(false)
  return failed ? <div className="flex h-full items-center justify-center bg-[#101624] p-8 text-center text-lg text-white">{work.subtitle}</div> : <img className="h-full w-full object-cover" src={signatureAsset(work, 'cover.png')} alt={work.title + '真实运行画面'} loading="lazy" width={1440} height={900} onError={() => setFailed(true)} />
}
export function SignatureGallery({ onSelect }: { onSelect: (work: SignatureWork) => void }) {
  return <section className="mb-12" aria-label="精选可交互作品">
    <p className="flex items-center gap-2 text-caption font-semibold text-accent"><Sparkles size={15} /> 从一个想法，到眼前这个作品</p>
    <h1 className="mt-4 max-w-3xl text-balance text-[34px] font-semibold leading-[1.15] tracking-tight text-fg sm:text-[48px]">别只问 AI。<br />让它做给你看。</h1>
    <p className="mt-4 max-w-2xl text-body leading-7 text-muted">下一颗星球，一场引力实验。这里展示的不是功能清单，是可以点进去、亲手改变的真实作品。</p>
    <div className="mt-8 space-y-6">
      {SIGNATURE_WORKS.map((work, index) => <article key={work.id} className="relative isolate overflow-hidden rounded-3xl border border-white/10 bg-[#080e19] text-white">
        <div className="relative h-[230px] overflow-hidden sm:absolute sm:inset-0 sm:h-auto"><WorkCover work={work} /></div>
        <div className="pointer-events-none absolute inset-0 hidden bg-gradient-to-r from-[#080e19] via-[#080e19]/90 to-transparent sm:block" />
        <div className="relative flex min-h-[260px] flex-col justify-center p-6 sm:min-h-[430px] sm:max-w-[59%] sm:p-10">
          <p className="font-mono text-[10px] tracking-[.16em] sm:text-xs" style={{ color: work.color }}>0{index + 1} / {work.kicker}</p>
          <h2 className="mt-4 text-balance text-[27px] font-semibold leading-tight tracking-tight sm:text-[36px]">{work.title}</h2>
          <p className="mt-4 max-w-md text-meta leading-7 text-white/65">{work.subtitle}</p>
          <div className="mt-7"><button type="button" onClick={() => onSelect(work)} className="inline-flex min-h-11 items-center gap-3 rounded-full bg-white px-5 py-3 text-meta font-semibold text-[#101820] transition hover:bg-white/85 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"><Play size={15} fill="currentColor" />{work.action}<ArrowRight size={15} /></button></div>
          <p className="mt-4 text-[10px] text-white/40">原创代码实作 · 画面来自实际运行 · 非完整会话回放</p>
        </div>
      </article>)}
    </div>
  </section>
}
export function SignatureDetail({ work, onBack, onRun, actionLabel }: RunProps & { work: SignatureWork; onBack: () => void }) {
  const [loaded, setLoaded] = useState(false)
  const [slow, setSlow] = useState(false)
  const [copy, setCopy] = useState<'idle' | 'ok' | 'failed'>('idle')
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus({ preventScroll: true }); heading.current?.closest('.tutorial-detail')?.scrollTo({ top: 0 }); const timer = setTimeout(() => setSlow(true), 8000); return () => clearTimeout(timer) }, [work.id])
  async function copyPrompt() { try { await navigator.clipboard.writeText(work.prompt); setCopy('ok') } catch { setCopy('failed') } }
  return <article className="mx-auto max-w-6xl px-4 pb-12 pt-5 sm:px-8" data-signature-work={work.id}>
    <button type="button" onClick={onBack} className="inline-flex items-center gap-2 text-meta text-muted hover:text-fg"><ArrowLeft size={15} />返回案例展厅</button>
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3"><div><p className="font-mono text-caption text-accent">{work.kicker}</p><h1 ref={heading} tabIndex={-1} className="mt-2 text-[26px] font-semibold tracking-tight text-fg outline-none sm:text-[34px]">{work.title}</h1></div><a className="inline-flex items-center gap-2 text-meta text-accent" href={signatureAsset(work, 'index.html')} target="_blank" rel="noopener noreferrer">全屏独立体验 <ExternalLink size={15} /></a></div>
    <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-[#080e19]">
      {!loaded && <p role="status" className="p-4 text-meta text-white/70">{slow ? '设备加载较慢，可点“全屏独立体验”；三维作品需要 WebGL。' : '正在打开真实作品…'}</p>}
      <iframe title={work.title + '可交互作品'} src={signatureAsset(work, 'index.html')} sandbox="allow-scripts" referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} className="h-[760px] w-full border-0 sm:h-[780px]" />
    </div>
    <p className="mt-3 text-caption leading-6 text-muted">直接在作品内操作；手机可向下滑动查看参数。保存星球画面时，请使用“全屏独立体验”。</p>
    <div className="mt-4 flex flex-wrap gap-x-6 gap-y-3 text-meta"><a className="inline-flex items-center gap-2 text-accent" href={signatureAsset(work, 'source.zip')} download><Download size={15} />下载完整源文件</a><a className="text-muted" href={signatureAsset(work, 'manifest.json')} target="_blank" rel="noopener noreferrer">查看来源与校验记录</a></div>
    <section className="mt-8 rounded-2xl border border-accent/20 bg-accent-soft p-5 sm:p-7"><h2 className="text-title font-semibold text-fg">换成你的想法，会做出什么？</h2><p className="mt-2 text-meta leading-6 text-muted">“{work.request}”</p><div className="mt-5 flex flex-wrap gap-3">{onRun && <Button variant="primary" onClick={() => onRun(signatureTask(work))}>{actionLabel === '登录后试用' ? '登录后做我的版本' : '做我的版本'}<ArrowRight size={15} /></Button>}<Button variant="secondary" onClick={() => void copyPrompt()}>{copy === 'ok' ? '已复制' : '复制创作指令'}</Button></div><p className="mt-3 text-caption text-muted">{actionLabel === '登录后试用' ? '登录后回到作品带入指令。' : '指令会带入可修改的草稿。'}不会自动发送，开始执行后按所选模型正常计费。</p>{copy === 'failed' && <p role="status" className="mt-3 text-caption text-warning">复制失败，请展开下方指令手动复制。</p>}<details className="mt-4 text-meta text-muted"><summary className="cursor-pointer">查看创作指令</summary><p className="mt-3 select-text whitespace-pre-wrap leading-7">{work.prompt}</p></details></section>
    <details className="mt-6 rounded-xl border border-border p-5 text-meta text-muted"><summary className="cursor-pointer font-medium">从一句话到作品：做了什么，有哪些边界？</summary><p className="mt-3 leading-7">{work.explanation}</p><p className="mt-3 leading-7">{work.limits}</p><p className="mt-3 text-caption">本次原创实作不是三次独立验证的完整会话回放，也不是对任何模型一次生成效果的保证。</p></details>
  </article>
}
