import type { TutorialCaseFieldReport } from '../../lib/tutorialCaseCatalog'
import { cn } from '../../lib/utils'
import { HERO_SURFACE_CLASS } from './heroTheme'

export function CaseFieldReportVisual({
  report,
  pendingCapture = false,
  className,
}: {
  report: TutorialCaseFieldReport
  /**
   * 案例尚无真实运行记录时,图稿不能一边说「只是脚本」一边亮「可核对成果」(审计 TU-10):
   * 指标数字来自 fieldReport 的人工观察记录,保留但加限定词;右上角「案例演示」改为「示意图稿」。
   */
  pendingCapture?: boolean
  className?: string
}) {
  return (
    <div
      role="img"
      aria-label={
        pendingCapture
          ? `案例观察记录示意：${report.result}。数字来自人工观察记录，不是平台验证过的运行结果`
          : `案例成果预览：${report.result}`
      }
      // 图稿底色走 hero 模块级 token(TU-34):浅色仍是品牌深蓝,暗色下抬亮并描边,不再与页面底色同色。
      className={cn(
        'relative isolate aspect-[16/9] overflow-hidden',
        HERO_SURFACE_CLASS,
        className,
      )}
      data-artwork-kind={report.visual}
      data-pending-capture={pendingCapture ? 'true' : undefined}
    >
      <div className="absolute inset-x-4 top-3 z-10 flex items-center justify-between gap-2 sm:inset-x-5 sm:top-4">
        <span className="rounded-full border border-emerald-300/35 bg-emerald-400/15 px-2.5 py-1 text-caption font-semibold text-emerald-100 backdrop-blur-sm">
          {report.visual === 'bike-model-comparison' ? '科研分析成果' : '代码修复成果'}
        </span>
        <span className="text-caption font-medium text-white/70">
          {pendingCapture ? '示意图稿' : '案例演示'}
        </span>
      </div>

      {report.visual === 'bike-model-comparison' ? <BikeModelComparison /> : <AstropyPatch />}

      <div className="absolute inset-x-4 bottom-3 z-10 hidden items-end justify-between gap-3 sm:inset-x-5 sm:bottom-4 sm:flex">
        <div className="min-w-0">
          <p className="truncate text-caption text-white/65">{report.sourceLabel}</p>
          <p className="mt-0.5 text-title font-semibold tracking-tight sm:text-[16px]">
            {report.visual === 'bike-model-comparison'
              ? '模型对照 + 可复跑验证'
              : '先红后绿 + 一行根因修复'}
          </p>
        </div>
        {/* 尚无真实运行记录时不能一边说「只是脚本」一边亮「可核对成果」（审计 TU-10）。 */}
        <span className="shrink-0 rounded-full bg-white/10 px-2.5 py-1 text-caption font-semibold text-white/85">
          {pendingCapture ? '观察记录 · 非平台验证' : '可核对成果'}
        </span>
      </div>
    </div>
  )
}

function BikeModelComparison() {
  return (
    <div className="absolute inset-x-5 bottom-4 top-[48px] grid grid-cols-2 gap-3 sm:inset-x-8 sm:bottom-[66px] sm:top-[58px] sm:gap-5">
      <div className="flex flex-col justify-center rounded-xl border border-white/15 bg-white/[0.07] p-3 backdrop-blur-sm sm:p-4">
        <div className="flex items-center justify-between gap-2 text-caption font-semibold text-white/65">
          <span>RMSE</span>
          <span>越低越好</span>
        </div>
        <div className="mt-3 space-y-2.5 sm:mt-4 sm:space-y-3">
          <MetricBar label="线性" value="117.81" width="100%" color="bg-sky-300/65" />
          <MetricBar label="GBM" value="68.36" width="58%" color="bg-emerald-300" />
        </div>
      </div>
      <div className="flex flex-col justify-center rounded-xl border border-white/15 bg-white/[0.07] p-3 backdrop-blur-sm sm:p-4">
        <div className="flex items-center justify-between gap-2 text-caption font-semibold text-white/65">
          <span>测试集 R²</span>
          <span>越高越好</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:mt-4 sm:gap-3">
          <MetricNumber label="线性" value="0.714" />
          <MetricNumber label="GBM" value="0.904" accent />
        </div>
        <div className="mt-2.5 flex items-center gap-1.5 text-caption font-medium text-emerald-200 sm:mt-3">
          <span className="size-1.5 rounded-full bg-emerald-300" />
          34 项复现测试通过
        </div>
      </div>
    </div>
  )
}

function MetricBar({
  label,
  value,
  width,
  color,
}: {
  label: string
  value: string
  width: string
  color: string
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-caption text-white/75">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/10 sm:h-2.5">
        <span className={cn('block h-full rounded-full', color)} style={{ width }} />
      </div>
    </div>
  )
}

function MetricNumber({
  label,
  value,
  accent = false,
}: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-lg border px-2 py-2 text-center',
        accent ? 'border-emerald-300/35 bg-emerald-300/15' : 'border-white/10 bg-white/[0.04]',
      )}
    >
      <p className="text-caption text-white/55">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-title font-bold sm:text-[19px]',
          accent ? 'text-emerald-200' : 'text-white/80',
        )}
      >
        {value}
      </p>
    </div>
  )
}

function AstropyPatch() {
  return (
    <div className="absolute inset-x-5 bottom-4 top-[48px] overflow-hidden rounded-xl border border-white/15 bg-black/30 font-mono backdrop-blur-sm sm:inset-x-8 sm:bottom-[66px] sm:top-[58px]">
      <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2 text-caption text-white/45">
        <span className="size-1.5 rounded-full bg-rose-400" />
        <span className="size-1.5 rounded-full bg-amber-300" />
        <span className="size-1.5 rounded-full bg-emerald-400" />
        <span className="ml-1 truncate">astropy/modeling/separable.py</span>
      </div>
      <div className="flex h-[calc(100%-33px)] flex-col justify-center px-3 py-2.5 text-caption leading-4 sm:px-4 sm:py-3 sm:text-meta sm:leading-5">
        {/* 390px 下这行曾 truncate 后与下一行重叠；窄屏隐藏上下文行、≥sm 完整换行显示（审计 TU-30）。 */}
        <p className="hidden break-all text-white/45 sm:block">cright[-right.shape[0]:, -right.shape[1]:]</p>
        <p className="mt-0.5 rounded bg-rose-400/10 px-1.5 text-rose-200">− = 1</p>
        <p className="mt-1 rounded bg-emerald-400/10 px-1.5 text-emerald-200">+ = right</p>
        <div className="mt-2 flex flex-wrap gap-2 font-sans text-caption font-semibold">
          <span className="rounded-full bg-rose-400/15 px-2 py-1 text-rose-200">基线 2 failed</span>
          <span className="rounded-full bg-emerald-400/15 px-2 py-1 text-emerald-200">
            修复后 13 passed
          </span>
        </div>
      </div>
    </div>
  )
}
