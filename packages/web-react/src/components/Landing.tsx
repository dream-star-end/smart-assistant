import { ArrowRight, Check, Shield, Sparkles, Zap } from "lucide-react";
import type { Theme } from "../hooks/useTheme";
import { AGENTS } from "../lib/agents";
import { AgentAvatar } from "./AgentAvatar";
import { BRAND } from "../lib/brand";
import { ANNUAL_DISCOUNT, PLANS } from "../lib/plans";
import { cn } from "../lib/utils";
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
    <div className="min-h-screen bg-bg text-fg">
      {/* Nav */}
      <header className="landing-safe-t sticky top-0 z-30 border-b border-border/60 bg-bg/80 backdrop-blur-xl">
        {/* 窄屏(华为折叠外屏 / 320 小屏)收紧内边距,避免 nav 溢出 8px。 */}
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-5">
          <Logo />
          <nav className="hidden items-center gap-7 text-[14.5px] text-muted md:flex">
            <a href="#agents" className="transition-colors hover:text-fg">智能体</a>
            <a href="#features" className="transition-colors hover:text-fg">能力</a>
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
          <h1 className="mx-auto max-w-3xl text-balance text-[42px] font-bold leading-[1.08] tracking-tight md:text-[64px] animate-in">
            一个全能助手起步，
            <br className="hidden sm:block" />
            <span className="bg-gradient-to-r from-accent to-info bg-clip-text text-transparent">
              按需加装更多能力
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-[17px] leading-relaxed text-muted animate-in">
            {BRAND.name}默认配备一位全能助手 —— 写作、编程、研究、分析样样在行；需要更专业时，从 AI 市场一键安装技能与专家智能体，让它越用越强。
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row animate-in">
            <Button variant="primary" shape="pill" size="lg" onClick={onStart} className="group shadow-float">
              免费开始使用
              <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5" />
            </Button>
            <a
              href="#agents"
              className={cn(buttonVariants({ variant: "secondary", shape: "pill", size: "lg" }))}
            >
              逛逛 AI 市场
            </a>
          </div>
          <p className="mt-5 text-[13px] text-faint">「{BRAND.slogan}」</p>
        </div>

        {/* floating agent chips */}
        <div className="relative mx-auto mb-6 flex max-w-3xl flex-wrap justify-center gap-2.5 px-5">
          {AGENTS.slice(0, 7).map((a, i) => (
            <div
              key={a.id}
              className="flex items-center gap-2 rounded-full border border-border bg-surface px-3.5 py-2 text-[13.5px] shadow-sm animate-in"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <AgentAvatar agent={a} className="size-5 rounded-md" iconSize={12} />
              {a.name}
            </div>
          ))}
        </div>
      </section>

      {/* Agents */}
      <section id="agents" className="mx-auto max-w-6xl px-5 py-20">
        <div className="mb-12 text-center">
          <h2 className="text-[32px] font-bold tracking-tight md:text-[40px]">AI 市场，按需取用</h2>
          <p className="mx-auto mt-3 max-w-xl text-[16px] text-muted">全能助手之外，市场里还有更多专业智能体与技能 —— 写作、编程、研究、翻译……一键安装，随用随装。</p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {AGENTS.map((a) => (
            <button
              key={a.id}
              onClick={onStart}
              className="group flex flex-col items-start rounded-xl border border-border bg-surface p-5 text-left outline-none transition-[transform,box-shadow,border-color] duration-200 ease-standard hover:-translate-y-0.5 hover:border-border-strong hover:shadow-float focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              <AgentAvatar agent={a} className="mb-4 size-11 rounded-xl shadow-sm" iconSize={21} />
              <span className="text-[16.5px] font-semibold">{a.name}</span>
              <span className="mt-0.5 text-[13px] font-medium text-accent">{a.tagline}</span>
              <span className="mt-2 text-[14px] leading-relaxed text-muted">{a.description}</span>
            </button>
          ))}
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-y border-border bg-sidebar/50">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-8 px-5 py-20 md:grid-cols-3">
          {[
            { icon: Sparkles, t: "开箱即用 + 按需成长", d: "全能助手即开即用；需要更专业时，从 AI 市场加装技能与专家智能体，让它随你一起变强。" },
            { icon: Zap, t: "包月畅用，积分透明", d: "按月订阅，每档配足月度积分，用多少一目了然。无需为算力与模型操心。" },
            { icon: Shield, t: "隐私与安全", d: "对话数据加密存储、独立隔离。企业级稳定性，国内合规运营。" },
          ].map((f) => (
            <div key={f.t}>
              <span className="mb-4 flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
                <f.icon size={21} />
              </span>
              <h3 className="text-[18px] font-semibold">{f.t}</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="mx-auto max-w-6xl px-5 py-20">
        <div className="mb-12 text-center">
          <h2 className="text-[32px] font-bold tracking-tight md:text-[40px]">简单透明的包月订阅</h2>
          <p className="mx-auto mt-3 max-w-xl text-[16px] text-muted">
            每档配足月度积分，全能助手与市场内容随心用。年付立享 {Math.round((1 - ANNUAL_DISCOUNT) * 100)}% 折扣。
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
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-5 pb-20">
        <div className="relative overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-accent/10 to-info/5 px-6 py-14 text-center">
          <h2 className="text-[28px] font-bold tracking-tight md:text-[36px]">现在就开始</h2>
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
                <a href="#agents" className="text-muted hover:text-fg">智能体</a>
                <a href="#pricing" className="text-muted hover:text-fg">定价</a>
                <button onClick={onStart} className="text-left text-muted hover:text-fg">开始使用</button>
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
