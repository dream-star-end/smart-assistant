import { ExternalLink, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type ChatGptProxyAccess, type ChatGptProxyCredential } from "../lib/api";
import type { AuthSession } from "../lib/types";
import { Alert, Button, buttonVariants, CopyChip, Modal, Spinner, Tabs, useConfirm } from "./ui";

type Enabled = Extract<ChatGptProxyAccess, { enabled: true }>;

type GuideTab = "chrome" | "firefox" | "switchy";

const GUIDE_TABS: { value: GuideTab; label: string }[] = [
  { value: "chrome", label: "Chrome / Edge" },
  { value: "firefox", label: "Firefox" },
  { value: "switchy", label: "SwitchyOmega" },
];

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/**
 * 「ChatGPT 直连」面板:展示平台下发的鉴权 HTTPS 代理 + PAC 地址,以及本账号的代理凭据。
 *
 * 密码明文只在生成 / 轮换的那一次响应里出现,面板关闭即丢;忘了就重新生成。
 * 未授权账号不会拿到 enabled:true —— 调用方(App)只在 enabled 时挂载本组件与菜单入口。
 */
export function ChatGptProxyDialog({
  open,
  onOpenChange,
  auth,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  auth: AuthSession;
}) {
  const [access, setAccess] = useState<Enabled | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<ChatGptProxyCredential | null>(null);
  const [guide, setGuide] = useState<GuideTab>("chrome");
  const [confirm, confirmNode] = useConfirm();

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await api.getChatGptProxyAccess(auth);
      setAccess(next.enabled ? next : null);
      if (!next.enabled) setError("当前账号未被授权使用 ChatGPT 直连");
    } catch (err) {
      setError((err as Error).message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [auth]);

  useEffect(() => {
    if (!open) return;
    setIssued(null);
    void reload();
  }, [open, reload]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message || "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const issue = async () => {
    if (access?.hasCredential) {
      const ok = await confirm({
        title: "重新生成凭据?",
        body: "旧密码立即失效,所有已配置该密码的浏览器需要重新填写。",
        confirmText: "重新生成",
      });
      if (ok !== true) return;
    }
    await run(async () => {
      const cred = await api.createChatGptProxyCredential(auth);
      setIssued(cred);
      setAccess((prev) =>
        prev
          ? {
              ...prev,
              hasCredential: true,
              rotatedAt: cred.rotatedAt,
              createdAt: prev.createdAt ?? cred.rotatedAt,
            }
          : prev,
      );
    });
  };

  const revoke = async () => {
    const ok = await confirm({
      title: "吊销凭据?",
      body: "吊销后当前密码立即失效,ChatGPT 直连将无法使用,直到重新生成。",
      confirmText: "吊销",
      danger: true,
    });
    if (ok !== true) return;
    await run(async () => {
      await api.revokeChatGptProxyCredential(auth);
      setIssued(null);
      setAccess((prev) => (prev ? { ...prev, hasCredential: false, lastUsedAt: null } : prev));
    });
  };

  const proxyAddr = access ? `${access.proxyHost}:${access.proxyPort}` : "";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-lg"
      title="ChatGPT 直连"
      description="用你自己的浏览器,经平台代理访问 chatgpt.com。仅 ChatGPT 相关域名走代理,其余网站不受影响。"
      footer={
        access ? (
          <div className="flex w-full items-center justify-between gap-2">
            <span className="text-caption text-muted">配置完成后打开:</span>
            <a
              href={access.homeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "accent", size: "sm" })}
            >
              <ExternalLink size={14} />
              打开 chatgpt.com
            </a>
          </div>
        ) : undefined
      }
    >
      {confirmNode}
      {loading && !access && (
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      )}
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      {access && (
        <div className="space-y-4">
          <section className="rounded-lg border border-border bg-hover/40 p-3">
            <h3 className="mb-2 text-caption font-medium text-muted">连接信息</h3>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-body">
              <dt className="text-muted">PAC 地址</dt>
              <dd className="min-w-0">
                <CopyChip value={access.pacUrl} className="max-w-full" />
              </dd>
              <dt className="text-muted">代理服务器</dt>
              <dd className="min-w-0">
                <CopyChip value={proxyAddr} label={`HTTPS ${proxyAddr}`} />
              </dd>
              <dt className="text-muted">用户名</dt>
              <dd className="min-w-0">
                <CopyChip value={access.username} />
              </dd>
              <dt className="text-muted">密码</dt>
              <dd className="min-w-0">
                {issued ? (
                  <div className="space-y-1">
                    <CopyChip value={issued.password} />
                    <p className="text-caption text-warning">密码只显示这一次,请立即复制保存。</p>
                  </div>
                ) : access.hasCredential ? (
                  <span className="text-caption text-muted">
                    已生成于 {formatTime(access.rotatedAt)} · 最近使用{" "}
                    {formatTime(access.lastUsedAt)}
                  </span>
                ) : (
                  <span className="text-caption text-muted">尚未生成</span>
                )}
              </dd>
            </dl>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant={access.hasCredential ? "secondary" : "primary"}
                disabled={busy}
                onClick={issue}
              >
                {access.hasCredential ? <RefreshCw size={13} /> : <KeyRound size={13} />}
                {access.hasCredential ? "重新生成密码" : "生成密码"}
              </Button>
              {access.hasCredential && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={revoke}>
                  <Trash2 size={13} />
                  吊销
                </Button>
              )}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-caption font-medium text-muted">浏览器配置</h3>
            <Tabs
              value={guide}
              onValueChange={(v) => setGuide(v as GuideTab)}
              items={GUIDE_TABS}
              layout="grid"
            />
            <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-body text-fg">
              {guide === "chrome" && (
                <>
                  <li>
                    打开系统代理设置(Chrome / Edge 使用系统代理):Windows「设置 → 网络和 Internet →
                    代理 → 使用设置脚本」;macOS「系统设置 → 网络 → 详细信息 → 代理 →
                    自动代理配置」。
                  </li>
                  <li>
                    脚本地址填上面的 <span className="font-mono">PAC 地址</span>,保存。
                  </li>
                  <li>
                    访问 chatgpt.com 时浏览器会弹出代理登录框,填写上面的<strong>用户名</strong>与
                    <strong>密码</strong>并勾选记住。
                  </li>
                  <li>之后只有 ChatGPT 相关域名经代理转发,其余网站直连。</li>
                </>
              )}
              {guide === "firefox" && (
                <>
                  <li>Firefox「设置 → 常规 → 网络设置 → 设置…」。</li>
                  <li>
                    选「自动代理配置的 URL(PAC)」,填上面的{" "}
                    <span className="font-mono">PAC 地址</span>,确定。
                  </li>
                  <li>
                    访问 chatgpt.com 时按提示输入<strong>用户名</strong>与<strong>密码</strong>
                    ,可勾选「使用密码管理器记住」。
                  </li>
                </>
              )}
              {guide === "switchy" && (
                <>
                  <li>安装 Proxy SwitchyOmega 扩展,新建「代理服务器」情景模式。</li>
                  <li>
                    协议选 <strong>HTTPS</strong>,服务器 / 端口填上面的<strong>代理服务器</strong>
                    ;点击右侧锁图标填写<strong>用户名</strong>与<strong>密码</strong>。
                  </li>
                  <li>
                    在「自动切换」里添加规则:<span className="font-mono">*.chatgpt.com</span>、
                    <span className="font-mono">*.openai.com</span>、
                    <span className="font-mono">*.oaistatic.com</span>、
                    <span className="font-mono">*.oaiusercontent.com</span> →
                    该情景;默认情景保持「直接连接」。
                  </li>
                  <li>
                    或者更省事:新建「PAC 情景模式」,PAC 网址填上面的{" "}
                    <span className="font-mono">PAC 地址</span>,再在 PAC 情景里设置凭据。
                  </li>
                </>
              )}
            </ol>
            <p className="mt-3 text-caption text-muted">
              代理只放行 ChatGPT 及其登录依赖域名的 443 端口,不能作为通用代理使用。
            </p>
          </section>
        </div>
      )}
    </Modal>
  );
}
