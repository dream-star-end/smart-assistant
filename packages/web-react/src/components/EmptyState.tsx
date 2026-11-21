import { ArrowLeftRight, ArrowUpRight, Lightbulb, ListChecks, PenLine, Sparkles, Target } from "lucide-react";
import type { Agent } from "../lib/agents";
import type { User } from "../lib/types";
import { AgentAvatar } from "./AgentAvatar";
import { Button } from "./ui";

const FALLBACK_STARTERS = [
  "帮我把下面这段内容整理成要点",
  "用一句话说明你能帮我做什么",
];

/** 起步卡的装饰图标、徽章色阶与编辑风短眉（均 aria-hidden，不影响按钮可访问名）。 */
const STARTER_SLOTS = [
  { Icon: Sparkles, badge: "oc-icon-badge-accent", eyebrow: "灵感切入" },
  { Icon: PenLine, badge: "oc-icon-badge-info", eyebrow: "写作润色" },
  { Icon: Lightbulb, badge: "oc-icon-badge-warning", eyebrow: "深度探索" },
  { Icon: ListChecks, badge: "oc-icon-badge-success", eyebrow: "高效拆解" },
] as const;

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
    <div className="relative flex min-h-full flex-col items-center justify-center overflow-hidden px-4 py-10 text-center animate-fade sm:py-14">
      <div
        aria-hidden="true"
        className="oc-home-glow pointer-events-none absolute left-1/2 top-[14%] h-[320px] w-[min(680px,100%)] -translate-x-1/2"
      />
      <div className="relative flex w-full max-w-3xl flex-col items-center">
        {/* 当前智能体身份 + 切换入口收成一枚雕塑磨砂胶囊，让问候成为视觉主角。 */}
        <div className="oc-surface-glass inline-flex items-center gap-1.5 rounded-full py-1 pl-1.5 pr-1">
          <AgentAvatar agent={agent} className="size-7 rounded-full" iconSize={14} />
          <span className="max-w-[40vw] truncate pl-1 text-body font-semibold tracking-tight text-fg">
            {agent.name}
          </span>
          <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-border-strong/70" />
          <Button
            variant="ghost"
            size="sm"
            shape="pill"
            onClick={onChangeAgent}
            className="oc-btn-tactile h-7 gap-1 px-2.5 text-caption font-medium text-muted hover:bg-accent-soft hover:text-accent"
          >
            <ArrowLeftRight size={12} strokeWidth={1.75} aria-hidden="true" />
            换一个智能体
          </Button>
        </div>
        {/* h2 而非 h1:文档唯一的 h1 是 App 里给读屏定位的 sr-only 会话标题,欢迎页标题在
            语义上从属于当前会话;两个并列 h1 会稀释"我在哪个会话"的定位(shell 审计 S-10)。 */}
        <h2 className="oc-home-title mt-7 max-w-2xl text-balance text-3xl font-semibold leading-[1.16] tracking-[-0.035em] sm:text-4xl">
          {title}
        </h2>
        {/* text-balance:两行均分,不再留一个孤零零的「行。」挂在第二行。 */}
        <p className="mt-3 max-w-lg text-balance text-title font-normal leading-relaxed text-muted">
          {name ? `今天想让${agent.name}帮你完成什么？` : agent.description}
        </p>

        {/* 恰好 3 条时桌面一排三张,不在 2 列网格里留一个空洞。 */}
        <div
          className={`mt-9 grid w-full grid-cols-1 gap-3 sm:grid-cols-2 ${
            starters.length === 3 ? "max-w-3xl md:grid-cols-3" : "max-w-2xl"
          }`}
        >
          {starters.map((s, i) => {
            const slot = STARTER_SLOTS[i % STARTER_SLOTS.length];
            const Icon = slot.Icon;
            return (
              <button
                key={s}
                type="button"
                onClick={() => onPrefill(s)}
                // 手机竖屏放不下 4 张卡(占满整屏视口):前 2 张足以下手,其余 md 起恢复。
                // 装饰性眉标与箭头均 aria-hidden，保证按钮可访问名精确等于 starter 文本。
                className={`oc-surface-card oc-surface-card-hover group flex flex-col justify-between gap-3 rounded-lg p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg${
                  i >= 2 ? " hidden md:flex" : ""
                }`}
              >
                <div aria-hidden="true" className="flex w-full items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={`oc-icon-badge ${slot.badge} size-7`}>
                      <Icon size={14} strokeWidth={1.75} />
                    </span>
                    <span className="text-caption font-medium tracking-wide text-faint transition-colors group-hover:text-muted">
                      {slot.eyebrow}
                    </span>
                  </div>
                  <ArrowUpRight
                    size={15}
                    strokeWidth={1.75}
                    className="shrink-0 text-faint opacity-55 transition-[opacity,transform,color] duration-200 ease-spring group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-accent group-hover:opacity-100 group-focus-visible:opacity-100"
                  />
                </div>
                <span className="min-w-0 text-body font-medium leading-relaxed text-fg/90 transition-colors group-hover:text-fg">
                  {s}
                </span>
              </button>
            );
          })}
        </div>
        {onOpenGoal && (
          // 走 Button 原语而不是裸 <button>:11px 纯文字链接的命中区远低于 44px,原语在触屏下
          // 自带 min-h-11 兜底(shell 审计 S-09);视觉保持克制的微胶囊链接。
          <Button
            variant="link"
            size="sm"
            className="oc-btn-tactile mt-6 gap-1.5 rounded-full px-3 text-caption font-medium text-muted no-underline hover:bg-accent-soft hover:text-accent hover:no-underline"
            onClick={onOpenGoal}
          >
            <Target size={13} strokeWidth={1.75} aria-hidden="true" />
            为这次会话设定目标
          </Button>
        )}
      </div>
    </div>
  );
}
