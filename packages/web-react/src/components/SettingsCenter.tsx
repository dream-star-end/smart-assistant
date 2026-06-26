import * as Dialog from "@radix-ui/react-dialog";
import { Monitor, Moon, Sparkles, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Theme } from "../hooks/useTheme";
import { BRAND } from "../lib/brand";
import type { Billing, BillingLedgerEntry, User } from "../lib/types";
import { cn, formatCny } from "../lib/utils";
import { Alert, Avatar, Button, IconButton, Input, Tabs } from "./ui";

const LEDGER_LABEL: Record<BillingLedgerEntry["type"], string> = {
  seed_grant: "初始额度",
  topup_test: "测试充值",
  charge: "对话扣费",
  refund: "退费",
  monthly_grant: "月度额度",
};

function ledgerTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

type Section = "account" | "preferences" | "about";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "account", label: "账户与计费" },
  { id: "preferences", label: "偏好" },
  { id: "about", label: "关于" },
];

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

/**
 * 设置中心：统一收敛账户与计费、偏好（外观主题）、关于三类设置。
 * 替代原先散落的 AccountPanel（计费/改密）+ 顶栏 ThemeToggle 各自为政的局面——
 * 主题状态由 App 经 props 注入，与顶栏快捷开关共享同一权威源（无并行镜像）。
 * 余额由后端按用量真实扣费驱动，本面板只读展示；在线充值（P3-3）后续接入。
 */
export function SettingsCenter({
  open,
  billing,
  user,
  theme,
  onClose,
  onSetTheme,
  onChangePassword,
  onReauth,
}: {
  open: boolean;
  billing: Billing | null;
  user: User | null;
  theme: Theme;
  onClose: () => void;
  onSetTheme: (t: Theme) => void;
  /** 改密：必须验当前密码；成功后后端撤销全部会话，须重新登录。 */
  onChangePassword?: (currentPassword: string, newPassword: string) => Promise<void>;
  /** 改密成功后回到登录（清鉴权）。 */
  onReauth?: () => void;
}) {
  const low = billing != null && billing.balanceCents <= 0;
  const [section, setSection] = useState<Section>("account");
  const [pwOpen, setPwOpen] = useState(false);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwDone, setPwDone] = useState(false);

  // 关闭面板时回到默认分区并重置改密表单（Radix 常驻渲染不 unmount，否则重开会残留已输入的敏感密码）。
  useEffect(() => {
    if (!open) {
      setSection("account");
      setPwOpen(false);
      setCur("");
      setNext("");
      setConfirm("");
      setPwErr(null);
      setPwBusy(false);
      setPwDone(false);
    }
  }, [open]);

  async function submitPw() {
    if (!onChangePassword) return;
    setPwErr(null);
    if (next !== confirm) {
      setPwErr("两次输入的新密码不一致");
      return;
    }
    setPwBusy(true);
    try {
      await onChangePassword(cur, next);
      setPwDone(true); // 成功：后端已撤销全部会话，提示重新登录。
    } catch (e) {
      setPwErr((e as Error).message || "修改失败，请重试");
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-fade" />
        {/* Radix Dialog 提供 Escape 关闭 + 焦点陷阱 + 焦点归还 + aria-modal（无障碍）。 */}
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-float focus:outline-none data-[state=open]:animate-in"
        >
          <div className="flex items-center justify-between px-5 py-4">
            <Dialog.Title className="text-[15px] font-semibold text-fg">设置</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton aria-label="关闭" variant="muted" size="sm" shape="square">
                <X size={17} />
              </IconButton>
            </Dialog.Close>
          </div>

          {/* 分区导航:无障碍分段 Tabs(原语层统一),默认落在「账户与计费」。 */}
          <div className="border-b border-border px-4 pb-3">
            <Tabs
              aria-label="设置分区"
              value={section}
              onValueChange={(v) => setSection(v as Section)}
              items={SECTIONS.map((s) => ({ value: s.id, label: s.label }))}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {section === "account" && (
              <div className="flex flex-col">
                <div className="px-5 py-4">
                  <div className="text-[12px] text-faint">{user?.displayName || "账户"} · 当前余额</div>
                  <div
                    className={cn(
                      "mt-1 text-[28px] font-semibold tracking-tight",
                      low ? "text-danger" : "text-fg",
                    )}
                  >
                    {billing ? formatCny(billing.balanceCents) : "—"}
                  </div>
                  {low && (
                    <Alert tone="danger" className="mt-2 text-[12.5px]">
                      余额不足，已暂停对话计费。请联系管理员充值后继续。
                    </Alert>
                  )}
                  <div className="mt-1 text-[12px] text-faint">
                    按所选智能体的实际用量计量扣费。在线充值即将上线，当前由管理员发放额度。
                  </div>
                </div>

                <div className="border-t border-border px-5 py-3">
                  <div className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
                    账单流水
                  </div>
                  {!billing || billing.ledger.length === 0 ? (
                    <p className="py-6 text-center text-[13px] text-faint">暂无账单记录</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {billing.ledger.map((e) => (
                        <li
                          key={e.id}
                          className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13.5px] text-fg">
                              {LEDGER_LABEL[e.type] || e.type}
                            </span>
                            <span className="block truncate text-[11.5px] text-faint">
                              {ledgerTime(e.createdAt)} · 余 {formatCny(e.balanceAfterCents)}
                            </span>
                          </span>
                          <span
                            className={cn(
                              "shrink-0 text-[13.5px] font-medium tabular-nums",
                              e.amountCents < 0 ? "text-fg" : "text-success",
                            )}
                          >
                            {e.amountCents >= 0 ? "+" : ""}
                            {formatCny(e.amountCents)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {onChangePassword && (
                  <div className="border-t border-border px-5 py-3">
                    {!pwOpen ? (
                      <Button
                        variant="link"
                        onClick={() => setPwOpen(true)}
                        className="h-auto justify-start p-0 text-[13px] font-medium"
                      >
                        修改密码
                      </Button>
                    ) : pwDone ? (
                      <div className="flex flex-col gap-2">
                        <p className="text-[13.5px] text-fg">
                          密码已修改成功。为保护账户，所有设备已退出登录，请用新密码重新登录。
                        </p>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => onReauth?.()}
                          className="self-start"
                        >
                          去登录
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <div className="pb-1 text-[11px] font-medium uppercase tracking-wide text-faint">
                          修改密码
                        </div>
                        <Input
                          type="password"
                          autoComplete="current-password"
                          value={cur}
                          onChange={(e) => setCur(e.target.value)}
                          placeholder="当前密码"
                          className="h-auto bg-bg px-3 py-2 text-[13.5px]"
                        />
                        <Input
                          type="password"
                          autoComplete="new-password"
                          value={next}
                          onChange={(e) => setNext(e.target.value)}
                          placeholder="新密码（至少 15 个字符）"
                          className="h-auto bg-bg px-3 py-2 text-[13.5px]"
                        />
                        <Input
                          type="password"
                          autoComplete="new-password"
                          value={confirm}
                          onChange={(e) => setConfirm(e.target.value)}
                          placeholder="确认新密码"
                          className="h-auto bg-bg px-3 py-2 text-[13.5px]"
                        />
                        {pwErr && <p className="text-[12.5px] text-danger">{pwErr}</p>}
                        <div className="flex items-center gap-2">
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={submitPw}
                            disabled={pwBusy || !cur || !next || !confirm}
                          >
                            {pwBusy ? "提交中…" : "确认修改"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setPwOpen(false);
                              setPwErr(null);
                            }}
                            className="text-muted"
                          >
                            取消
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {section === "preferences" && (
              <div className="px-5 py-4">
                <div className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
                  外观主题
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {THEME_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      onClick={() => onSetTheme(o.value)}
                      aria-pressed={theme === o.value}
                      className={cn(
                        "flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                        theme === o.value
                          ? "border-accent bg-accent-soft text-accent"
                          : "border-border text-muted hover:bg-hover hover:text-fg",
                      )}
                    >
                      <o.icon size={18} />
                      {o.label}
                    </button>
                  ))}
                </div>
                <p className="mt-3 text-[12px] text-faint">
                  「跟随系统」会随设备的浅色/深色偏好自动切换。
                </p>
              </div>
            )}

            {section === "about" && (
              <div className="px-5 py-5">
                <div className="flex items-center gap-3">
                  <Avatar tone="brand" size="lg" shape="square" className="shadow-sm">
                    <Sparkles size={22} />
                  </Avatar>
                  <div>
                    <div className="text-[16px] font-semibold text-fg">{BRAND.name}</div>
                    <div className="text-[12.5px] text-faint">{BRAND.slogan}</div>
                  </div>
                </div>
                <p className="mt-4 text-[13.5px] leading-relaxed text-muted">{BRAND.intro}</p>
                <dl className="mt-4 flex flex-col gap-2 text-[12.5px]">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="shrink-0 text-faint">运营主体</dt>
                    <dd className="truncate text-fg">{BRAND.company}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="shrink-0 text-faint">备案</dt>
                    <dd className="truncate text-fg">{BRAND.icp}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="shrink-0 text-faint">客户端</dt>
                    <dd className="truncate text-fg">{BRAND.name} Web · © {BRAND.year}</dd>
                  </div>
                </dl>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
