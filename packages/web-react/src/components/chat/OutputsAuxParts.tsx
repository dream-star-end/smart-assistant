/**
 * OutputsView 辅助子组件（QuickAnnotateDrawer / DownloadButton / WorkbenchEvidenceCard）。
 */
import { Download, Send, X } from "lucide-react";
import { Suspense, lazy, useEffect, useState } from "react";
import type { EvidenceManifest } from "@openclaude/protocol/research";
import { cn } from "../../lib/utils";
import { Button, IconButton, Skeleton, Spinner, useToast } from "../ui";
import { buildAnnotationPrompt } from "./deliverablePreview";
import { useSignedDownload, useSignedSrc } from "./media";
import type { DeliverableCategory } from "./workbench";

const ResearchEvidenceModule = lazy(() =>
  import("./researchEvidence").then((m) => ({
    default: function WorkbenchResearchEvidenceInner({ manifest }: { manifest: EvidenceManifest }) {
      const [evTab, setEvTab] = useState<"evidence" | "library">("evidence");
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3.5 py-2">
            <span className="text-meta font-medium text-fg">引用接地与文献核验</span>
            <m.CoverageBadge coverage={manifest.coverage} />
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => setEvTab("evidence")}
                className={cn(
                  "rounded-md px-2 py-0.5 text-caption font-medium transition-colors",
                  evTab === "evidence" ? "bg-accent-soft text-accent" : "text-muted hover:text-fg",
                )}
              >
                证据链
              </button>
              <button
                type="button"
                onClick={() => setEvTab("library")}
                className={cn(
                  "rounded-md px-2 py-0.5 text-caption font-medium transition-colors",
                  evTab === "library" ? "bg-accent-soft text-accent" : "text-muted hover:text-fg",
                )}
              >
                文献库 ({manifest.sources.length})
              </button>
            </div>
          </div>
          {evTab === "evidence" ? (
            <div className="px-3.5 pb-3">
              <m.GatesRow manifest={manifest} />
              <m.ClaimList manifest={manifest} />
            </div>
          ) : (
            <m.LiteratureLibraryPanel sources={manifest.sources} />
          )}
        </div>
      );
    },
  })),
);

function EvidenceFallback() {
  return (
    <div className="space-y-2 px-5 py-5">
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-5/6" />
    </div>
  );
}

export function DownloadButton({ path, name }: { path: string; name: string }) {
  const { state, start } = useSignedDownload(path, name);
  const busy = state.phase === "downloading";
  return (
    <button
      type="button"
      aria-label={`下载 ${name}`}
      title="下载"
      onClick={() => void start()}
      disabled={busy}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      {busy ? <Spinner size={13} /> : <Download size={15} />}
    </button>
  );
}

/** 非富预览视图（HTML / 代码 / 改动 / 媒体）的快捷批注回填条。 */
export function QuickAnnotateDrawer({
  filePath,
  fileName,
  category,
  onAnnotateToComposer,
  onClose,
}: {
  filePath: string;
  fileName: string;
  category: DeliverableCategory;
  onAnnotateToComposer?: (draft: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [comment, setComment] = useState("");
  const [lineRef, setLineRef] = useState("");

  const submit = async () => {
    const trimmed = comment.trim();
    if (!trimmed) return;
    const parsedLine = Number.parseInt(lineRef.trim(), 10);
    const prompt = buildAnnotationPrompt({
      filePath,
      fileName,
      category,
      anchor:
        category === "code" && Number.isFinite(parsedLine) && parsedLine > 0
          ? { kind: "code-line", lineStart: parsedLine }
          : { kind: "file" },
      comment: trimmed,
    });
    if (onAnnotateToComposer) {
      onAnnotateToComposer(prompt);
      toast("已填入输入框，可直接发送给助手", "success");
      setComment("");
      onClose();
      return;
    }
    try {
      await navigator.clipboard.writeText(prompt);
      toast("已复制批注修改指令，粘贴到输入框即可发送", "success");
      setComment("");
      onClose();
    } catch {
      toast("复制失败，请手动复制修改说明", "error");
    }
  };

  return (
    <div className="space-y-2 border-t border-border/70 bg-accent-soft/40 px-3.5 py-2.5" data-testid="hero-quick-annotate-box">
      <div className="flex items-center gap-2">
        <span className="text-caption font-medium text-accent">批注精修 · {fileName}</span>
        {category === "code" && (
          <input
            type="text"
            inputMode="numeric"
            value={lineRef}
            onChange={(e) => setLineRef(e.target.value)}
            placeholder="行号(可选)"
            aria-label="代码行号"
            className="h-7 w-24 rounded-md border border-border-control bg-surface px-2 text-base text-fg outline-none placeholder:text-faint focus:border-accent md:text-xs"
          />
        )}
        <span className="flex-1" />
        <IconButton size="sm" shape="square" aria-label="关闭批注" onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="输入要让助手修改的具体要求…"
        aria-label="修改要求"
        className="min-h-14 w-full resize-y rounded-md border border-border-control bg-surface px-2.5 py-1.5 text-base text-fg outline-none placeholder:text-faint focus:border-accent md:text-sm"
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button type="button" size="sm" variant="accent" disabled={!comment.trim()} onClick={() => void submit()}>
          <Send size={12} aria-hidden />
          {onAnnotateToComposer ? "回填到输入框" : "复制批注指令"}
        </Button>
      </div>
    </div>
  );
}

export function WorkbenchEvidenceCard({ manifestSrc }: { manifestSrc: string }) {
  const { url: signed } = useSignedSrc(manifestSrc);
  const [manifest, setManifest] = useState<EvidenceManifest | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setManifest(null);
    setFailed(false);
    if (!signed) return;
    let alive = true;
    fetch(signed)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((raw: unknown) => {
        if (!alive) return;
        const m = raw as Record<string, unknown> | null;
        if (
          m &&
          typeof m === "object" &&
          Array.isArray(m.claims) &&
          Array.isArray(m.quotes) &&
          Array.isArray(m.sources) &&
          m.coverage &&
          typeof m.coverage === "object"
        ) {
          setManifest(m as unknown as EvidenceManifest);
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [signed]);

  return (
    <section
      data-testid="outputs-evidence-panel"
      className="mx-4 mt-4 overflow-hidden rounded-xl border border-border/70 bg-surface shadow-soft"
    >
      {failed ? (
        <div className="px-4 py-3 text-meta text-muted">证据清单暂不可用（可能已过期或被清理）。</div>
      ) : !manifest ? (
        <div className="flex items-center gap-2 px-4 py-3 text-meta text-muted">
          <Spinner size={13} className="text-accent" />
          正在加载科研引用证据清单…
        </div>
      ) : (
        <Suspense fallback={<EvidenceFallback />}>
          <ResearchEvidenceModule manifest={manifest} />
        </Suspense>
      )}
    </section>
  );
}
