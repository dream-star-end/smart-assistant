/**
 * shell（应用壳层与设计系统）审计场景。
 *
 * 阶段 A 用它取证：把 App.tsx 里散落在条件分支深处、真机上难以同时凑齐的壳层界面
 * （横幅栈 / 空态 / chunk 兜底 / 原语总览 / 营销主题 token）摆到一张静态页上，
 * 让 desktop/mobile × light/dark 四张图直接充当问题清单的证据。
 * 阶段 B 用同一组场景出 after 图与 before 对照（S-03 / S-04 / S-06 / S-09 / S-13 / S-14）。
 *
 * 全部渲染真实组件，数据是就地写死的桩。
 */
import { RefreshCw, Trash2, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { ChunkErrorBoundary } from '../../src/components/ChunkErrorBoundary'
import { EmptyState } from '../../src/components/EmptyState'
import { ErrorBanner } from '../../src/components/ErrorBanner'
import { ThemeToggle } from '../../src/components/ThemeToggle'
import {
  Alert,
  Badge,
  Button,
  Chip,
  IconButton,
  Input,
  Progress,
  Select,
  Skeleton,
  Spinner,
  Switch,
  Textarea,
} from '../../src/components/ui'
import type { Agent } from '../../src/lib/agents'
import { type BannerKind, collapsedBannersLabel, resolveBanners } from '../../src/lib/bannerStack'
import type { Scene } from './types'

const AGENT: Agent = {
  id: 'main',
  name: '全能助手',
  description: '通晓百科的贴心助理，写邮件、做规划、查资料、出主意，样样在行。',
  starters: [
    '帮我规划一次 5 天的云南旅行',
    '把这段话改得更礼貌专业',
    '用通俗的话解释什么是量子纠缠',
    '帮我把这份周报压缩成三条要点',
  ],
  isDefault: true,
  installed: true,
  ready: true,
}

/**
 * 输入框上方的全局横幅栈。阶段 A 时 App.tsx 把 dormant / TurnCostReminder / 连接状态 /
 * UpdateBanner / ErrorBanner 依次挂在同一个 `composer-safe-b` 容器里，彼此没有互斥也没有
 * 条数上限（before 图 390×844 下横幅吃掉 ~560px）。阶段 B（S-06）起由 `resolveBanners`
 * 统一裁决：按优先级排序、同屏最多 2 条、其余折叠成一行「还有 N 条提示」。
 * 这一屏用同一个纯函数重放"四条同时成立"的情形；UpdateBanner 走 appUpdate 单例，
 * 这里用同构的 Alert 复刻它阶段 B 后的视觉（动作进 action 槽、全角标点）。
 */
function GlobalBanners() {
  const active: BannerKind[] = ['dormant', 'connection', 'update', 'error']
  const { visible, hidden } = resolveBanners(active)
  const show = (k: BannerKind) => visible.includes(k)
  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-meta text-faint">
        对话区（横幅每多一条就少一条消息的可视高度）
      </div>
      <div className="shrink-0 composer-safe-b">
        {show('error') && (
          <ErrorBanner
            error={{
              message: '模型返回超时（上游 504），本轮未产生计费。',
              requestId: 'req_8f21c0b4d7e94a13',
              retryText: '帮我把这份周报压缩成三条要点',
            }}
            onRetry={() => {}}
            onDismiss={() => {}}
            onSwitchModel={() => {}}
          />
        )}
        {show('connection') && (
          <div className="mx-auto mb-2 max-w-3xl px-4">
            <Alert
              tone="warning"
              action={
                <Button size="sm" variant="secondary">
                  立即重连
                </Button>
              }
            >
              与服务端的连接已断开，正在重连…
            </Alert>
          </div>
        )}
        {show('dormant') && (
          <div className="mx-auto mb-2 max-w-3xl px-4">
            <Alert tone="info">容器已休眠，发送消息后将自动唤醒。</Alert>
          </div>
        )}
        {show('update') && (
          <div className="mx-auto mb-2 max-w-3xl px-4">
            <Alert
              tone="info"
              icon={<RefreshCw size={16} />}
              action={
                <>
                  <Button size="sm" variant="ghost">
                    稍后
                  </Button>
                  <Button size="sm" variant="link">
                    立即刷新
                  </Button>
                </>
              }
            >
              新版本已就绪，刷新页面即可更新。
            </Alert>
          </div>
        )}
        {hidden.length > 0 && (
          <div className="mx-auto mb-2 max-w-3xl px-4">
            <Alert
              tone="info"
              density="compact"
              live="off"
              action={
                <Button size="sm" variant="ghost" aria-expanded={false}>
                  展开
                </Button>
              }
            >
              {collapsedBannersLabel(hidden.length)}
            </Alert>
          </div>
        )}
        <div className="mx-auto max-w-3xl px-4 pb-3">
          <div className="flex items-end gap-2 rounded-xl2 border border-border-control bg-surface p-3">
            <span className="min-h-[24px] flex-1 text-sm text-faint">和「全能助手」对话…</span>
            <Button size="sm" shape="pill">
              发送
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 触发一次真实的 chunk 加载失败，让 ChunkErrorBoundary 画出它的兜底屏。 */
function Boom({ message }: { message: string }): never {
  throw new Error(message)
}

function ChunkFallback({ message }: { message: string }) {
  return (
    <div className="h-full bg-bg">
      <ChunkErrorBoundary>
        <Boom message={message} />
      </ChunkErrorBoundary>
    </div>
  )
}

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-caption font-semibold uppercase tracking-wide text-faint">{title}</h2>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </section>
  )
}

/**
 * 设计系统原语总览。一屏看齐 Button / IconButton / Badge / Chip / Alert / 表单控件 /
 * Progress / Skeleton / Spinner 在明暗两个主题下的实际呈现，用于核对 §5 清单里的
 * 「色彩与对比度」「暗色主题」「触控目标 ≥44px」三项。
 */
function UiKit() {
  return (
    <div className="min-h-full bg-bg px-6 py-8 text-fg">
      <div className="mx-auto flex max-w-4xl flex-col gap-7">
        <header className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-title font-semibold">设计系统原语 · shell 审计</h1>
            <p className="mt-1 text-meta text-muted">
              真组件 + 真 production CSS；四张图对应 desktop/mobile × light/dark。
            </p>
          </div>
          <ThemeToggle theme="light" onCycle={() => {}} />
        </header>

        <Row title="Button · variant">
          <Button variant="primary">主操作</Button>
          <Button variant="accent">强调</Button>
          <Button variant="secondary">次级</Button>
          <Button variant="ghost">幽灵</Button>
          <Button variant="subtle">浅填充</Button>
          <Button variant="danger">删除</Button>
          <Button variant="link">文字链接</Button>
          <Button variant="gradient">营销 CTA</Button>
        </Row>

        <Row title="Button · size / 状态">
          <Button size="sm">小</Button>
          <Button size="md">中</Button>
          <Button size="lg">大</Button>
          <Button loading>提交中</Button>
          <Button disabled>不可用</Button>
          <Button shape="pill" variant="accent">
            药丸
          </Button>
        </Row>

        <Row title="IconButton · variant（触屏下应升到 44px）">
          <IconButton aria-label="ghost">
            <X size={16} />
          </IconButton>
          <IconButton aria-label="muted" variant="muted">
            <X size={16} />
          </IconButton>
          <IconButton aria-label="solid" variant="solid">
            <X size={16} />
          </IconButton>
          <IconButton aria-label="accent" variant="accent">
            <X size={16} />
          </IconButton>
          <IconButton aria-label="danger" variant="danger">
            <Trash2 size={16} />
          </IconButton>
          <IconButton aria-label="square" shape="square" variant="subtle">
            <X size={16} />
          </IconButton>
        </Row>

        <Row title="Badge / Chip">
          <Badge>默认</Badge>
          <Badge tone="accent">accent</Badge>
          <Badge tone="success">success</Badge>
          <Badge tone="warning">warning</Badge>
          <Badge tone="danger">danger</Badge>
          <Badge tone="info">info</Badge>
          <Chip>普通 chip</Chip>
          <Chip selected>选中 chip</Chip>
        </Row>

        <section className="flex flex-col gap-2">
          <h2 className="text-caption font-semibold uppercase tracking-wide text-faint">
            Alert · tone × density
          </h2>
          <Alert tone="info" title="信息">
            info / comfortable
          </Alert>
          <Alert tone="success" density="compact">
            success / compact
          </Alert>
          <Alert tone="warning" density="compact">
            warning / compact
          </Alert>
          <Alert
            tone="danger"
            title="失败"
            requestId="req_8f21c0b4d7e94a13"
            action={
              <Button size="sm" variant="secondary">
                重试
              </Button>
            }
            onDismiss={() => {}}
          >
            danger / 带动作与请求 ID
          </Alert>
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          <Input placeholder="Input · 占位文案" />
          <Select
            value="a"
            onValueChange={() => {}}
            options={[
              { value: 'a', label: 'Select · 选项 A' },
              { value: 'b', label: '选项 B' },
            ]}
          />
          <Textarea placeholder="Textarea · 占位文案" rows={2} />
          <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3.5 py-2">
            <Switch aria-label="开关 · 开" checked onCheckedChange={() => {}} />
            <span className="text-meta text-muted">Switch · 开</span>
            <Switch aria-label="开关 · 关" checked={false} onCheckedChange={() => {}} />
            <span className="text-meta text-muted">关</span>
          </div>
        </section>

        <Row title="Progress / Skeleton / Spinner">
          <div className="w-48">
            <Progress value={62} />
          </div>
          <Skeleton className="h-8 w-40" />
          <Spinner size={22} />
        </Row>

        <Row title="排版语义档位">
          <span className="text-title">title 15px</span>
          <span className="text-section">section 13.5px</span>
          <span className="text-body">body 13px</span>
          <span className="text-meta">meta 12px</span>
          <span className="text-caption">caption 11px</span>
          <span className="text-micro">micro 10px</span>
        </Row>

        <Row title="语义前景色（应全部 ≥4.5:1）">
          <span className="text-fg">fg</span>
          <span className="text-muted">muted</span>
          <span className="text-faint">faint 承载全站说明文案</span>
          <span className="text-accent">accent</span>
          <span className="text-danger">danger</span>
          <span className="text-success">success</span>
          <span className="text-warning">warning</span>
          <span className="text-info">info</span>
        </Row>
      </div>
    </div>
  )
}

/**
 * 营销主题（`.congjian-landing`）的语义色对照。阶段 A 时该块把 20 个 token 就地重定义了
 * 一遍，但 `--danger` / `--danger-soft`（含编译后的 `--color-danger*`）没有覆盖 —— 容器内的
 * 错误态会拿 `:root` 的浅色主题红去压近黑底（before 图里 danger 行与 success/warning/info
 * 明显不是同一套亮度）。阶段 B（S-04 / S-05）补上了 danger 三件套并把该块纳入
 * designTokens.test.ts 的对比度守卫；after 图里四行应在同一亮度带。
 */
function LandingTokens() {
  // 类名必须字面量书写:Tailwind 扫不到运行时拼接出来的 `"text-" + tone`。
  const tones = [
    { tone: 'info', text: 'text-info' },
    { tone: 'success', text: 'text-success' },
    { tone: 'warning', text: 'text-warning' },
    { tone: 'danger', text: 'text-danger' },
  ] as const
  return (
    <div className="congjian-landing min-h-full px-6 py-10">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <div>
          <h1 className="text-[22px] font-semibold text-fg">营销主题语义色对照</h1>
          <p className="mt-1 text-meta text-muted">
            `.congjian-landing` 的 info / success / warning / danger 四档应在同一亮度带。
          </p>
        </div>
        {tones.map(({ tone, text }) => (
          <div key={tone} className="flex flex-col gap-2">
            <Alert tone={tone} title={`Alert tone=${tone}`}>
              这一行的前景/底色来自哪套主题，肉眼即可分辨。
            </Alert>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={tone}>{`Badge ${tone}`}</Badge>
              <span className={text}>{text}</span>
            </div>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="danger">danger 按钮</Button>
          <Button variant="primary">primary 按钮</Button>
          <Input placeholder="控件边界 border-control" />
        </div>
      </div>
    </div>
  )
}

export const shellScenes: Scene[] = [
  {
    id: 'shell-global-banners',
    label: '壳层 · 输入框上方的全局横幅栈',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <GlobalBanners />,
  },
  {
    id: 'shell-empty-state',
    label: '壳层 · 空会话欢迎页',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <div className="h-full overflow-y-auto bg-bg text-fg">
        <EmptyState
          agent={AGENT}
          onPrefill={() => {}}
          onChangeAgent={() => {}}
          onOpenGoal={() => {}}
        />
      </div>
    ),
  },
  {
    id: 'shell-chunk-error-stale',
    label: '壳层 · 懒块失效兜底（发新版）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <ChunkFallback message="Failed to fetch dynamically imported module: /assets/ManageCenter-8f21c0.js" />
    ),
  },
  {
    id: 'shell-chunk-error-generic',
    label: '壳层 · 懒块失效兜底（通用渲染错误）',
    group: '工作区',
    viewports: ['desktop'],
    api: {},
    render: () => <ChunkFallback message="Cannot read properties of undefined (reading 'map')" />,
  },
  {
    id: 'shell-ui-kit',
    label: '壳层 · 设计系统原语总览',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <UiKit />,
  },
  {
    id: 'shell-landing-tokens',
    label: '壳层 · 营销主题语义色四档对照',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <LandingTokens />,
  },
]
