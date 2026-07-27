import {
  ArrowRight,
  Building2,
  Check,
  Layers,
  Menu,
  MessageSquareText,
  Plus,
  Puzzle,
  ReceiptText,
  Shield,
  Sparkles,
  Users,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { Theme } from "../hooks/useTheme";
import { AGENTS } from "../lib/agents";
import { AgentAvatar } from "./AgentAvatar";
import { api } from "../lib/api";
import { BRAND } from "../lib/brand";
import { minSeatPriceYuan } from "../lib/orgBilling";
import { cn } from "../lib/utils";
import { DemoShowcase } from "./landing/DemoShowcase";
import { Tutorials } from "./landing/Tutorials";
import { ThemeToggle } from "./ThemeToggle";
import { Button, buttonVariants, IconButton } from "./ui";

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

/** 差异化对比：普通 AI 聊天给建议，Aurora 把活儿干完。左右两列逐行对照。 */
const COMPARE = {
  chat: {
    title: "普通 AI 聊天",
    rows: [
      "给一段文字建议，活儿还得你自己干",
      "大文件贴不进去，更别说跑分析、出图表",
      "关掉窗口就忘了你是谁",
      "能力固定，专业活儿只能凑合",
    ],
  },
  aurora: {
    title: "Aurora 全能助手",
    rows: [
      "自己拆任务、跑代码、查资料，把整件事干完",
      "直接读 Excel / PDF / 图片，交回图表、PPT 和报告",
      "记住你的身份、偏好与项目，下次自动接上",
      "AI 市场按需加装专家智能体与技能，越用越强",
    ],
  },
};

/** FAQ：把新用户最常见的犹豫点讲明白（信任信号 + 降低上手心理门槛）。 */
const FAQS = [
  {
    q: "免费版怎么算？",
    a: "注册即享每月 300 积分，够日常轻度使用；积分按实际消耗计费，不够用时可在应用内升级。",
  },
  {
    q: "需要会写提示词吗？",
    a: "不用。像跟同事说话一样描述需求就行，它会自己拆解、执行、交付；不知道说什么，照抄上手区的示例第一句即可。",
  },
  {
    q: "我上传的文件安全吗？",
    a: "文件只存放在你的专属工作空间、仅用于完成你交代的任务，可随时删除。",
  },
  {
    q: "和普通 AI 聊天有什么区别？",
    a: "普通聊天给你一段建议；它把活儿干完 —— 自己跑代码、查资料、做文件，最后交回能直接用的成果。",
  },
];


/** 企业/团队版卖点(§17.1)——四条,与「席位共享积分池 / 成员角色 / 报表发票 / 自助开通」对齐。 */
const ENTERPRISE_SELLING = [
  {
    icon: Layers,
    title: "席位共享积分池",
    body: "按席位订阅，团队共享一个积分池；闲置席位的额度自动汇集，人人够用、不浪费。",
  },
  {
    icon: Users,
    title: "成员与角色管理",
    body: "邀请成员、分配管理员与财务角色，按人设月度用量限额，团队用量一处掌控。",
  },
  {
    icon: ReceiptText,
    title: "组织报表与发票",
    body: "用量按成员 / 模型拆解成报表，发票抬头一次填好，按订单自助申请开票。",
  },
  {
    icon: Zap,
    title: "自助开通即用",
    body: "在线选档、按席位下单、扫码即开通，无需对接销售，几分钟拉起团队。",
  },
] as const;

/**
 * 企业/团队版区块(§17.1)。锚点价经公开端点 GET /api/subscription/plans?scope=org 拉取,
 * 取最低每席价展示「¥N/席起」;拉不到 → 静态兜底文案(不硬编码全价)。右侧一个**虚构示意**
 * 的团队用量迷你条形(数据显式标注"示意",非真实用量)。CTA「创建组织」→ onCreateOrg(深链
 * /?panel=org 等价)。
 */
function EnterpriseSection({ onCreateOrg }: { onCreateOrg: () => void }) {
  const [anchor, setAnchor] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .listOrgPlansPublic()
      .then((plans) => {
        if (!alive) return;
        const yuan = minSeatPriceYuan(plans);
        if (yuan) setAnchor(`¥${yuan}/席起`);
      })
      .catch(() => {
        /* 公开端点不可用:保持 null,下方静态兜底文案 */
      });
    return () => {
      alive = false;
    };
  }, []);

  // 虚构示意数据(非真实用量;组织积分池 + 三名成员的用量占比,含"财务"角色与"近限额"两种态)。
  const demoPoolUsedPct = 64;
  const demoMembers = [
    { name: "成员 A", credits: "6,400", pct: 64, delegate: true, note: null },
    { name: "成员 B", credits: "4,100", pct: 41, delegate: false, note: null },
    { name: "成员 C", credits: "2,300 / 2,500", pct: 92, delegate: false, note: "接近月度限额" },
  ] as const;

  return (
    <section id="enterprise" className="border-t border-border bg-sidebar/40">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <div className="mb-12 text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3.5 py-1.5 text-[13px] text-muted shadow-sm">
            <Building2 size={14} className="text-accent" />
            企业 / 团队版
          </div>
          <h2 className="text-[32px] font-bold tracking-tight md:text-[40px]">团队一起用，积分池共享不浪费</h2>
          <p className="mx-auto mt-3 max-w-2xl text-[16px] text-muted">
            按席位订阅企业套餐，团队共享一个积分池；成员、角色、限额一处管理，用量报表与发票开票自助搞定。
          </p>
        </div>

        <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-2">
          {/* 卖点 2×2 */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {ENTERPRISE_SELLING.map((s) => {
              const Icon = s.icon;
              return (
                <div key={s.title} className="rounded-xl border border-border bg-surface p-5">
                  <span className="mb-3 flex size-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
                    <Icon size={18} />
                  </span>
                  <div className="text-[15.5px] font-semibold">{s.title}</div>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{s.body}</p>
                </div>
              );
            })}
          </div>

          {/* 虚构示意:团队用量迷你条形 */}
          <div className="flex flex-col rounded-2xl border border-border bg-surface p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                <Layers size={15} className="text-accent" /> 团队用量
              </div>
              <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-faint">
                示意数据
              </span>
            </div>

            {/* 组织积分池 */}
            <div className="mt-4">
              <div className="flex items-center justify-between text-[12.5px]">
                <span className="text-muted">组织积分池</span>
                <span className="tabular-nums text-fg">
                  12,800<span className="text-faint"> / 20,000</span>
                </span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-hover" aria-hidden>
                <div className="h-full rounded-full bg-grad-cta" style={{ width: `${demoPoolUsedPct}%` }} />
              </div>
            </div>

            {/* 成员迷你条形 */}
            <div className="mt-5 flex flex-col gap-3">
              {demoMembers.map((m) => (
                <div key={m.name}>
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="flex items-center gap-1.5 text-muted">
                      {m.name}
                      {m.delegate && (
                        <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
                          财务
                        </span>
                      )}
                    </span>
                    <span className={cn("tabular-nums", m.note ? "text-faint" : "text-fg")}>
                      {m.credits}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover" aria-hidden>
                    <div
                      className={cn("h-full rounded-full", m.note ? "bg-faint/60" : "bg-accent")}
                      style={{ width: `${m.pct}%` }}
                    />
                  </div>
                  {m.note && <p className="mt-1 text-[10.5px] text-faint">{m.note}</p>}
                </div>
              ))}
            </div>

            <p className="mt-auto pt-5 text-[11px] text-faint">以上为示意数据，非真实用量。</p>
          </div>
        </div>

        {/* 锚点价 + CTA */}
        <div className="mt-10 flex flex-col items-center justify-center gap-3 text-center">
          <div className="text-[14px] text-muted">
            <span className="text-[18px] font-semibold text-fg">{anchor ?? "¥88/席起"}</span>
            <span className="ml-2 text-faint">团队规模随需加席，闲置额度不浪费</span>
          </div>
          <Button variant="primary" shape="pill" size="lg" onClick={onCreateOrg} className="shadow-float">
            <Building2 size={17} /> 创建组织
          </Button>
        </div>
      </div>
    </section>
  );
}

export function Landing({
  onStart,
  onLogin,
  onCreateOrg,
  theme,
  onCycleTheme,
}: {
  onStart: () => void;
  onLogin: () => void;
  /** 「创建组织」CTA:进入 org 创建深链(未登录先 AuthGate)。 */
  onCreateOrg: () => void;
  theme: Theme;
  onCycleTheme: () => void;
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
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
            <a href="#tutorials" className="transition-colors hover:text-fg">快速上手</a>
            <a href="#enterprise" className="transition-colors hover:text-fg">企业版</a>
            <a href="#faq" className="transition-colors hover:text-fg">常见问题</a>
          </nav>
          <div className="hidden shrink-0 items-center gap-1.5 md:flex">
            <ThemeToggle theme={theme} onCycle={onCycleTheme} />
            <Button variant="ghost" shape="pill" onClick={onLogin} className="text-muted">
              登录
            </Button>
            <Button variant="primary" shape="pill" onClick={onStart}>
              免费开始
            </Button>
          </div>
          <div className="flex shrink-0 items-center gap-1 md:hidden">
            <ThemeToggle theme={theme} onCycle={onCycleTheme} />
            <IconButton
              type="button"
              shape="square"
              aria-expanded={mobileNavOpen}
              aria-controls="landing-mobile-nav"
              aria-label={mobileNavOpen ? "关闭导航菜单" : "打开导航菜单"}
              onClick={() => setMobileNavOpen((open) => !open)}
            >
              {mobileNavOpen ? <X size={18} /> : <Menu size={18} />}
            </IconButton>
          </div>
        </div>
        {mobileNavOpen && (
          <div id="landing-mobile-nav" className="border-t border-border/60 px-4 py-4 md:hidden">
            <nav aria-label="移动端主导航" className="grid grid-cols-2 gap-1 text-[14px] text-muted">
              {[
                ["#demo", "演示"],
                ["#agents", "智能体"],
                ["#tutorials", "快速上手"],
                ["#enterprise", "企业版"],
                ["#faq", "常见问题"],
              ].map(([href, label]) => (
                <a
                  key={href}
                  href={href}
                  onClick={() => setMobileNavOpen(false)}
                  className="rounded-lg px-3 py-2.5 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {label}
                </a>
              ))}
            </nav>
            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border/60 pt-3">
              <Button
                variant="secondary"
                shape="pill"
                onClick={() => {
                  setMobileNavOpen(false);
                  onLogin();
                }}
              >
                登录
              </Button>
              <Button
                variant="primary"
                shape="pill"
                onClick={() => {
                  setMobileNavOpen(false);
                  onStart();
                }}
              >
                免费开始
              </Button>
            </div>
          </div>
        )}
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
            {BRAND.company} · 会干活的 AI 助手
          </div>
          <h1 className="mx-auto max-w-3xl text-balance text-[36px] font-bold leading-[1.1] tracking-tight sm:text-[40px] md:text-[60px] animate-in">
            把活儿交给它
            <span className="block bg-gradient-to-r from-accent to-info bg-clip-text text-transparent">
              拿回能直接用的成果
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-[17px] leading-relaxed text-muted animate-in">
            读文件、联网调研、写代码、跑分析 —— 像给同事派活一样吩咐一句，它自己把整件事干完：交回做好的图表、PPT、Excel、报告，和已经推送的代码。
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
          <p className="mt-5 text-[13px] text-faint">免费版每月 300 积分</p>
        </div>

        {/* 动态演示 —— 左对话右成果的工作台，让「交付成果」看得见 */}
        <div id="demo" className="relative mx-auto max-w-5xl scroll-mt-20 px-5 pb-14">
          <DemoShowcase onTry={onStart} />
        </div>
      </section>

      {/* 差异化对比：不是又一个聊天机器人 */}
      <section id="compare" className="border-y border-border bg-sidebar/50">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="mb-12 text-center">
            <h2 className="text-[32px] font-bold tracking-tight md:text-[40px]">不是又一个聊天机器人</h2>
            <p className="mx-auto mt-3 max-w-xl text-[16px] text-muted">
              普通 AI 给你一段建议；它像同事一样把活儿干完 —— 而且越用越好用，越用越懂你。
            </p>
          </div>
          <div className="mx-auto grid max-w-4xl grid-cols-1 gap-5 md:grid-cols-2">
            {/* 普通 AI 聊天 */}
            <div className="rounded-2xl border border-border bg-surface p-7">
              <div className="mb-5 flex items-center gap-2.5">
                <span className="flex size-9 items-center justify-center rounded-xl bg-hover text-faint">
                  <MessageSquareText size={18} />
                </span>
                <h3 className="text-[17px] font-semibold text-muted">{COMPARE.chat.title}</h3>
              </div>
              <ul className="space-y-3.5">
                {COMPARE.chat.rows.map((r) => (
                  <li key={r} className="flex items-start gap-2.5 text-[14.5px] leading-relaxed text-faint">
                    <X size={16} className="mt-1 shrink-0" />
                    {r}
                  </li>
                ))}
              </ul>
            </div>
            {/* Aurora */}
            <div className="relative rounded-2xl border border-accent/40 bg-surface p-7 shadow-[var(--shadow-float)] ring-1 ring-accent/20">
              <div className="mb-5 flex items-center gap-2.5">
                <span className="flex size-9 items-center justify-center rounded-xl bg-grad-cta text-white">
                  <Sparkles size={18} />
                </span>
                <h3 className="text-[17px] font-semibold">{COMPARE.aurora.title}</h3>
              </div>
              <ul className="space-y-3.5">
                {COMPARE.aurora.rows.map((r) => (
                  <li key={r} className="flex items-start gap-2.5 text-[14.5px] leading-relaxed text-fg">
                    <Check size={16} className="mt-1 shrink-0 text-accent" />
                    {r}
                  </li>
                ))}
              </ul>
            </div>
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

      {/* 企业 / 团队版 —— 个人价值讲清后,向"团队规模化"升级叙事(席位池/成员管理/报表发票) */}
      <EnterpriseSection onCreateOrg={onCreateOrg} />

      {/* FAQ —— 把注册前最常见的犹豫点讲明白 */}
      <section id="faq" className="border-t border-border bg-sidebar/40">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="mb-12 text-center">
            <h2 className="text-[32px] font-bold tracking-tight md:text-[40px]">常见问题</h2>
            <p className="mx-auto mt-3 max-w-xl text-[16px] text-muted">还有疑问？注册后随时问它自己。</p>
          </div>
          <div className="mx-auto grid max-w-4xl grid-cols-1 gap-4 md:grid-cols-2">
            {FAQS.map((f) => (
              <div key={f.q} className="rounded-2xl border border-border bg-surface p-6">
                <h3 className="text-[16px] font-semibold">{f.q}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-muted">{f.a}</p>
              </div>
            ))}
          </div>
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
                <a href="#tutorials" className="text-muted hover:text-fg">快速上手</a>
                <a href="#enterprise" className="text-muted hover:text-fg">企业版</a>
                <a href="#faq" className="text-muted hover:text-fg">常见问题</a>
              </div>
              <div className="flex flex-col gap-2.5">
                <span className="font-medium text-fg">关于</span>
                <span className="text-muted">{BRAND.companyShort}</span>
                <span className="text-muted">联系合作</span>
                <a href="/terms" className="text-muted hover:text-fg">用户协议</a>
                <a href="/privacy" className="text-muted hover:text-fg">隐私政策</a>
              </div>
            </div>
          </div>
          <div className="mt-9 flex flex-col gap-1.5 border-t border-border pt-6 text-[12.5px] text-faint">
            <span>© {BRAND.year} {BRAND.company} 版权所有</span>
            <span>{BRAND.icp}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
