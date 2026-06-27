import { Download, Loader2, ShieldCheck, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import type { AuthSession, MarketplaceDetail } from "../../lib/types";
import { Alert, Badge, Button, Modal } from "../ui";
import { friendlyRiskFlags } from "./riskFlags";

/**
 * 市场条目详情 + 安装确认。展示完整 SKILL.md(用户安装前看清「装的到底是什么」),
 * 一键安装。已安装则展示状态、可前往「已安装」卸载。
 */
export function DetailModal({
  slug,
  auth,
  installed,
  onClose,
  onInstalled,
}: {
  slug: string | null;
  auth: AuthSession;
  installed: boolean;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const [detail, setDetail] = useState<MarketplaceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!slug) {
      setDetail(null);
      setErr(null);
      setDone(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setErr(null);
    setDone(false);
    api
      .getMarketplaceDetail(auth, slug)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setErr((e as Error).message || "加载详情失败"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [slug, auth]);

  const install = async () => {
    if (!detail) return;
    setInstalling(true);
    setErr(null);
    try {
      await api.installMarketplace(auth, detail.versionId);
      setDone(true);
      onInstalled();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message || "安装失败");
    } finally {
      setInstalling(false);
    }
  };

  const warns = friendlyRiskFlags(detail?.riskFlags);

  return (
    <Modal
      open={!!slug}
      onOpenChange={(o) => !o && onClose()}
      title={detail?.name ?? "技能详情"}
      description={detail ? `${detail.slug} · v${detail.version}` : undefined}
      footer={
        detail && (
          <>
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
            {installed && !done ? (
              <Badge tone="success" className="self-center">
                <ShieldCheck size={13} /> 已安装
              </Badge>
            ) : done ? (
              <Badge tone="success" className="self-center">
                <ShieldCheck size={13} /> 安装成功
              </Badge>
            ) : (
              <Button variant="primary" onClick={install} disabled={installing}>
                {installing ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                安装
              </Button>
            )}
          </>
        )
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-faint">
          <Loader2 size={16} className="animate-spin" /> 加载详情…
        </div>
      ) : err && !detail ? (
        <Alert tone="danger">{err}</Alert>
      ) : detail ? (
        <div className="flex flex-col gap-3">
          {err && <Alert tone="danger">{err}</Alert>}
          {done && (
            <Alert tone="success" title="已安装">
              将在你的下一次会话中对 AI 可用。
            </Alert>
          )}
          <p className="text-[13.5px] leading-relaxed text-fg">{detail.description}</p>

          <div className="flex flex-wrap items-center gap-1.5">
            {detail.tags.map((t) => (
              <Badge key={t} tone="accent">
                {t}
              </Badge>
            ))}
            <Badge tone="neutral">
              <Users size={12} /> {detail.installCount} 人在用
            </Badge>
          </div>

          {warns.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {warns.map((w) => (
                <Alert key={w.label} tone={w.tone}>
                  <span className="font-medium">{w.label}：</span>
                  {w.message}
                </Alert>
              ))}
            </div>
          )}

          <div>
            <div className="mb-1.5 text-[12px] font-medium text-muted">完整内容（SKILL.md）</div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-code px-3 py-2 font-mono text-[12px] leading-relaxed text-fg">
              {detail.rawSkillMd}
            </pre>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
