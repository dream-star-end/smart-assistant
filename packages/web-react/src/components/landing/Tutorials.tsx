import { Check, Copy, Rocket } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LANDING_STARTERS, type Starter } from "../../lib/starters";

/**
 * 三步上手：把「多快能用起来」讲清楚（调研共识：3 分钟内到 wow moment）。
 * 与动态演示职责分离 —— 演示是「看它干活」，这里是「你开口的第一句」。
 */
const QUICKSTART: { n: string; title: string; desc: string }[] = [
  { n: "1", title: "邮箱注册", desc: "一分钟拥有专属助手，免费额度即刻到账。" },
  { n: "2", title: "像派活一样开口", desc: "不用学提示词，把需求像跟同事说话一样讲出来。" },
  { n: "3", title: "需要时再加装", desc: "更专业的活儿，从 AI 市场一键装上专家智能体。" },
];

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
          ?.writeText(s.prompt)
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
        <span className="block text-[11.5px] font-semibold text-accent">{s.label}</span>
        <span className="mt-0.5 block text-[13.5px] leading-relaxed text-muted">
          {copied ? "已复制，去粘贴给它吧 ✓" : `「${s.prompt}」`}
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

      {/* 开口第一句 */}
      <div className="mb-6 text-center">
        <h3 className="text-[22px] font-bold tracking-tight">不知道说什么？开口第一句，照抄就行</h3>
        <p className="mx-auto mt-2 max-w-xl text-[14.5px] text-muted">
          点一下复制，注册后粘进对话框 —— 定时、记忆、连仓库这些活儿它也全接。
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {LANDING_STARTERS.map((s) => (
          <StarterChip key={s.id} s={s} />
        ))}
      </div>
    </section>
  );
}
