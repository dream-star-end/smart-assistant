/**
 * 「落地页 / 登录 / 法务 / 桌面端登记」场景集（2026-09 A·landing 审计新增）。
 *
 * 这一组此前没有任何 ui-preview 场景。全部是整页组件（无 Radix Dialog），shoot.mjs 走整页截图；
 * Landing 根节点是 `h-full overflow-y-auto` 的内滚容器，整页截图会被裁到一屏 —— 用 <FullPage>
 * 把它放开成随内容生长，才能把 7 个分区一次拍全。
 *
 * AuthGate 五个模式（登录 / 注册 / 验证 / 找回 / 重置）与三个门禁态（配置未就绪 / Turnstile
 * 加载失败 / bypass）都由 props 直接进入，不依赖网络；协议弹窗与桌面登记的确认 / 失败靠
 * <AutoClick> 点到。
 */
import { type ReactNode, useEffect } from 'react'

import { AuthGate } from '../../src/components/AuthGate'
import { DesktopEnrollPage, enrollNavigation } from '../../src/components/DesktopEnrollPage'
import { Landing } from '../../src/components/Landing'
import { LegalPage } from '../../src/components/LegalPage'
import { createMemoryAuthSession } from '../../src/lib/authSession'
import { ApiError } from './api-stub'
import type { ApiMockTable, Scene } from './types'

const auth = createMemoryAuthSession(() => {}, 'preview-token')

const ok =
  <T,>(value: T) =>
  () =>
    Promise.resolve(value)

const fail = (status: number, message: string, code?: string) => () =>
  Promise.reject(new ApiError({ status, message, code, requestId: 'req_audit_landing_01' }))

/** 挂载后按顺序模拟点击（selector 或按钮 / 链接文案子串）。 */
type ClickStep = { selector?: string; text?: string; delay?: number }

function findClickTarget(step: ClickStep): HTMLElement | null {
  if (step.selector) return document.querySelector<HTMLElement>(step.selector)
  if (step.text) {
    const candidates = [...document.querySelectorAll<HTMLElement>('button,a,[role="tab"],label')]
    return (
      candidates.find((el) => el.textContent?.trim() === step.text) ??
      candidates.find((el) => el.textContent?.includes(step.text ?? '')) ??
      null
    )
  }
  return null
}

function AutoClick({ steps, children }: { steps: ClickStep[]; children: ReactNode }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: 步骤表是场景常量，只在挂载时跑一次
  useEffect(() => {
    let cancelled = false
    const timers: number[] = []
    let at = 0
    for (const step of steps) {
      at += step.delay ?? 220
      const scheduled = at
      const poll = (round: number) => {
        if (cancelled) return
        const target = findClickTarget(step)
        if (target) {
          target.click()
          return
        }
        if (round < 60) timers.push(window.setTimeout(() => poll(round + 1), 50))
        else console.warn('[audit-scene] 点击目标未找到', step)
      }
      timers.push(window.setTimeout(() => poll(0), scheduled))
    }
    return () => {
      cancelled = true
      for (const t of timers) window.clearTimeout(t)
    }
  }, [])
  return <>{children}</>
}

/**
 * 落地页根节点是 `h-full overflow-y-auto` 的内滚容器（styles.css 又把 html/body/#root 钉在
 * 100dvh + overflow:hidden），整页截图只能拍到第一屏。分区场景改为挂载后把目标锚点滚进
 * 视口 —— 顺带还原了用户点顶部导航后看到的真实位置（含 sticky 头部的遮挡）。
 */
function ScrollTo({ selector, children }: { selector: string; children: ReactNode }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: 选择器是场景常量，只在挂载时跑一次
  useEffect(() => {
    let cancelled = false
    const timers: number[] = []
    const poll = (round: number) => {
      if (cancelled) return
      const target = document.querySelector<HTMLElement>(selector)
      if (target) {
        target.scrollIntoView({ block: 'start' })
        return
      }
      if (round < 60) timers.push(window.setTimeout(() => poll(round + 1), 50))
    }
    timers.push(window.setTimeout(() => poll(0), 300))
    return () => {
      cancelled = true
      for (const t of timers) window.clearTimeout(t)
    }
  }, [])
  return <>{children}</>
}

function Home() {
  return (
    <Landing onStart={noop} onLogin={noop} onCreateOrg={noop} theme="system" onCycleTheme={noop} />
  )
}

/** 落地页各分区（顶部导航锚点 + 未进导航的三个分区）。 */
const LANDING_SECTIONS: { id: string; label: string; selector: string }[] = [
  { id: 'demo', label: '产品演示（#demo）', selector: '#demo' },
  { id: 'tutorials', label: '快速上手 / 开口第一句（#tutorials）', selector: '#tutorials' },
  { id: 'workflow', label: '工作方式（四步）', selector: 'main > section:nth-of-type(2)' },
  { id: 'capabilities', label: '核心能力（#capabilities）', selector: '#capabilities' },
  { id: 'scenarios', label: '工作场景（#scenarios）', selector: '#scenarios' },
  { id: 'agents', label: '智能体与技能（#agents）', selector: '#agents' },
  { id: 'enterprise', label: '团队与企业（#enterprise）', selector: '#enterprise' },
  { id: 'faq', label: '常见问题（#faq）', selector: '#faq' },
  { id: 'footer', label: '末屏 CTA + 页脚', selector: 'footer' },
]

/**
 * 桌面端登记页从 location.search 读 enrollment_id / public_name：渲染前先写 URL。
 * 确认成功会 `location.assign('openclaude://…')` 跳深链 —— 预览台里把它钉成空操作，页面不会被导航走。
 */
function WithSearch({ search, children }: { search: string; children: ReactNode }) {
  try {
    history.replaceState({}, '', `${location.pathname}${search}`)
  } catch {}
  enrollNavigation.assign = () => {}
  return <>{children}</>
}

const noop = () => {}

const authBase = {
  onLogin: noop,
  onRegister: async () => ({ verifyEmailSent: true }),
  onVerifyEmail: async () => {},
  onResendVerification: async () => ({ emailSent: true }),
  onRequestReset: async () => {},
  onConfirmReset: async () => {},
  onBack: noop,
  onCycleTheme: noop,
  onRetryPublicConfig: noop,
} as const

function Gate(
  props: Partial<Parameters<typeof AuthGate>[0]> & { theme?: 'light' | 'dark' | 'system' },
) {
  return <AuthGate {...authBase} theme="system" turnstileBypass {...props} />
}

const ENROLL_ID = '5d3f2b1a-7c8e-4d9f-9a1b-2c3d4e5f6a7b'

const landingApi: ApiMockTable = {
  listOrgPlansPublic: ok([]),
}

// ── 场景 ────────────────────────────────────────────────────────────────────

export const landingScenes: Scene[] = [
  // ── 落地页 ──
  {
    id: 'landing-home',
    label: '落地页 · 首屏（头部导航 / Hero / 双 CTA / 演示窗口顶部）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: landingApi,
    render: () => <Home />,
  },
  ...LANDING_SECTIONS.map(
    (section): Scene => ({
      id: `landing-section-${section.id}`,
      label: `落地页 · ${section.label}`,
      group: '工作区',
      viewports: ['desktop', 'mobile'],
      api: landingApi,
      render: () => (
        <ScrollTo selector={section.selector}>
          <Home />
        </ScrollTo>
      ),
    }),
  ),
  {
    id: 'landing-faq-open',
    label: '落地页 · FAQ 展开一条',
    group: '工作区',
    api: landingApi,
    render: () => (
      <ScrollTo selector="#faq">
        <AutoClick steps={[{ selector: '#faq details:first-of-type summary', delay: 600 }]}>
          <Home />
        </AutoClick>
      </ScrollTo>
    ),
  },

  // ── 登录 / 注册 / 验证 / 找回 / 重置 ──
  {
    id: 'auth-login',
    label: '登录 · 默认（bypass 人机验证，可注册）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <Gate />,
  },
  {
    id: 'auth-login-error',
    label: '登录 · 凭据错误 + 可恢复登录态（错误框 / 重试按钮）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <Gate error="邮箱或密码错误，请重试。" onRetrySession={noop} />,
  },
  {
    id: 'auth-login-config-pending',
    label: '登录 · 公开配置未就绪（「正在准备登录…」门禁）',
    group: '工作区',
    api: {},
    render: () => <Gate turnstileBypass={undefined} />,
  },
  {
    id: 'auth-login-turnstile-fail',
    label: '登录 · Turnstile 需要但 site key 缺失（验证加载失败 + 重试）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <Gate turnstileBypass={false} turnstileSiteKey="" />,
  },
  {
    id: 'auth-login-loading',
    label: '登录 · 提交中',
    group: '工作区',
    api: {},
    render: () => <Gate loading />,
  },
  {
    id: 'auth-register',
    label: '注册 · 四字段 + 协议勾选',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <Gate initialMode="register" />,
  },
  {
    id: 'auth-register-closed',
    label: '注册 · 配置关闭注册后回落登录（提示条）',
    group: '工作区',
    api: {},
    render: () => <Gate initialMode="register" allowRegistration={false} />,
  },
  {
    id: 'auth-verify',
    label: '验证邮箱 · 6 位验证码输入',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <Gate initialMode="verify" />,
  },
  {
    id: 'auth-forgot',
    label: '找回密码 · 输入邮箱',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <Gate initialMode="forgot" />,
  },
  {
    id: 'auth-reset',
    label: '设置新密码 · 携带重置 token',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <Gate initialMode="reset" resetToken="tok_preview" />,
  },
  {
    id: 'auth-reset-invalid',
    label: '设置新密码 · 链接缺少 token',
    group: '工作区',
    api: {},
    render: () => <Gate initialMode="reset" />,
  },
  {
    id: 'auth-legal-modal',
    label: '登录 · 点《用户协议》就地弹窗',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <AutoClick steps={[{ text: '《用户协议》', delay: 400 }]}>
        <Gate />
      </AutoClick>
    ),
  },

  // ── 法务静态页 ──
  {
    id: 'legal-terms',
    label: '用户协议 · 整页',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <LegalPage kind="terms" />,
  },
  {
    id: 'legal-privacy',
    label: '隐私政策 · 整页',
    group: '工作区',
    api: {},
    render: () => <LegalPage kind="privacy" />,
  },

  // ── 桌面端登记 ──
  {
    id: 'desktop-enroll',
    label: '桌面端登记 · 确认这台电脑（带计算机名）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <WithSearch search={`?enrollment_id=${ENROLL_ID}&public_name=MacBook%20Pro%20(momo)`}>
        <DesktopEnrollPage auth={auth} />
      </WithSearch>
    ),
  },
  {
    id: 'desktop-enroll-invalid',
    label: '桌面端登记 · 链接无效',
    group: '工作区',
    api: {},
    render: () => (
      <WithSearch search="">
        <DesktopEnrollPage auth={auth} />
      </WithSearch>
    ),
  },
  {
    id: 'desktop-enroll-device-limit',
    label: '桌面端登记 · 确认失败（已有一台电脑处于本地模式）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {
      confirmDesktopEnroll: fail(409, 'device limit reached', 'DEVICE_LIMIT'),
    },
    render: () => (
      <WithSearch search={`?enrollment_id=${ENROLL_ID}`}>
        <AutoClick steps={[{ text: '确认这台电脑', delay: 400 }]}>
          <DesktopEnrollPage auth={auth} />
        </AutoClick>
      </WithSearch>
    ),
  },
  {
    id: 'desktop-enroll-returning',
    label: '桌面端登记 · 确认成功，正在返回应用',
    group: '工作区',
    api: {
      confirmDesktopEnroll: ok({ deepLink: 'openclaude://enroll/callback?code=preview' }),
    },
    render: () => (
      <WithSearch search={`?enrollment_id=${ENROLL_ID}`}>
        <AutoClick steps={[{ text: '确认这台电脑', delay: 400 }]}>
          <DesktopEnrollPage auth={auth} />
        </AutoClick>
      </WithSearch>
    ),
  },
]
