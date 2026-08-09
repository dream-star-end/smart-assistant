import {
  ArrowRight,
  Brain,
  Check,
  Clock,
  Copy,
  GitBranch,
  Globe,
  type LucideIcon,
  Paperclip,
  PenLine,
  Rocket,
  SlidersHorizontal,
  Terminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { tutorialHref } from "../../hooks/useAppRoute";
import {
  TUTORIAL_CASE_BY_ID,
  type TutorialCaseCategory,
} from "../../lib/tutorialCaseCatalog";

/**
 * 三步上手：把「多快能用起来」讲清楚（调研共识：3 分钟内到 wow moment）。
 * 与动态演示职责分离 —— 演示是「看它干活」，这里是「你开口的第一句」。
 */
const QUICKSTART: { n: string; title: string; desc: string }[] = [
  { n: "1", title: "邮箱注册", desc: "一分钟拥有专属助手，免费额度即刻到账。" },
  { n: "2", title: "像派活一样开口", desc: "不用学提示词，把需求像跟同事说话一样讲出来。" },
  { n: "3", title: "需要时再加装", desc: "更专业的活儿，从 AI 市场一键装上专家智能体。" },
];

/**
 * 「开口第一句」：分类可复制的示例指令。空白输入框是新用户最大流失点，
 * 给一句能直接照抄的话；类别刻意覆盖演示区没展开的能力（定时 / 记忆 / 多模型 / GitHub…）。
 */
type Starter = { icon: LucideIcon; tag: string; text: string };

const STARTERS: Starter[] = [
  {
    icon: Paperclip,
    tag: "上传文件",
    text: "（上传 Excel）帮我做一张月度费用透视表，把异常项标出来",
  },
  {
    icon: Clock,
    tag: "定时任务",
    text: "每个工作日早上 9 点，汇总昨晚的行业动态要点发给我",
  },
  {
    icon: Brain,
    tag: "长期记忆",
    text: "记住：我是做母婴电商的，之后回答商业问题都贴着我的行业来",
  },
  {
    icon: Globe,
    tag: "联网调研",
    text: "联网查一下本周新发布的 AI 工具，挑 3 个值得试的，给出理由",
  },
  {
    icon: PenLine,
    tag: "写作",
    text: "给新品上线写 3 版朋友圈文案，语气分别专业、亲切、俏皮",
  },
  {
    icon: Terminal,
    tag: "编程",
    text: "写个 Python 脚本，把文件夹里的发票 PDF 批量重命名成「日期_金额」",
  },
  {
    icon: GitBranch,
    tag: "GitHub",
    text: "连上我的仓库，优化首页加载速度，跑通构建后提交推送",
  },
  {
    icon: SlidersHorizontal,
    tag: "多模型",
    text: "换个更擅长推理的模型，再帮我推演一遍这个定价方案",
  },
];

const FEATURED_CASES = [
  TUTORIAL_CASE_BY_ID["research-bike-demand"],
  TUTORIAL_CASE_BY_ID["coding-swe-bench-fix"],
];

function caseCategoryLabel(category: TutorialCaseCategory): string {
  if (category === "research") return "科研";
  if (category === "coding") return "编码";
  return "通用";
}

/** 可点击复制的示例指令芯片。 */
function StarterChip({ s }: { s: Starter }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  // 卸载清掉「已复制」回退定时器，避免卸载后 setState。
  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    [],
  );
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(s.text)
          .then(() => {
            setCopied(true);
            if (timerRef.current != null) window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => setCopied(false), 1600);
          })
          .catch(() => {});
      }}
      title="点击复制"
      className="group flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3.5 text-left outline-none transition-[border-color,background-color,transform] duration-200 ease-standard hover:-translate-y-0.5 hover:border-accent/50 hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <s.icon size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11.5px] font-semibold text-accent">{s.tag}</span>
        <span className="mt-0.5 block text-[13.5px] leading-relaxed text-muted">
          {copied ? "已复制，去粘贴给它吧 ✓" : `「${s.text}」`}
        </span>
      </span>
      <span className="mt-1 shrink-0 text-accent">
        {copied ? (
          <Check size={15} />
        ) : (
          <Copy size={15} className="opacity-0 transition-opacity group-hover:opacity-70" />
        )}
      </span>
    </button>
  );
}

/** 落地页快速上手区：三步上手 + 分类「开口第一句」（每条一键复制）。 */
export function Tutorials() {
  return (
    <section id="tutorials" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-20">
      <div className="mb-12 text-center">
        <span className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-[12.5px] text-muted">
          <Rocket size={13} className="text-accent" />
          快速上手
        </span>
        <h2 className="text-[32px] font-bold tracking-tight md:text-[40px]">三步开始，一分钟上手</h2>
        <p className="mx-auto mt-3 max-w-xl text-[16px] text-muted">
          不用学提示词、不用做配置 —— 注册、开口、需要时再加装。
        </p>
      </div>

      {/* 三步上手 */}
      <div className="mb-14 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {QUICKSTART.map((s) => (
          <div key={s.n} className="relative rounded-2xl border border-border bg-surface p-6">
            <span className="flex size-9 items-center justify-center rounded-full bg-grad-cta text-[15px] font-semibold text-white shadow-sm">
              {s.n}
            </span>
            <h3 className="mt-4 text-[17px] font-semibold">{s.title}</h3>
            <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{s.desc}</p>
          </div>
        ))}
      </div>

      {/* 两条任务回放入口：让新用户先看完整故事，不再铺案例目录。 */}
      <div className="mb-6 text-center">
        <h3 className="text-[22px] font-bold tracking-tight">先看一件难事，V5 是怎么做完的</h3>
        <p className="mx-auto mt-2 max-w-xl text-[14.5px] text-muted">
          不列功能清单。直接进入科研或编码任务，看材料怎样变成可检查、可继续的成果。
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {FEATURED_CASES.map((item) => (
          <a
            key={item.id}
            href={tutorialHref(window.location, null, item.id)}
            className="group rounded-2xl border border-border bg-surface p-5 outline-none transition-[border-color,background-color,transform] duration-200 ease-standard hover:-translate-y-0.5 hover:border-accent/50 hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[11.5px] font-semibold text-accent">
                {caseCategoryLabel(item.category)} · {item.difficulty}
              </span>
              <ArrowRight size={15} className="text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
            </div>
            <h4 className="mt-3 text-[16px] font-semibold text-fg">{item.title}</h4>
            <p className="mt-1.5 line-clamp-2 text-[13.5px] leading-6 text-muted">{item.summary}</p>
            <p className="mt-3 text-[12px] font-medium text-accent">打开任务全流程</p>
          </a>
        ))}
      </div>

      {/* 开口第一句 */}
      <div className="mb-6 mt-14 text-center">
        <h3 className="text-[22px] font-bold tracking-tight">只想马上试试？开口第一句，照抄就行</h3>
        <p className="mx-auto mt-2 max-w-xl text-[14.5px] text-muted">
          点一下复制，注册后粘进对话框 —— 定时、记忆、连仓库这些活儿它也全接。
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {STARTERS.map((s) => (
          <StarterChip key={s.tag} s={s} />
        ))}
      </div>
    </section>
  );
}
