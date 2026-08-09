import type { TutorialCaseFieldReport, TutorialCaseId } from "../../lib/tutorialCaseCatalog";
import { cn } from "../../lib/utils";
import { CaseFieldReportVisual } from "./CaseFieldReportVisual";

type ArtworkKind =
  | "network"
  | "forecast"
  | "funnel"
  | "review"
  | "audit"
  | "diff"
  | "delivery"
  | "tests"
  | "accessibility"
  | "dependencies"
  | "actions"
  | "brief";

export type CasePresentation = {
  pain: string;
  result: string;
  metric: string;
  kind: ArtworkKind;
  gradient: string;
};

export const CASE_PRESENTATION: Record<TutorialCaseId, CasePresentation> = {
  "research-evidence-map": {
    pain: "论文越读越多，关键结论却找不到出处？",
    result: "一张每个结论都能点回原文的证据图谱",
    metric: "30 篇论文 → 证据图谱",
    kind: "network",
    gradient: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 52%, #2563eb 100%)",
  },
  "research-bike-demand": {
    pain: "分析跑完了，换台电脑却复现不了？",
    result: "可一键重跑的单车需求分析工程",
    metric: "数据 → 图表 → 报告",
    kind: "forecast",
    gradient: "linear-gradient(135deg, #075985 0%, #0891b2 55%, #14b8a6 100%)",
  },
  "research-systematic-screening": {
    pain: "几百篇文献，纳排理由越筛越乱？",
    result: "每条决定都可追踪的筛选流水线",
    metric: "检索 → 去重 → 纳排",
    kind: "funnel",
    gradient: "linear-gradient(135deg, #0f766e 0%, #059669 52%, #65a30d 100%)",
  },
  "research-open-peer-review": {
    pain: "评审意见很多，却没有页码和证据？",
    result: "逐条定位、可操作的同行评议包",
    metric: "定位 · 证据 · 建议",
    kind: "review",
    gradient: "linear-gradient(135deg, #6d28d9 0%, #a21caf 54%, #db2777 100%)",
  },
  "research-replication-audit": {
    pain: "代码能启动，就能叫复现成功吗？",
    result: "明确差异来源的复现审计报告",
    metric: "环境 · 数值 · 差异",
    kind: "audit",
    gradient: "linear-gradient(135deg, #1e3a8a 0%, #3730a3 52%, #7e22ce 100%)",
  },
  "coding-swe-bench-fix": {
    pain: "Bug 修好了，怎么证明没破坏正常路径？",
    result: "带回归测试的最小修复提交",
    metric: "失败 → 修复 → 全绿",
    kind: "diff",
    gradient: "linear-gradient(135deg, #111827 0%, #1e3a8a 52%, #0369a1 100%)",
  },
  "coding-feature-delivery": {
    pain: "需求只有一句话，怎样变成可合并 PR？",
    result: "从验收标准到测试齐全的功能交付",
    metric: "需求 → 契约 → PR",
    kind: "delivery",
    gradient: "linear-gradient(135deg, #312e81 0%, #2563eb 52%, #0891b2 100%)",
  },
  "coding-regression-rescue": {
    pain: "偶发测试失败，为什么总是抓不到？",
    result: "稳定复现并修掉重复求值回归",
    metric: "红测 → 根因 → 绿测",
    kind: "tests",
    gradient: "linear-gradient(135deg, #7f1d1d 0%, #c2410c 52%, #15803d 100%)",
  },
  "coding-frontend-quality": {
    pain: "页面看起来能用，键盘和手机却走不通？",
    result: "有浏览器证据的可访问性补丁",
    metric: "桌面 · 手机 · 键盘",
    kind: "accessibility",
    gradient: "linear-gradient(135deg, #0f172a 0%, #334155 48%, #0f766e 100%)",
  },
  "coding-dependency-upgrade": {
    pain: "升级一个依赖，最怕连锁崩坏和无法回退？",
    result: "有兼容证据和回退路径的升级 PR",
    metric: "兼容 · 构建 · 回退",
    kind: "dependencies",
    gradient: "linear-gradient(135deg, #3f3f46 0%, #7c2d12 48%, #ea580c 100%)",
  },
  "general-meeting-actions": {
    pain: "会开完了，谁做什么还是没人说得清？",
    result: "每项行动可回到原文的责任清单",
    metric: "发言 → 行动 → 负责人",
    kind: "actions",
    gradient: "linear-gradient(135deg, #9f1239 0%, #db2777 50%, #f97316 100%)",
  },
  "general-public-data-brief": {
    pain: "公开数据很多，怎样做成能决策的一页纸？",
    result: "来源和计算都可追溯的市场简报",
    metric: "API → 指标 → 一页简报",
    kind: "brief",
    gradient: "linear-gradient(135deg, #92400e 0%, #ea580c 52%, #eab308 100%)",
  },
};

export function CaseArtwork({
  caseId,
  fieldReport,
  className,
}: {
  caseId: TutorialCaseId;
  fieldReport?: TutorialCaseFieldReport;
  className?: string;
}) {
  if (fieldReport) {
    return <CaseFieldReportVisual report={fieldReport} className={className} />;
  }
  const presentation = CASE_PRESENTATION[caseId];
  return (
    <div
      role="img"
      aria-label={`成果示意：${presentation.result}`}
      className={cn(
        "relative isolate aspect-[16/9] overflow-hidden text-white",
        className,
      )}
      style={{ background: presentation.gradient }}
      data-artwork-kind={presentation.kind}
    >
      <span className="absolute -right-10 -top-16 size-44 rounded-full bg-white/15 blur-2xl" />
      <span className="absolute -bottom-20 -left-10 size-48 rounded-full bg-black/15 blur-2xl" />
      <span className="absolute inset-x-0 top-0 z-[1] h-20 bg-gradient-to-b from-black/70 to-transparent" />
      <span className="absolute inset-x-0 bottom-0 z-[1] h-24 bg-gradient-to-t from-black/70 to-transparent" />
      <div className="absolute inset-x-4 top-3 z-10 flex items-center justify-between gap-3 sm:inset-x-5 sm:top-4">
        <span className="rounded-full border border-white/35 bg-black/35 px-2.5 py-1 text-[10px] font-semibold tracking-wide backdrop-blur-sm sm:text-[11px]">
          完成后你会得到
        </span>
        <span className="text-[10px] font-medium text-white sm:text-[11px]">V5 实战</span>
      </div>
      <ArtworkGraphic kind={presentation.kind} />
      <div className="absolute inset-x-4 bottom-3 z-10 sm:inset-x-5 sm:bottom-4">
        <p className="text-[15px] font-semibold leading-5 tracking-tight sm:text-[17px]">
          {presentation.metric}
        </p>
      </div>
    </div>
  );
}

function ArtworkGraphic({ kind }: { kind: ArtworkKind }) {
  return (
    <svg
      viewBox="0 0 480 270"
      aria-hidden="true"
      className="absolute inset-0 h-full w-full"
      fill="none"
    >
      {kind === "network" && (
        <g transform="translate(92 61)">
          <g stroke="white" strokeOpacity=".42" strokeWidth="2">
            <path d="M64 67 141 28l84 35 60-31M64 67l57 63 104-67 54 68M121 130l109 15 49-14M141 28l-20 102M225 63l5 82" />
          </g>
          {[[64,67,13],[141,28,10],[225,63,15],[285,32,8],[121,130,12],[230,145,10],[279,131,14]].map(([cx, cy, r], index) => (
            <circle key={index} cx={cx} cy={cy} r={r} fill="white" fillOpacity={index === 2 ? ".95" : ".72"} />
          ))}
          <rect x="202" y="50" width="46" height="26" rx="8" fill="white" fillOpacity=".16" stroke="white" strokeOpacity=".7" />
        </g>
      )}
      {kind === "forecast" && (
        <g transform="translate(76 58)">
          <rect width="328" height="142" rx="18" fill="white" fillOpacity=".12" stroke="white" strokeOpacity=".28" />
          <path d="M30 111h269M30 78h269M30 45h269" stroke="white" strokeOpacity=".18" />
          <path d="m31 109 39-22 39 8 38-46 39 21 39-8 38-35 37 17" stroke="white" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          {[31,70,109,147,186,225,263,300].map((cx, index) => (
            <circle key={cx} cx={cx} cy={[109,87,95,49,70,62,27,44][index]} r="6" fill="white" />
          ))}
        </g>
      )}
      {kind === "funnel" && (
        <g transform="translate(117 55)">
          <path d="M0 0h246l-30 38H30z" fill="white" fillOpacity=".3" />
          <path d="M36 48h174l-28 38H64z" fill="white" fillOpacity=".48" />
          <path d="M72 96h102l-23 38H95z" fill="white" fillOpacity=".68" />
          <path d="M104 144h38v28l-19 15-19-15z" fill="white" />
          <g fill="white" fontFamily="sans-serif" fontSize="13" fontWeight="700" textAnchor="middle">
            <text x="123" y="25">检索记录</text><text x="123" y="73">去重</text><text x="123" y="121">纳排</text>
          </g>
        </g>
      )}
      {kind === "review" && (
        <g transform="translate(89 51)">
          <rect width="206" height="164" rx="14" fill="white" fillOpacity=".94" />
          <rect x="25" y="25" width="105" height="10" rx="5" fill="#7c3aed" fillOpacity=".42" />
          <rect x="25" y="49" width="154" height="7" rx="3.5" fill="#7c3aed" fillOpacity=".17" />
          <rect x="25" y="67" width="135" height="7" rx="3.5" fill="#7c3aed" fillOpacity=".17" />
          <rect x="25" y="91" width="155" height="32" rx="7" fill="#fce7f3" />
          <path d="M46 101h109M46 113h82" stroke="#db2777" strokeWidth="5" strokeLinecap="round" strokeOpacity=".62" />
          <path d="M185 79h96a12 12 0 0 1 12 12v50a12 12 0 0 1-12 12h-58l-18 17v-17h-20a12 12 0 0 1-12-12V91a12 12 0 0 1 12-12Z" fill="white" fillOpacity=".24" stroke="white" strokeOpacity=".76" />
          <path d="M196 101h70M196 116h48M196 131h58" stroke="white" strokeWidth="6" strokeLinecap="round" strokeOpacity=".82" />
        </g>
      )}
      {kind === "audit" && (
        <g transform="translate(91 57)">
          <rect width="298" height="151" rx="18" fill="white" fillOpacity=".12" stroke="white" strokeOpacity=".3" />
          {[0,1,2].map((row) => [0,1,2,3].map((col) => (
            <rect key={`${row}-${col}`} x={24 + col * 65} y={23 + row * 38} width="48" height="25" rx="8" fill="white" fillOpacity={col === 3 && row === 1 ? ".92" : ".2"} />
          )))}
          <path d="m231 83 8 8 17-20" stroke="#4338ca" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M28 137h242" stroke="white" strokeWidth="6" strokeLinecap="round" strokeOpacity=".58" />
        </g>
      )}
      {kind === "diff" && (
        <g transform="translate(77 53)">
          <rect width="326" height="159" rx="18" fill="#07111f" fillOpacity=".64" stroke="white" strokeOpacity=".26" />
          <circle cx="24" cy="21" r="5" fill="#fb7185" /><circle cx="42" cy="21" r="5" fill="#fbbf24" /><circle cx="60" cy="21" r="5" fill="#4ade80" />
          <path d="M27 56h72M114 56h93M27 82h56M99 82h165" stroke="#fb7185" strokeWidth="9" strokeLinecap="round" strokeOpacity=".78" />
          <path d="M27 111h91M133 111h137M27 137h55M97 137h105" stroke="#4ade80" strokeWidth="9" strokeLinecap="round" strokeOpacity=".85" />
          <text x="288" y="60" fill="#fb7185" fontFamily="monospace" fontSize="19">−</text><text x="288" y="117" fill="#4ade80" fontFamily="monospace" fontSize="19">+</text>
        </g>
      )}
      {kind === "delivery" && (
        <g transform="translate(72 62)">
          {[0,1,2].map((index) => (
            <g key={index} transform={`translate(${index * 116} 0)`}>
              <rect width="95" height="132" rx="15" fill="white" fillOpacity={.16 + index * .12} stroke="white" strokeOpacity=".32" />
              <rect x="15" y="18" width="54" height="8" rx="4" fill="white" fillOpacity=".86" />
              <rect x="15" y="44" width="65" height="25" rx="8" fill="white" fillOpacity=".2" />
              <rect x="15" y="79" width={index === 2 ? 65 : 50} height="25" rx="8" fill="white" fillOpacity={index === 2 ? ".88" : ".2"} />
            </g>
          ))}
          <path d="m99 66 10 0m106 0h10" stroke="white" strokeWidth="5" strokeLinecap="round" />
        </g>
      )}
      {kind === "tests" && (
        <g transform="translate(78 54)">
          <rect width="324" height="157" rx="18" fill="#0b1220" fillOpacity=".7" stroke="white" strokeOpacity=".28" />
          <path d="m25 45 14 13-14 13M51 71h48" stroke="white" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" opacity=".7" />
          <rect x="25" y="94" width="118" height="35" rx="10" fill="#ef4444" fillOpacity=".75" />
          <rect x="159" y="94" width="140" height="35" rx="10" fill="#22c55e" fillOpacity=".82" />
          <path d="m47 106 12 12m0-12-12 12" stroke="white" strokeWidth="4" strokeLinecap="round" />
          <path d="m179 112 7 7 15-17" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M79 112h43M211 112h67" stroke="white" strokeWidth="6" strokeLinecap="round" opacity=".8" />
        </g>
      )}
      {kind === "accessibility" && (
        <g transform="translate(92 48)">
          <rect width="208" height="164" rx="17" fill="white" fillOpacity=".93" />
          <rect x="19" y="20" width="170" height="13" rx="6" fill="#0f766e" fillOpacity=".23" />
          <rect x="19" y="52" width="76" height="72" rx="10" fill="#ccfbf1" />
          <rect x="108" y="52" width="81" height="15" rx="7" fill="#0f766e" fillOpacity=".25" />
          <rect x="108" y="78" width="68" height="10" rx="5" fill="#0f766e" fillOpacity=".14" />
          <rect x="108" y="99" width="81" height="25" rx="9" fill="#0f766e" />
          <rect x="232" y="29" width="83" height="141" rx="20" fill="white" fillOpacity=".25" stroke="white" strokeOpacity=".72" strokeWidth="3" />
          <rect x="246" y="48" width="55" height="58" rx="9" fill="white" fillOpacity=".84" />
          <rect x="246" y="119" width="55" height="22" rx="8" fill="white" fillOpacity=".9" />
          <circle cx="273" cy="157" r="5" fill="white" fillOpacity=".7" />
        </g>
      )}
      {kind === "dependencies" && (
        <g transform="translate(75 52)">
          {[[0,57],[116,0],[116,114],[232,57]].map(([x,y], index) => (
            <g key={index} transform={`translate(${x} ${y})`}>
              <rect width="94" height="52" rx="13" fill="white" fillOpacity={index === 3 ? ".88" : ".2"} stroke="white" strokeOpacity=".45" />
              <path d="M18 19h36M18 33h58" stroke={index === 3 ? "#c2410c" : "white"} strokeWidth="6" strokeLinecap="round" opacity=".8" />
            </g>
          ))}
          <path d="M94 83h35l24-40M129 83l24 57M210 26l22 57M210 140l22-57" stroke="white" strokeWidth="3" strokeOpacity=".62" />
          <path d="m263 81 8 8 17-19" stroke="#c2410c" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
      {kind === "actions" && (
        <g transform="translate(91 52)">
          <rect width="298" height="160" rx="18" fill="white" fillOpacity=".15" stroke="white" strokeOpacity=".32" />
          {[0,1,2].map((index) => (
            <g key={index} transform={`translate(22 ${22 + index * 43})`}>
              <circle cx="13" cy="13" r="13" fill="white" fillOpacity={index === 0 ? ".95" : ".35"} />
              {index === 0 && <path d="m7 13 4 4 8-9" stroke="#db2777" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}
              <rect x="42" y="5" width={index === 1 ? 124 : 98} height="8" rx="4" fill="white" fillOpacity=".84" />
              <rect x="42" y="19" width={index === 2 ? 162 : 184} height="6" rx="3" fill="white" fillOpacity=".35" />
              <circle cx="250" cy="13" r="13" fill="white" fillOpacity=".32" />
            </g>
          ))}
        </g>
      )}
      {kind === "brief" && (
        <g transform="translate(92 51)">
          <rect width="296" height="162" rx="18" fill="white" fillOpacity=".93" />
          <rect x="22" y="21" width="117" height="11" rx="5" fill="#ea580c" fillOpacity=".38" />
          <circle cx="77" cy="91" r="35" fill="#ffedd5" />
          <path d="M77 91V56a35 35 0 0 1 31 51Z" fill="#f97316" />
          <path d="M77 91 108 107a35 35 0 0 1-58 11Z" fill="#facc15" />
          {[0,1,2,3].map((index) => <rect key={index} x={144 + index * 29} y={119 - index * 18} width="18" height={23 + index * 18} rx="5" fill="#ea580c" fillOpacity={.3 + index * .16} />)}
          <rect x="142" y="49" width="110" height="8" rx="4" fill="#ea580c" fillOpacity=".18" />
          <rect x="142" y="66" width="83" height="8" rx="4" fill="#ea580c" fillOpacity=".18" />
        </g>
      )}
    </svg>
  );
}
