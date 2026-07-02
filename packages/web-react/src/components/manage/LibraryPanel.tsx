import { BookOpen, Loader2, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import type { AuthSession, ResearchLibraryDoc } from "../../lib/types";
import { Alert, Button, EmptyState, PanelHeader, Spinner, useConfirm } from "../ui";

const LANG_LABEL: Record<string, string> = { zh: "中文", en: "英文", other: "其他" };

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * 文献库中心:列出已入库的权威文档(oc-ingest / UI 上传统一落 research_documents),
 * 支持上传 PDF/文本入库与删除。数据在 master(非容器代理):/api/me/research/library*。
 * 删除语义:已生成报告的历史引用不受影响;之后再 cite/check 回查不到该文档会按
 * fail-closed 判未核查 —— 与"证据必须可回查"的红线一致。
 */
export function LibraryPanel({ auth }: { auth: AuthSession }) {
  const [docs, setDocs] = useState<ResearchLibraryDoc[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [reload, setReload] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const [confirmDialog, confirmDialogEl] = useConfirm();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .listResearchLibrary(auth)
      .then((d) => {
        if (alive) setDocs(d);
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message || "加载文献库失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, reload]);

  const refresh = useCallback(() => setReload((n) => n + 1), []);

  const onUpload = useCallback(
    async (file: File) => {
      setUploading(true);
      setErr(null);
      setNotice(null);
      try {
        const r = await api.uploadResearchDoc(auth, file);
        if (r.needsOcr) {
          setNotice(
            `「${file.name}」是扫描件(无文字层),当前无法自动入库;可先用其他工具 OCR 后再上传。`,
          );
        } else {
          setNotice(`「${r.title || file.name}」已入库(${r.spanCount ?? 0} 个片段)。`);
          refresh();
        }
      } catch (e) {
        setErr((e as Error).message || "上传入库失败");
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [auth, refresh],
  );

  const remove = useCallback(
    async (doc: ResearchLibraryDoc) => {
      const ok = await confirmDialog({
        title: `删除文献「${doc.title || doc.docId.slice(0, 12)}」?`,
        body: "删除后新的引用核查将无法回查到该文档;已生成的报告不受影响。",
        confirmText: "删除",
        danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteResearchDoc(auth, doc.docId);
        refresh();
      } catch (e) {
        setErr((e as Error).message || "删除失败");
      }
    },
    [auth, confirmDialog, refresh],
  );

  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <PanelHeader
        title="文献库"
        hint="已入库的权威文档(报告引用证据从这里回查)。支持 PDF / TXT / Markdown / HTML,上限 25MB。"
        action={
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.txt,.md,.markdown,.html,.htm"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onUpload(f);
              }}
            />
            <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              上传入库
            </Button>
          </>
        }
      />

      {err && <Alert tone="danger">{err}</Alert>}
      {notice && <Alert tone="info">{notice}</Alert>}

      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : !docs || docs.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="文献库为空"
          hint="上传 PDF 入库,或在对话里让科研助手检索并入库文献。"
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {docs.map((d) => (
            <li key={d.docId} className="flex items-center gap-3 px-3.5 py-2.5">
              <BookOpen size={15} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] text-fg">{d.title || "(无标题文档)"}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-faint">
                  <span>{LANG_LABEL[d.lang] ?? d.lang}</span>
                  <span>{d.spanCount} 个片段</span>
                  <span>{fmtTime(d.createdAt)}</span>
                  <span className="font-mono">{d.docId.slice(0, 12)}</span>
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label="删除文献"
                onClick={() => void remove(d)}
              >
                <Trash2 size={14} className="text-danger" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {confirmDialogEl}
    </div>
  );
}
