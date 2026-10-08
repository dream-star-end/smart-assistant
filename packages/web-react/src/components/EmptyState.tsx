import { ArrowLeftRight, ArrowUpRight, Lightbulb, ListChecks, PenLine, Sparkles, Target } from "lucide-react";
import type { Agent } from "../lib/agents";
import type { User } from "../lib/types";
import { AgentAvatar } from "./AgentAvatar";
import { Button } from "./ui";

const FALLBACK_STARTERS = [
  "帮我把下面这段内容整理成要点",
  "用一句话说明你能帮我做什么",
];

/** 起步卡的装饰图标:按位置轮换,纯视觉(starters 是自由文本,不做语义归类)。 */
const STARTER_ICONS = [Sparkles, PenLine, Lightbulb, ListChecks];

/** 按本地时间问候;凌晨单独一档,不在 3 点说「早上好」。 */
export function greetingFor(date: Date): string {
  const h = date.getHours();
  if (h >= 5 && h < 11) return "上午好";
  if (h >= 11 && h < 13) return "中午好";
  if (h >= 13 && h < 18) return "下午好";
  if (h >= 18 && h < 23) return "晚上好";
  return "夜深了";
}

/**
 * 问候里用的名字:只取用户自己设的显示名。后端缺 display_name 时 displayName 会回落成邮箱或
 * 「用户」(api.ts toUser),这两种都不适合出现在「下午好，…」里,返回 undefined 让标题回落智能体名。
 */
export function greetingName(user: Pick<User, "displayName" | "email"> | null | undefined): string | undefined {
  const n = user?.displayName?.trim();
  if (!n || n === "用户" || n === user?.email || n.includes("@")) return undefined;
  return n;
}

export function EmptyState({
  agent,
  userName,
  onPrefill,
  onChangeAgent,
  onOpenGoal,
  now,
}: {
  agent: Agent;
  /** 登录用户的显示名;缺省(demo / 未取到)时标题回落为智能体名。 */
  userName?: string;
  onPrefill: (text: string) => void;
  onChangeAgent: () => void;
  onOpenGoal?: () => void;
  /** 测试注入用;默认取当前时间。 */
  now?: Date;
}) {
  const name = userName?.trim();
  const title = name ? `${greetingFor(now ?? new Date())}，${name}` : agent.name;
  const starters = agent.starters?.length ? agent.starters : FALLBACK_STARTERS;
  return (
    <div className="relative flex min-h-full flex-col items-center justify-center overflow-hidden px-4 py-12 text-center animate-fade">
      <div
        aria-hidden="true"
        className="oc-home-glow pointer-events-none absolute left-1/2 top-[18%] h-[300px] w-[min(640px,100%)] -translate-x-1/2"
      />
      <div className="relative flex w-full flex-col items-center">
        {/* 当前智能体身份 + 切换入口收成一枚胶囊,让问候成为视觉主角(参考主流 AI 产品的新会话页)。 */}
        <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/80 py-1 pl-1 pr-1 shadow-soft backdrop-blur">
          <AgentAvatar agent={agent} className="size-7 rounded-full" iconSize={15} />
          <span className="max-w-[40vw] truncate pl-0.5 text-[13px] font-medium text-fg">{agent.name}</span>
          <Button
            variant="ghost"
            size="sm"
            shape="pill"
            onClick={onChangeAgent}
            className="h-7 gap-1 px-2.5 text-[12.5px] text-muted"
          >
            <ArrowLeftRight size={12} aria-hidden="true" />
            换一个智能体
          </Button>
        </div>
        {/* h2 而非 h1:文档唯一的 h1 是 App 里给读屏定位的 sr-only 会话标题,欢迎页标题在
            语义上从属于当前会话;两个并列 h1 会稀释"我在哪个会话"的定位(shell 审计 S-10)。 */}
        <h2 className="oc-home-title mt-6 max-w-2xl text-balance text-[30px] font-semibold leading-tight tracking-[-0.03em] sm:text-[38px]">
          {title}
        </h2>
        {/* text-balance:两行均分,不再留一个孤零零的「行。」挂在第二行。 */}
        <p className="mt-3 max-w-md text-balance text-[15px] leading-relaxed text-muted">
          {name ? `今天想让${agent.name}帮你完成什么？` : agent.description}
        </p>

        {/* 恰好 3 条时桌面一排三张,不在 2 列网格里留一个空洞。 */}
        <div
          className={`mt-9 grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2 ${
            starters.length === 3 ? "max-w-3xl md:grid-cols-3" : "max-w-2xl"
          }`}
        >
          {starters.map((s, i) => {
            const Icon = STARTER_ICONS[i % STARTER_ICONS.length];
            return (
              <button
                key={s}
                type="button"
                onClick={() => onPrefill(s)}
                // 手机竖屏放不下 4 张卡(占满整屏视口):前 2 张足以下手,其余 md 起恢复。
                // OCV5-307:14px 圆角卡;右上角箭头 hover 才浮出,提示"点了会填进输入框"。
                className={`group flex items-start gap-3 rounded-[16px] border border-border bg-surface/85 px-4 py-3.5 text-left text-[14px] leading-relaxed text-muted outline-none backdrop-blur transition-[transform,box-shadow,border-color,color] duration-200 ease-standard hover:-translate-y-0.5 hover:border-border-strong hover:text-fg hover:shadow-soft focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg${
                  i >= 2 ? " hidden md:flex" : ""
                }`}
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"
                >
                  <Icon size={14} />
                </span>
                <span className="min-w-0 flex-1">{s}</span>
                <ArrowUpRight
                  size={15}
                  aria-hidden="true"
                  className="mt-1 shrink-0 text-faint opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
                />
              </button>
            );
          })}
        </div>
        {onOpenGoal && (
          // 走 Button 原语而不是裸 <button>:11px 纯文字链接的命中区远低于 44px,原语在触屏下
          // 自带 min-h-11 兜底(shell 审计 S-09);视觉仍是文字链接。
          <Button
            variant="link"
            size="sm"
            className="mt-5 gap-1.5 px-0 text-caption font-normal text-muted"
            onClick={onOpenGoal}
          >
            <Target size={12} aria-hidden="true" />
            为这次会话设定目标
          </Button>
        )}
      </div>
    </div>
  );
}
