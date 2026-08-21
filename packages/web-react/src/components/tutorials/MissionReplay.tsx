import {
  ArrowRight,
  Check,
  CheckCircle2,
  Code2,
  FileArchive,
  FileCode2,
  FileText,
  FlaskConical,
  FolderTree,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  TUTORIAL_CASE_BY_ID,
  type TutorialCase,
  type TutorialCaseId,
} from '../../lib/tutorialCaseCatalog'
import { cn } from '../../lib/utils'
import { Button } from '../ui'

type ReplayKind = 'research' | 'coding'

type ReplayStep = {
  label: string
  title: string
  evidence: string
  detail: React.ReactNode
}

type ArtifactPreview = {
  id: string
  label: string
  icon: typeof FileText
}

const REPLAY_CASES: Record<ReplayKind, TutorialCaseId> = {
  research: 'research-bike-demand',
  coding: 'coding-swe-bench-fix',
}

const RESEARCH_STEPS: readonly ReplayStep[] = [
  {
    label: '交付材料',
    title: '任务和原始数据已接收',
    evidence: 'UCI 原始 ZIP、数据字典和冻结的分析问题一起进入任务。',
    detail: '先锁定输入哈希，不改动原始文件，再开始分析。',
  },
  {
    label: '理解检查',
    title: '先检查数据，再决定怎么做',
    evidence: '确认 17,379 条小时记录、0 个缺失值，并识别 casual / registered 会泄漏目标。',
    detail: '把风险写进分析计划，避免得到一个看起来很高、实际上不可用的分数。',
  },
  {
    label: '运行分析',
    title: '基线和非线性模型正面对照',
    evidence: '同时训练线性基线与 GBM；测试集 R² 从 0.714 提升到 0.904。',
    detail: '数值、残差和分层结果都由脚本生成，不靠聊天里的口头总结。',
  },
  {
    label: '交叉验证',
    title: '在干净环境重新跑一遍',
    evidence: '34 项数据、泄漏、切分和复现检查通过；两次报告哈希一致。',
    detail: '既核对问题路径，也核对原有正常路径，结果可以被同事复查。',
  },
  {
    label: '拿走成果',
    title: '报告和可复跑工程一起交付',
    evidence: '交付 report.md、诊断图、机器可读指标和 reproducible-project.zip。',
    detail: '不是一段只能复制的答案，而是一套可以继续编辑、再次运行的工作成果。',
  },
] as const

const CODING_STEPS: readonly ReplayStep[] = [
  {
    label: '交付问题',
    title: '真实 Issue 和固定基线已接收',
    evidence: '锁定 Astropy #12906、Verified 实例和 base commit，在隔离 worktree 开始。',
    detail: '不读取 gold patch，也不在上游仓库直接修改。',
  },
  {
    label: '复现问题',
    title: '先让 Bug 稳定变红',
    evidence: '两个针对嵌套 CompoundModel 的回归检查在基线代码上稳定失败。',
    detail: '没有复现证据前不改代码，避免绕开症状却没修到根因。',
  },
  {
    label: '定位根因',
    title: '沿递归路径找到一行错误',
    evidence: '_cstack 把右侧已有矩阵整块覆盖成 1，嵌套结构因此丢失。',
    detail: '根因链落到具体函数和具体值，而不是泛泛猜测。',
  },
  {
    label: '修复验证',
    title: '只改根因，问题和正常路径一起测',
    evidence: '把常量 1 改为 right；新增回归与邻近测试合计 13 项通过。',
    detail: '产品代码只改 1 行，没有顺手重构或批量格式化。',
  },
  {
    label: '交付成果',
    title: '补丁、根因和测试证据一起交付',
    evidence: '形成 root-cause.md、测试结果和最小修复内容预览。',
    detail: '本案例未跑官方 SWE-bench harness，因此页面不会把它冒充为官方评测通过。',
  },
] as const

const ARTIFACTS: Record<ReplayKind, readonly ArtifactPreview[]> = {
  research: [
    { id: 'report', label: '预览 report.md', icon: FileText },
    { id: 'project', label: '预览可复跑工程', icon: FolderTree },
  ],
  coding: [
    { id: 'root-cause', label: '预览 root-cause.md', icon: FileText },
    { id: 'tests', label: '预览测试证据', icon: ShieldCheck },
    { id: 'patch', label: '预览修复内容', icon: FileCode2 },
  ],
}

export function MissionReplay({
  caseId,
  actionLabel,
  onCaseChange,
  onRunCase,
}: {
  caseId: TutorialCaseId | null
  actionLabel?: string
  onCaseChange: (id: TutorialCaseId) => void
  onRunCase?: (item: TutorialCase) => void
}) {
  const kind: ReplayKind = caseId === REPLAY_CASES.coding ? 'coding' : 'research'
  const item = TUTORIAL_CASE_BY_ID[REPLAY_CASES[kind]]
  const steps = kind === 'research' ? RESEARCH_STEPS : CODING_STEPS
  const artifacts = ARTIFACTS[kind]
  const [activeStep, setActiveStep] = useState(0)
  const [activeArtifact, setActiveArtifact] = useState(artifacts[0].id)

  useEffect(() => {
    setActiveStep(0)
    setActiveArtifact(artifacts[0].id)
  }, [artifacts])

  const report = item.fieldReport
  const active = steps[activeStep]
  const caseSource = report?.sourceLabel ?? item.sources[0]?.title
  const inputs = useMemo(
    () =>
      kind === 'research'
        ? [
            { name: 'Bike-Sharing-Dataset.zip', meta: '273 KB · 原始数据', icon: FileArchive },
            { name: 'analysis-question.md', meta: '134 B · 冻结问题', icon: FileText },
          ]
        : [
            { name: 'Verified 实例', meta: '204 B · 固定问题', icon: FileText },
            { name: 'Astropy 仓库基线', meta: '7.4 MB · 固定提交', icon: FileArchive },
          ],
    [kind],
  )

  return (
    <article className="mx-auto flex min-h-full w-full max-w-[1440px] flex-col px-3 pb-5 pt-4 sm:px-6 sm:pb-7 lg:px-8">
      <nav aria-label="任务阶段" className="mx-auto w-full max-w-3xl">
        <ol className="grid grid-cols-5 gap-1">
          {steps.map((step, index) => (
            <li key={step.label} className="relative min-w-0">
              {index > 0 && (
                <span
                  aria-hidden
                  className={cn(
                    'absolute left-[-50%] right-1/2 top-3 h-px',
                    index <= activeStep ? 'bg-accent' : 'bg-border-strong',
                  )}
                />
              )}
              <button
                type="button"
                aria-label={step.label}
                aria-current={index === activeStep ? 'step' : undefined}
                onClick={() => setActiveStep(index)}
                className="group relative flex w-full min-w-0 flex-col items-center gap-1.5 rounded-lg px-1 py-1 text-caption font-medium text-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span
                  className={cn(
                    'z-10 flex size-6 items-center justify-center rounded-full border bg-bg transition-colors',
                    index === activeStep
                      ? 'border-accent bg-accent text-accent-fg'
                      : index < activeStep
                        ? 'border-accent text-accent'
                        : 'border-border-strong text-faint group-hover:border-accent',
                  )}
                >
                  {index < activeStep ? <Check size={13} /> : index + 1}
                </span>
                <span className={cn('truncate', index === activeStep && 'text-accent')}>
                  {step.label}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <section className="mt-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-caption font-semibold text-accent">
              示意步骤 · 非真实轨迹 · {kind === 'research' ? '科研分析' : '代码修复'}
            </p>
            <h1 className="mt-2 max-w-4xl text-2xl font-bold tracking-tight text-fg sm:text-3xl">
              你不用守着它。回来时，过程和成果都还在。
            </h1>
            <p className="mt-2 max-w-3xl text-body text-muted sm:text-section">
              V5 会把网页、代码、数据和文件串成一个任务，并把每一步和最终成果留给你检查。
            </p>
          </div>
          <div className="flex items-center rounded-xl border border-border bg-surface p-1">
            <Button
              size="sm"
              variant={kind === 'research' ? 'subtle' : 'ghost'}
              aria-pressed={kind === 'research'}
              onClick={() => onCaseChange(REPLAY_CASES.research)}
            >
              <FlaskConical size={14} /> 科研
            </Button>
            <Button
              size="sm"
              variant={kind === 'coding' ? 'subtle' : 'ghost'}
              aria-pressed={kind === 'coding'}
              onClick={() => onCaseChange(REPLAY_CASES.coding)}
            >
              <Code2 size={14} /> 编码
            </Button>
          </div>
        </div>
      </section>

      <section className="mt-5 grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(380px,1fr)]">
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
            <div>
              <p className="text-caption text-faint">案例观察记录</p>
              <p className="text-section font-semibold text-fg">
                {report?.duration} · {caseSource}
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success-soft px-3 py-1.5 text-caption font-medium text-success">
              <RotateCcw size={13} /> 平台支持后台继续与断线恢复
            </span>
          </div>

          <ol className="divide-y divide-border px-3 sm:px-5">
            {steps.map((step, index) => (
              <li key={step.title}>
                <button
                  type="button"
                  onClick={() => setActiveStep(index)}
                  aria-expanded={index === activeStep}
                  className={cn(
                    'grid w-full grid-cols-[32px_minmax(0,1fr)] gap-3 rounded-xl px-2 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[42px_minmax(0,1fr)] sm:px-3',
                    index === activeStep ? 'bg-accent-soft' : 'hover:bg-hover',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex size-7 items-center justify-center rounded-full border text-caption font-semibold',
                      index === activeStep
                        ? 'border-accent bg-accent text-accent-fg'
                        : 'border-border-strong bg-bg text-muted',
                    )}
                  >
                    {index === steps.length - 1 ? <Check size={14} /> : index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <strong className="text-section text-fg">{step.title}</strong>
                      <span className="text-caption text-faint">{step.label}</span>
                    </span>
                    <span className="mt-1 block text-body text-muted">{step.evidence}</span>
                    {index === activeStep && (
                      <span className="mt-2 block text-meta text-fg">{step.detail}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <section className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
            <div className="flex items-center gap-2 text-section font-semibold text-fg">
              {kind === 'research' ? (
                <FlaskConical size={16} className="text-accent" />
              ) : (
                <Code2 size={16} className="text-accent" />
              )}
              你的目标
            </div>
            <p className="mt-2 text-body text-muted">{item.summary}</p>
            <p className="mt-3 text-caption font-semibold text-fg">输入材料</p>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {inputs.map(({ name, meta, icon: Icon }) => (
                <li
                  key={name}
                  className="flex min-w-0 items-center gap-2 rounded-xl bg-sidebar px-3 py-2.5"
                >
                  <Icon size={16} className="shrink-0 text-accent" />
                  <span className="min-w-0">
                    <span className="block truncate text-meta font-medium text-fg">{name}</span>
                    <span className="block text-caption text-faint">{meta}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="flex min-h-[360px] flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
            <div
              className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-sidebar px-2 pt-2"
              role="tablist"
              aria-label="成果预览"
            >
              {artifacts.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={activeArtifact === id}
                  onClick={() => setActiveArtifact(id)}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-t-lg border-x border-t px-3 py-2 text-meta font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    activeArtifact === id
                      ? 'border-border bg-surface text-accent'
                      : 'border-transparent text-muted hover:bg-hover hover:text-fg',
                  )}
                >
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-5" role="tabpanel">
              <ArtifactBody kind={kind} artifact={activeArtifact} item={item} />
            </div>
          </section>
        </div>
      </section>

      <footer className="sticky bottom-0 z-20 mt-4 flex flex-col gap-3 border-t border-border bg-bg/95 py-3 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-meta font-medium text-fg">当前阶段：{active.label}</p>
          <p className="mt-1 text-caption text-faint">
            以上为示意步骤，并非真实会话轨迹；后台继续、断线恢复和过程持久化是平台能力。
          </p>
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button
            variant="secondary"
            onClick={() =>
              onCaseChange(kind === 'research' ? REPLAY_CASES.coding : REPLAY_CASES.research)
            }
          >
            切换到{kind === 'research' ? '代码修复' : '科研分析'}
          </Button>
          {onRunCase && (
            <Button
              variant="accent"
              onClick={() => onRunCase(item)}
              aria-label={actionLabel ? `用我的材料开始，${actionLabel}` : '用我的材料开始'}
            >
              用我的材料开始 <ArrowRight size={15} />
            </Button>
          )}
        </div>
      </footer>
    </article>
  )
}

function ArtifactBody({
  kind,
  artifact,
  item,
}: {
  kind: ReplayKind
  artifact: string
  item: TutorialCase
}) {
  if (kind === 'research' && artifact === 'project') {
    return (
      <div>
        <p className="text-caption font-semibold uppercase tracking-[0.12em] text-accent">
          可复跑工程预览
        </p>
        <h2 className="mt-2 text-lg font-semibold text-fg">
          同事拿到后，可以从原始数据重新生成结果
        </h2>
        <pre className="mt-4 overflow-x-auto rounded-xl bg-[#111827] p-4 text-meta leading-6 text-slate-100">
          <code>{`reproducible-project/
├── Makefile
├── requirements.txt
├── src/
├── tests/               # 34 项验证
├── figures/
├── metrics.json
└── report.md

$ make reproduce`}</code>
        </pre>
        <p className="mt-3 text-meta text-muted">
          预览只展示交付结构；开始你自己的任务后，成果会进入真实文件区。
        </p>
      </div>
    )
  }

  if (kind === 'coding' && artifact === 'tests') {
    return (
      <div>
        <p className="text-caption font-semibold uppercase tracking-[0.12em] text-accent">
          测试证据预览
        </p>
        <h2 className="mt-2 text-lg font-semibold text-fg">
          不是“我觉得修好了”，而是同一问题先红后绿
        </h2>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-danger/25 bg-danger-soft p-3">
            <p className="text-caption font-semibold text-danger">修复前</p>
            <p className="mt-1 text-xl font-bold text-fg">2 项失败</p>
          </div>
          <div className="rounded-xl border border-success/25 bg-success-soft p-3">
            <p className="text-caption font-semibold text-success">修复后</p>
            <p className="mt-1 text-xl font-bold text-fg">13 项通过</p>
          </div>
        </div>
        <p className="mt-3 text-meta text-muted">
          边界：本案例没有运行官方 SWE-bench harness，因此不宣称官方评测通过。
        </p>
      </div>
    )
  }

  if (kind === 'coding' && artifact === 'patch') {
    return (
      <div>
        <p className="text-caption font-semibold uppercase tracking-[0.12em] text-accent">
          最小修复预览
        </p>
        <h2 className="mt-2 text-lg font-semibold text-fg">根因只需要改动一行产品代码</h2>
        <pre className="mt-4 overflow-x-auto rounded-xl bg-[#111827] p-4 text-meta leading-6 text-slate-100">
          <code>{`def _cstack(left, right):
    ...
-   matrix[..., -right.shape[0]:] = 1
+   matrix[..., -right.shape[0]:] = right`}</code>
        </pre>
        <p className="mt-3 text-meta text-muted">
          预览不冒充完整可下载 patch；真实任务会保留完整 git diff 和文件状态。
        </p>
      </div>
    )
  }

  if (kind === 'coding') {
    return (
      <div>
        <p className="text-caption font-semibold uppercase tracking-[0.12em] text-accent">
          根因报告预览
        </p>
        <h2 className="mt-2 text-lg font-semibold text-fg">Astropy 嵌套模型可分离矩阵错误</h2>
        <div className="mt-4 space-y-3 text-body text-muted">
          <p>
            <strong className="text-fg">现象：</strong>平铺表达式正常，只有右侧模型嵌套时结果错误。
          </p>
          <p>
            <strong className="text-fg">代码路径：</strong>
            <code className="rounded bg-hover px-1.5 py-0.5 text-fg">_separable → _cstack</code>
          </p>
          <p>
            <strong className="text-fg">根因：</strong>已有右侧矩阵被常量 1 覆盖，嵌套结构丢失。
          </p>
          <p>
            <strong className="text-fg">验证：</strong>新增回归与邻近测试合计 13 项通过。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div>
      <p className="text-caption font-semibold uppercase tracking-[0.12em] text-accent">
        分析报告预览
      </p>
      <h2 className="mt-2 text-lg font-semibold text-fg">天气与小时单车租赁量：可复现分析报告</h2>
      <p className="mt-2 text-body text-muted">
        先排除目标泄漏，再用时间顺序切分比较线性基线和非线性模型。
      </p>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {item.fieldReport?.metrics.map((metric) => (
          <div key={metric.label} className="rounded-xl bg-sidebar p-3">
            <strong className="block text-lg font-bold text-fg">{metric.value}</strong>
            <span className="mt-1 block text-caption text-muted">{metric.label}</span>
          </div>
        ))}
      </div>
      <div className="mt-4 overflow-hidden rounded-xl border border-border">
        <table className="w-full text-left text-meta">
          <caption className="sr-only">测试集模型对比</caption>
          <thead className="bg-sidebar text-faint">
            <tr>
              <th className="px-3 py-2 font-medium">模型</th>
              <th className="px-3 py-2 font-medium">R²</th>
              <th className="px-3 py-2 font-medium">RMSE</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border text-fg">
            <tr>
              <td className="px-3 py-2">线性基线</td>
              <td className="px-3 py-2">0.714</td>
              <td className="px-3 py-2">117.81</td>
            </tr>
            <tr>
              <td className="px-3 py-2 font-semibold">GBM</td>
              <td className="px-3 py-2 font-semibold text-accent">0.904</td>
              <td className="px-3 py-2 font-semibold text-accent">68.36</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-meta text-success">
        <CheckCircle2 size={14} /> 34 项自动化验证通过
      </p>
    </div>
  )
}
