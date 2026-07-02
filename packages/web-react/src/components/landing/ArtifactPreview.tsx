import { Check, FileDown, Link2, Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";
import type { Artifact } from "./demoScripts";

/**
 * 演示区右栏「成果预览」—— 把交付物画出来（迷你图表 / PPT 缩略 / 岗位表 /
 * 代码 diff / 协作账本 / 带来源报告），让「交回能直接用的成果」有视觉证据。
 * working 阶段呈现骨架占位（助手干活中），done 阶段揭示完整成果。
 * 配色纪律：数据标记只用「强调色 + 中性灰」两档，文字一律走文本 token。
 */
export function ArtifactPreview({
  artifact,
  deliverable,
  done,
}: {
  artifact: Artifact;
  deliverable?: string;
  done: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 面板头：交付物文件名 + 状态 */}
      <div className="flex items-center gap-2 border-b border-border bg-sidebar/40 px-3.5 py-2.5">
        <FileDown size={14} className="shrink-0 text-accent" />
        <span className="truncate text-[12.5px] font-medium text-fg">
          {deliverable ?? artifact.title}
        </span>
        <span
          className={cn(
            "ml-auto inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
            done ? "bg-success-soft text-success" : "bg-accent-soft text-accent",
          )}
        >
          {done ? (
            <>
              <Check size={11} /> 已生成
            </>
          ) : (
            <>
              <Loader2 size={11} className="animate-spin" /> 生成中
            </>
          )}
        </span>
      </div>

      <div className="relative min-h-[230px] flex-1 p-3.5">
        {done ? (
          <div className="animate-in">
            <ArtifactBody artifact={artifact} />
          </div>
        ) : (
          <ArtifactSkeleton />
        )}
      </div>
    </div>
  );
}

/** 干活中的骨架占位：几条脉动灰块，暗示成果正在成形。 */
function ArtifactSkeleton() {
  return (
    <div className="flex h-full flex-col gap-2.5" aria-hidden>
      <div className="h-3.5 w-2/5 animate-pulse rounded-md bg-hover" />
      {[82, 64, 74, 52].map((w, i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded-md bg-hover"
          style={{ width: `${w}%`, animationDelay: `${i * 150}ms` }}
        />
      ))}
      <div className="mt-auto h-3 w-1/3 animate-pulse rounded-md bg-hover" />
    </div>
  );
}

function ArtifactBody({ artifact }: { artifact: Artifact }) {
  switch (artifact.kind) {
    case "chart":
      return <ChartMock a={artifact} />;
    case "slides":
      return <SlidesMock a={artifact} />;
    case "table":
      return <TableMock a={artifact} />;
    case "diff":
      return <DiffMock a={artifact} />;
    case "board":
      return <BoardMock a={artifact} />;
    case "report":
      return <ReportMock a={artifact} />;
  }
}

/** 成果标题 + 底部结论行（各 mock 通用）。 */
function MockFrame({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[12px] font-semibold text-fg">{title}</p>
      {children}
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-accent">
        <Check size={12} className="shrink-0" />
        {note}
      </p>
    </div>
  );
}

/** 迷你横向条形图：单一强调色标重点层，其余灰阶，数值直标。 */
function ChartMock({ a }: { a: Extract<Artifact, { kind: "chart" }> }) {
  const max = Math.max(...a.bars.map((b) => b.value));
  return (
    <MockFrame title={a.title} note={a.note}>
      <div className="flex flex-col gap-1.5">
        {a.bars.map((b, i) => (
          <div key={b.label} className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-right text-[10.5px] text-muted">{b.label}</span>
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-hover">
              <div
                className={cn(
                  "chart-bar-grow h-full rounded-full",
                  b.tier === "hot" && "bg-accent",
                  b.tier === "mid" && "bg-faint/70",
                  b.tier === "dim" && "bg-faint/35",
                )}
                style={{ width: `${(b.value / max) * 100}%`, animationDelay: `${i * 60}ms` }}
              />
            </div>
            <span
              className={cn(
                "w-8 shrink-0 text-[10.5px] tabular-nums",
                b.tier === "hot" ? "font-semibold text-fg" : "text-faint",
              )}
            >
              {b.value}%
            </span>
          </div>
        ))}
      </div>
    </MockFrame>
  );
}

/** PPT 缩略：2×2 迷你 16:9 页面。 */
function SlidesMock({ a }: { a: Extract<Artifact, { kind: "slides" }> }) {
  return (
    <MockFrame title={a.title} note={a.note}>
      <div className="grid grid-cols-2 gap-2">
        {a.pages.map((p, i) => (
          <div
            key={p.h}
            className="flex aspect-video flex-col justify-center gap-1 rounded-lg border border-border bg-bg px-2.5 py-1.5"
          >
            {p.body === "cover" ? (
              <>
                <span className="h-1 w-6 rounded-full bg-accent" />
                <span className="text-[10px] font-bold leading-tight text-fg">{p.h}</span>
                {p.sub && <span className="text-[7.5px] text-faint">{p.sub}</span>}
              </>
            ) : (
              <>
                <span className="text-[8.5px] font-semibold text-fg">
                  {i + 1} · {p.h}
                </span>
                {p.body === "chart" && (
                  <span className="flex h-6 items-end gap-1">
                    {[38, 70, 46, 88, 58].map((h, j) => (
                      <span
                        key={j}
                        className={cn("w-2 rounded-t-sm", h > 80 ? "bg-accent" : "bg-faint/40")}
                        style={{ height: `${h}%` }}
                      />
                    ))}
                  </span>
                )}
                {p.body === "table" && (
                  <span className="flex flex-col gap-[3px]">
                    {[0, 1, 2].map((r) => (
                      <span key={r} className="flex gap-[3px]">
                        <span className="h-[5px] w-1/4 rounded-sm bg-hover" />
                        <span className="h-[5px] flex-1 rounded-sm bg-hover" />
                        <span className={cn("h-[5px] w-1/5 rounded-sm", r === 0 ? "bg-accent/50" : "bg-hover")} />
                      </span>
                    ))}
                  </span>
                )}
                {p.body === "lines" && (
                  <span className="flex flex-col gap-[3px]">
                    {[92, 78, 60].map((w, j) => (
                      <span key={j} className="h-[5px] rounded-sm bg-hover" style={{ width: `${w}%` }} />
                    ))}
                  </span>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </MockFrame>
  );
}

/** 岗位/数据表格 mock。 */
function TableMock({ a }: { a: Extract<Artifact, { kind: "table" }> }) {
  return (
    <MockFrame title={a.title} note={a.note}>
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="bg-sidebar/60">
              {a.head.map((h) => (
                <th key={h} className="px-2 py-1.5 text-[10px] font-medium text-muted">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {a.rows.map((r) => (
              <tr key={r[1]} className="border-t border-border">
                {r.map((c, j) => (
                  <td
                    key={j}
                    className={cn(
                      "px-2 py-1.5 text-[10.5px]",
                      j === 0
                        ? "font-semibold text-accent"
                        : j === r.length - 1
                          ? "font-semibold tabular-nums text-fg"
                          : "text-muted",
                    )}
                  >
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </MockFrame>
  );
}

/** 代码 diff mock：等宽 + 增删行底色（success/danger token）。 */
function DiffMock({ a }: { a: Extract<Artifact, { kind: "diff" }> }) {
  return (
    <MockFrame title={a.title} note={a.note}>
      <div className="overflow-hidden rounded-lg border border-border bg-code">
        <div className="border-b border-border px-2.5 py-1.5 font-mono text-[9.5px] text-faint">
          {a.file}
        </div>
        <div className="flex flex-col px-1 py-1 font-mono text-[10.5px] leading-[1.7]">
          {a.lines.map((l) => (
            <span
              key={l.code}
              className={cn(
                "truncate rounded-sm px-1.5",
                l.t === "add" && "bg-success-soft text-success",
                l.t === "del" && "bg-danger-soft text-danger line-through",
                l.t === "ctx" && "text-faint",
              )}
            >
              {l.code}
            </span>
          ))}
        </div>
      </div>
    </MockFrame>
  );
}

/** 团队协作子任务账本 mock。 */
function BoardMock({ a }: { a: Extract<Artifact, { kind: "board" }> }) {
  return (
    <MockFrame title={a.title} note={a.note}>
      <div className="flex flex-col gap-1.5">
        {a.tasks.map((t) => (
          <div
            key={t.role}
            className="flex items-center gap-2.5 rounded-lg border border-border bg-bg px-2.5 py-2"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-[10px] font-bold text-accent">
              {t.role.slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[10.5px] font-semibold text-fg">{t.role}</span>
              <span className="block truncate text-[10px] text-muted">{t.task}</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success-soft px-1.5 py-0.5 text-[9.5px] font-medium text-success">
              <Check size={10} /> {t.state}
            </span>
          </div>
        ))}
      </div>
    </MockFrame>
  );
}

/** 带来源的调研报告 mock。 */
function ReportMock({ a }: { a: Extract<Artifact, { kind: "report" }> }) {
  return (
    <MockFrame title={a.title} note={a.note}>
      <div className="rounded-lg border border-border bg-bg p-3">
        <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[9.5px] font-medium text-accent">
          <Link2 size={10} /> {a.sources}
        </span>
        <ul className="mt-2 flex flex-col gap-1.5">
          {a.bullets.map((b) => (
            <li key={b.text} className="flex items-baseline gap-1.5 text-[11px] leading-snug">
              <span className="size-1 shrink-0 translate-y-[-2px] rounded-full bg-accent" />
              <span className="text-muted">{b.text}</span>
              <span className="shrink-0 font-mono text-[9px] text-accent">{b.refs}</span>
            </li>
          ))}
        </ul>
      </div>
    </MockFrame>
  );
}
