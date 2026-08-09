import type { TutorialCaseFieldReport } from '../../lib/tutorialCaseCatalog'
import { cn } from '../../lib/utils'

export function CaseFieldReportVisual({
  report,
  className,
}: {
  report: TutorialCaseFieldReport
  className?: string
}) {
  return (
    <div
      role="img"
      aria-label={`真实实跑结果，观察记录尚未通过公开验证：${report.result}`}
      className={cn(
        'relative isolate aspect-[16/9] overflow-hidden bg-[#07111f] text-white',
        className,
      )}
      data-artwork-kind={report.visual}
    >
      <div className="absolute inset-x-4 top-3 z-10 flex items-center justify-between gap-2 sm:inset-x-5 sm:top-4">
        <span className="rounded-full border border-emerald-300/35 bg-emerald-400/15 px-2.5 py-1 text-[10px] font-semibold text-emerald-100 backdrop-blur-sm sm:text-[11px]">
          V5 真实实跑
        </span>
        <span className="text-[9px] font-medium text-white/70 sm:text-[10px]">
          观察记录 · 尚未公开验证
        </span>
      </div>

      {report.visual === 'bike-model-comparison' ? <BikeModelComparison /> : <AstropyPatch />}

      <div className="absolute inset-x-4 bottom-3 z-10 hidden items-end justify-between gap-3 sm:inset-x-5 sm:bottom-4 sm:flex">
        <div className="min-w-0">
          <p className="truncate text-[10px] text-white/65 sm:text-[11px]">{report.sourceLabel}</p>
          <p className="mt-0.5 text-[14px] font-semibold tracking-tight sm:text-[16px]">
            {report.visual === 'bike-model-comparison'
              ? '模型对照 + 可复跑验证'
              : '先红后绿 + 一行根因修复'}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-white/10 px-2.5 py-1 text-[10px] font-semibold text-white/85 sm:text-[11px]">
          {report.duration}
        </span>
      </div>
    </div>
  )
}

function BikeModelComparison() {
  return (
    <div className="absolute inset-x-5 bottom-4 top-[48px] grid grid-cols-2 gap-3 sm:inset-x-8 sm:bottom-[66px] sm:top-[58px] sm:gap-5">
      <div className="flex flex-col justify-center rounded-xl border border-white/15 bg-white/[0.07] p-3 backdrop-blur-sm sm:p-4">
        <div className="flex items-center justify-between gap-2 text-[9px] font-semibold text-white/65 sm:text-[10px]">
          <span>RMSE</span>
          <span>越低越好</span>
        </div>
        <div className="mt-3 space-y-2.5 sm:mt-4 sm:space-y-3">
          <MetricBar label="线性" value="117.81" width="100%" color="bg-sky-300/65" />
          <MetricBar label="GBM" value="68.36" width="58%" color="bg-emerald-300" />
        </div>
      </div>
      <div className="flex flex-col justify-center rounded-xl border border-white/15 bg-white/[0.07] p-3 backdrop-blur-sm sm:p-4">
        <div className="flex items-center justify-between gap-2 text-[9px] font-semibold text-white/65 sm:text-[10px]">
          <span>测试集 R²</span>
          <span>越高越好</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:mt-4 sm:gap-3">
          <MetricNumber label="线性" value="0.714" />
          <MetricNumber label="GBM" value="0.904" accent />
        </div>
        <div className="mt-2.5 flex items-center gap-1.5 text-[9px] font-medium text-emerald-200 sm:mt-3 sm:text-[10px]">
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
      <div className="flex items-center justify-between text-[9px] text-white/75 sm:text-[10px]">
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
      <p className="text-[8px] text-white/55 sm:text-[9px]">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-[15px] font-bold sm:text-[19px]',
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
      <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2 text-[8px] text-white/45 sm:text-[9px]">
        <span className="size-1.5 rounded-full bg-rose-400" />
        <span className="size-1.5 rounded-full bg-amber-300" />
        <span className="size-1.5 rounded-full bg-emerald-400" />
        <span className="ml-1">astropy/modeling/separable.py</span>
      </div>
      <div className="flex h-[calc(100%-29px)] flex-col justify-center px-3 py-2.5 text-[9px] leading-4 sm:h-[calc(100%-33px)] sm:px-4 sm:py-3 sm:text-[11px] sm:leading-5">
        <p className="truncate text-white/45">cright[-right.shape[0]:, -right.shape[1]:]</p>
        <p className="mt-0.5 rounded bg-rose-400/10 px-1.5 text-rose-200">− = 1</p>
        <p className="mt-1 rounded bg-emerald-400/10 px-1.5 text-emerald-200">+ = right</p>
        <div className="mt-2 flex gap-2 font-sans text-[8px] font-semibold sm:text-[10px]">
          <span className="rounded-full bg-rose-400/15 px-2 py-1 text-rose-200">基线 2 failed</span>
          <span className="rounded-full bg-emerald-400/15 px-2 py-1 text-emerald-200">
            修复后 13 passed
          </span>
        </div>
      </div>
    </div>
  )
}
