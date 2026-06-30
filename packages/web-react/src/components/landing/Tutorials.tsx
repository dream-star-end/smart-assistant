import {
  BookOpen,
  Brain,
  Check,
  Clock,
  Copy,
  GitBranch,
  Globe,
  type LucideIcon,
  Paperclip,
  Puzzle,
  Sparkles,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";

/** 三步上手。 */
const QUICKSTART: { n: string; title: string; desc: string }[] = [
  { n: "1", title: "注册并登录", desc: "邮箱注册，一分钟拥有专属助手，免费额度即刻到账。" },
  { n: "2", title: "直接开口提问", desc: "写作、编程、查资料、做分析…… 像聊天一样把需求说出来即可。" },
  { n: "3", title: "按需加装能力", desc: "想更专业？从 AI 市场一键安装技能与专家智能体，助手越用越强。" },
];

type Feature = {
  icon: LucideIcon;
  title: string;
  desc: string;
  /** 可一键复制的示例指令。 */
  example: string;
};

const FEATURES: Feature[] = [
  {
    icon: Sparkles,
    title: "全能助手对话",
    desc: "开箱即用，无需配置。写作、答疑、规划、翻译、出主意，一个助手全包。",
    example: "帮我把这段话改得更礼貌专业，再给三个不同语气的版本",
  },
  {
    icon: Puzzle,
    title: "AI 市场 · 装技能 / 智能体",
    desc: "需要更专业时，从市场一键安装技能与专家智能体，能力随用随装，越用越好用。",
    example: "我要做小红书运营，帮我从市场装个文案专家",
  },
  {
    icon: Brain,
    title: "长期记忆",
    desc: "记住你的身份、偏好与项目背景，下次自动带上下文，越用越懂你。",
    example: "记住：我们公司简称叫「云图」，主营智能硬件",
  },
  {
    icon: Clock,
    title: "定时任务",
    desc: "把重复的活儿交给它，按时自动跑完再把结果推送给你。",
    example: "每周一早上 9 点，把上周热点科技新闻整理发我",
  },
  {
    icon: Paperclip,
    title: "文件 / 图片上传",
    desc: "上传 PDF、表格、图片，让助手读懂内容再帮你分析、总结、提取。",
    example: "（上传一份合同 PDF）帮我列出这份合同里的风险点",
  },
  {
    icon: Globe,
    title: "联网搜索",
    desc: "需要实时信息时自动联网检索并交叉核对，给出带来源的结论。",
    example: "查一下这周国内新能源车销量榜，并总结趋势",
  },
  {
    icon: GitBranch,
    title: "GitHub 仓库直连",
    desc: "把仓库连给助手，让它直接读你的代码、改 bug、写功能、提交。",
    example: "连上我的仓库，帮我定位并修复登录页的这个报错",
  },
  {
    icon: SlidersHorizontal,
    title: "多模型可选",
    desc: "对话框随时切换底层模型，按速度、深度、成本灵活取舍。",
    example: "用更擅长推理的模型，重新分析一下这道题",
  },
];

/** 可点击复制的示例指令芯片。 */
function ExampleChip({ text }: { text: string }) {
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
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            if (timerRef.current != null) window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => setCopied(false), 1600);
          })
          .catch(() => {});
      }}
      title="点击复制示例"
      className="group/ex mt-3 flex w-full items-start gap-2 rounded-xl border border-dashed border-border bg-bg px-3 py-2 text-left transition-colors hover:border-accent/50 hover:bg-accent-soft"
    >
      <span className="mt-0.5 shrink-0 text-accent">
        {copied ? <Check size={14} /> : <Copy size={14} className="opacity-60 group-hover/ex:opacity-100" />}
      </span>
      <span className="text-[12.5px] leading-relaxed text-muted">
        <span className="font-medium text-faint">试着说：</span>
        {copied ? "已复制到剪贴板 ✓" : `「${text}」`}
      </span>
    </button>
  );
}

/** 落地页教程区：三步上手 + 逐功能使用示例（每个示例一键复制）。 */
export function Tutorials() {
  return (
    <section id="tutorials" className="mx-auto max-w-6xl px-5 py-20">
      <div className="mb-12 text-center">
        <span className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-[12.5px] text-muted">
          <BookOpen size={13} className="text-accent" />
          上手教程
        </span>
        <h2 className="text-[32px] font-bold tracking-tight md:text-[40px]">五分钟，玩转每个功能</h2>
        <p className="mx-auto mt-3 max-w-xl text-[16px] text-muted">
          每个能力都配了可直接复制的示例指令 —— 复制、粘进对话框，立刻见效。
        </p>
      </div>

      {/* 三步上手 */}
      <div className="mb-12 grid grid-cols-1 gap-4 sm:grid-cols-3">
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

      {/* 逐功能示例 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map((f) => (
          <div
            key={f.title}
            className="flex flex-col rounded-2xl border border-border bg-surface p-5 transition-[transform,box-shadow,border-color] duration-200 ease-standard hover:-translate-y-0.5 hover:border-border-strong hover:shadow-soft"
          >
            <span className="mb-3.5 flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <f.icon size={19} />
            </span>
            <h3 className="text-[16px] font-semibold">{f.title}</h3>
            <p className="mt-1.5 flex-1 text-[13.5px] leading-relaxed text-muted">{f.desc}</p>
            <ExampleChip text={f.example} />
          </div>
        ))}
      </div>
    </section>
  );
}
