import { ArrowRight, Brain, Check, Plus, Puzzle, Shield, Sparkles } from "lucide-react";
import type { Theme } from "../hooks/useTheme";
import { AGENTS } from "../lib/agents";
import { AgentAvatar } from "./AgentAvatar";
import { BRAND } from "../lib/brand";
import { PLANS, TOPUP_PACK } from "../lib/plans";
import { cn } from "../lib/utils";
import { DemoShowcase } from "./landing/DemoShowcase";
import { Tutorials } from "./landing/Tutorials";
import { ThemeToggle } from "./ThemeToggle";
import { Button, buttonVariants } from "./ui";

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-9 items-center justify-center rounded-xl bg-grad-cta text-white shadow-sm">
        <Sparkles size={18} />
      </span>
      <span className="text-[19px] font-semibold tracking-tight">{BRAND.name}</span>
    </div>
  );
}

/** 叙事三支柱：开箱即用 / 越用越好用 / 越用越懂你。 */
const PILLARS = [
  {
    icon: Sparkles,
    t: "开箱即用",
    d: "全能助手即开即用 —— 不用挑模型、不用调 prompt，张口就问。写作、编程、研究、分析，第一句话就能用。",
  },
  {
    icon: Puzzle,
    t: "越用越好用",
    d: "需要更专业时，从 AI 市场一键加装技能与专家智能体。能力随你的需求生长，用得越久，越趁手。",
  },
  {
    icon: Brain,
    t: "越用越懂你",
    d: "长期记住你的身份、偏好与项目背景，下次对话自动带上下文。不必重复交代，它越来越懂你。",
  },
];

export function Landing({
  onStart,
  onLogin,
  theme,
  onCycleTheme,
}: {
  onStart: () => void;
  onLogin: () => void;
  theme: Theme;
  onCycleTheme: () => void;
}) {
  return (
    <div className="h-full overflow-y-auto bg-bg text-fg">
      {/* Nav */}
      <header className="landing-safe-t sticky top-0 z-30 border-b border-border/60 bg-bg/80 backdrop-blur-xl">
        {/* 窄屏(华为折叠外屏 / 320 小屏)收紧内边距,避免 nav 溢出 8px。 */}
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-5">
          <Logo />
          <nav className="hidden items-center gap-7 text-[14.5px] text-muted md:flex">
            <a href="#demo" className="transition-colors hover:text-fg">演示</a>
            <a href="#agents" className="transition-colors hover:text-fg">智能体</a>
            <a href="#tutorials" className="transition-colors hover:text-fg">教程</a>
            <a href="#pricing" className="transition-colors hover:text-fg">定价</a>
          </nav>
          <div className="flex shrink-0 items-center gap-1.5">
            <ThemeToggle theme={theme} onCycle={onCycleTheme} />
            <Button variant="ghost" shape="pill" onClick={onLogin} className="text-muted">
              登录
            </Button>
            <Button variant="primary" shape="pill" onClick={onStart}>
              免费开始
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(50% 40% at 50% 0%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 70%)",
          }}
        />
        <div className="relative mx-auto max-w-4xl px-5 pb-10 pt-20 text-center md:pt-28">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3.5 py-1.5 text-[13px] text-muted shadow-sm animate-in">
            <span className="size-1.5 rounded-full bg-accent" />
            {BRAND.company} · 可成长的 AI 助手
          </div>
          <h1 className="mx-auto max-w-3xl text-balance text-[40px] font-bold leading-[1.1] tracking-tight md:text-[60px] animate-in">
            开箱即用的 AI 助手
            <br className="hidden sm:block" />
            <span className="bg-gradient-to-r from-accent to-info bg-clip-text text-transparent">
              越用越好用，越用越懂你
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-[17px] leading-relaxed text-muted animate-in">
            上传文件、联网调研、跑代码、做分析 —— 把复杂的活交给它，交回看板、报告、PPT、代码等能直接用的成果。需要更专业时从 AI 市场一键加装能力，它还记得你的偏好。
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row animate-in">
            <Button variant="primary" shape="pill" size="lg" onClick={onStart} className="group shadow-float">
              免费开始使用
              <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5" />
            </Button>
            <a
              href="#demo"
              className={cn(buttonVariants({ variant: "secondary", shape: "pill", size: "lg" }))}
            >
              看看它能做什么
            </a>
          </div>
          <p className="mt-5 text-[13px] text-faint">免费版每月 300 积分 · 无需信用卡</p>
        </div>

        {/* 动态演示 —— 让人看到就想用 */}
        <div id="demo" className="relative mx-auto max-w-3xl scroll-mt-20 px-5 pb-12">
          <DemoShowcase onTry={onStart} />
        </div>
      </section>

      {/* 三支柱叙事 */}
      <section id="features" className="border-y border-border bg-sidebar/50">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="mb-12 text-center">
            <h2 className="text-[32px] font-bold tracking-tight md:text-[40px]">一个助手，陪你一起变强</h2>
            <p className="mx-auto mt-3 max-w-xl text-[16px] text-muted">不是一次性的工具，而是越用越合手的伙伴。</p>
          </div>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            {PILLARS.map((f, i) => (
              <div
                key={f.t}
                className="rounded-2xl border border-border bg-surface p-7 animate-in"
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <span className="mb-5 flex size-12 items-center justify-center rounded-xl bg-accent-soft text-accent">
                  <f.icon size={23} />
                </span>
                <h3 className="text-[19px] font-semibold">{f.t}</h3>
                <p className="mt-2.5 text-[14.5px] leading-relaxed text-muted">{f.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Agents —— v5 纯市场:默认只配「全能助手」,其余是市场按需加装的示例(非预置 roster)。 */}
      <section id="agents" className="mx-auto max-w-6xl px-5 py-20">
        <div className="mb-12 text-center">
          <h2 className="text-[32px] font-bold tracking-tight md:text-[40px]">一个全能助手起步，市场按需生长</h2>
          <p className="mx-auto mt-3 max-w-2xl text-[16px] text-muted">
            默认只配「全能助手」—— 写作、编程、研究、分析张口就用。需要更专业时，从 AI 市场一键加装专家智能体与技能，能力随需求生长。
          </p>
        </div>

        {/* 默认配备:全能助手(唯一预置) */}
        <button
          onClick={onStart}
          className="group mb-10 flex w-full items-start gap-5 rounded-2xl border border-accent/40 bg-accent-soft p-6 text-left outline-none transition-[transform,box-shadow,border-color] duration-200 ease-standard hover:-translate-y-0.5 hover:shadow-float focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <AgentAvatar
            agent={AGENTS[0]}
            className="size-14 shrink-0 rounded-2xl shadow-sm"
            iconSize={26}
          />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-[19px] font-bold">{AGENTS[0].name}</span>
              <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-white">
                默认配备 · 即开即用
              </span>
            </span>
            <span className="mt-1.5 block text-[14.5px] leading-relaxed text-muted">
              {AGENTS[0].description}
            </span>
          </span>
          <ArrowRight
            size={20}
            className="mt-1 shrink-0 text-accent transition-transform group-hover:translate-x-0.5"
          />
        </button>

        {/* 市场:专业智能体(示例,陆续上新) —— 明确"从市场安装",不是预置 */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-muted">
            <Puzzle size={16} className="text-accent" />
            AI 市场 · 专业智能体（示例，陆续上新）
          </div>
          <button
            type="button"
            onClick={onStart}
            className="inline-flex items-center gap-1 text-[13.5px] font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            浏览 AI 市场 <ArrowRight size={14} />
          </button>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {AGENTS.slice(1).map((a) => (
            <button
              key={a.id}
              onClick={onStart}
              className="group relative flex flex-col items-start rounded-xl border border-border bg-surface p-5 text-left outline-none transition-[transform,box-shadow,border-color] duration-200 ease-standard hover:-translate-y-0.5 hover:border-border-strong hover:shadow-float focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full border border-border bg-hover px-2 py-0.5 text-[10.5px] font-medium text-muted">
                <Plus size={11} /> 市场安装
              </span>
              <AgentAvatar agent={a} className="mb-4 size-11 rounded-xl shadow-sm" iconSize={21} />
              <span className="text-[16.5px] font-semibold">{a.name}</span>
              <span className="mt-0.5 text-[13px] font-medium text-accent">{a.tagline}</span>
              <span className="mt-2 text-[14px] leading-relaxed text-muted">{a.description}</span>
            </button>
          ))}
        </div>
      </section>

      {/* Tutorials —— 每个功能配套使用示例 */}
      <Tutorials />

      {/* Pricing */}
      <section id="pricing" className="border-t border-border bg-sidebar/40">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="mb-12 text-center">
            <h2 className="text-[32px] font-bold tracking-tight md:text-[40px]">简单透明的包月套餐</h2>
            <p className="mx-auto mt-3 max-w-xl text-[16px] text-muted">
              每档配足月度积分，全能助手与市场内容随心用。可随时升档；用量不够再买加量包。
            </p>
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {PLANS.map((p) => (
              <div
                key={p.id}
                className={`relative flex flex-col rounded-2xl border bg-surface p-6 transition-all ${
                  p.highlight ? "border-accent shadow-[var(--shadow-float)] ring-1 ring-accent/30" : "border-border"
                }`}
              >
                {p.highlight && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-accent px-3 py-1 text-[12px] font-medium text-white">
                    最受欢迎
                  </span>
                )}
                <h3 className="text-[17px] font-semibold">{p.name}</h3>
                <p className="mt-1 text-[13px] text-faint">{p.tagline}</p>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="text-[36px] font-bold tracking-tight">¥{p.price}</span>
                  <span className="text-[14px] text-muted">/月</span>
                </div>
                <p className="mt-1 text-[13.5px] font-medium text-accent">每月 {p.credits.toLocaleString()} 积分</p>
                <Button
                  variant={p.highlight ? "primary" : "secondary"}
                  onClick={onStart}
                  className="mt-5 w-full rounded-xl"
                >
                  {p.cta}
                </Button>
                <ul className="mt-5 space-y-2.5">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-[13.5px] text-muted">
                      <Check size={16} className="mt-0.5 shrink-0 text-accent" />
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {/* 加量包 */}
          <div className="mt-6 flex flex-col items-center justify-between gap-4 rounded-2xl border border-dashed border-border-strong bg-surface px-6 py-5 sm:flex-row">
            <div className="flex items-center gap-3.5">
              <span className="flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
                <Plus size={22} />
              </span>
              <div>
                <h3 className="text-[16px] font-semibold">积分加量包</h3>
                <p className="mt-0.5 text-[13.5px] text-muted">
                  ¥{TOPUP_PACK.price} 加 {TOPUP_PACK.credits.toLocaleString()} 积分 · {TOPUP_PACK.note}
                </p>
              </div>
            </div>
            <Button variant="secondary" onClick={onStart} className="shrink-0 rounded-xl">
              用量不够，随时加量
            </Button>
          </div>
          <p className="mt-4 text-center text-[12.5px] text-faint">
            积分用于对话与各项能力调用，按实际消耗计费。加量包仅在当前套餐有效期内可用。
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-5 py-20">
        <div className="relative overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-accent/10 to-info/5 px-6 py-14 text-center">
          <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-2xl bg-grad-cta text-white shadow-float">
            <Shield size={24} />
          </div>
          <h2 className="text-[28px] font-bold tracking-tight md:text-[36px]">现在就开始，越用越懂你</h2>
          <p className="mx-auto mt-3 max-w-md text-[15.5px] text-muted">免费注册，从全能助手起步，按需从 AI 市场加装更多能力。</p>
          <Button variant="primary" shape="pill" size="lg" onClick={onStart} className="mt-7 shadow-float">
            免费开始使用
            <ArrowRight size={17} />
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border bg-sidebar/40">
        <div className="mx-auto max-w-6xl px-5 py-10">
          <div className="flex flex-col items-start justify-between gap-6 md:flex-row">
            <div>
              <Logo />
              <p className="mt-3 max-w-xs text-[13.5px] leading-relaxed text-muted">{BRAND.intro}</p>
            </div>
            <div className="flex gap-14 text-[13.5px]">
              <div className="flex flex-col gap-2.5">
                <span className="font-medium text-fg">产品</span>
                <a href="#demo" className="text-muted hover:text-fg">演示</a>
                <a href="#agents" className="text-muted hover:text-fg">智能体</a>
                <a href="#tutorials" className="text-muted hover:text-fg">教程</a>
                <a href="#pricing" className="text-muted hover:text-fg">定价</a>
              </div>
              <div className="flex flex-col gap-2.5">
                <span className="font-medium text-fg">关于</span>
                <span className="text-muted">{BRAND.companyShort}</span>
                <span className="text-muted">联系合作</span>
                <span className="text-muted">用户协议</span>
              </div>
            </div>
          </div>
          <div className="mt-9 flex flex-col gap-1.5 border-t border-border pt-6 text-[12.5px] text-faint">
            <span>© {BRAND.year} {BRAND.company} 版权所有</span>
            <span>{BRAND.icp} · 本站内容由 AI 生成，仅供参考</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
