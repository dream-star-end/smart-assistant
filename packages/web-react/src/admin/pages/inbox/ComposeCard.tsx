import { Send } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
  Button,
  Input,
  Switch,
  Tabs,
  Textarea,
  useConfirm,
  useToast,
} from "../../../components/ui";
import { SectionCard, SelectFilter } from "../../components";
import { adminGet, adminSend, apiErrorMessage } from "../../lib/adminApi";
import {
  type CreateMessagePayload,
  type EmailConfig,
  type InboxAudience,
  INBOX_LEVEL_LABELS,
  type InboxLevel,
} from "./types";

const AUDIENCE_TABS = [
  { value: "all", label: "全员广播" },
  { value: "user", label: "单个用户" },
];

const LEVEL_OPTIONS: { label: string; value: InboxLevel }[] = (
  Object.keys(INBOX_LEVEL_LABELS) as InboxLevel[]
).map((l) => ({ label: INBOX_LEVEL_LABELS[l], value: l }));

const USER_ID_RE = /^[1-9]\d{0,19}$/;

/** 站内信发送卡：全员/单人 + 级别 + 标题 + Markdown 正文 + 可选过期 + 邮件同发（探测 worker 状态）。 */
export function ComposeCard({ onSent }: { onSent: () => void }) {
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();

  const [audience, setAudience] = useState<InboxAudience>("all");
  const [userId, setUserId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [level, setLevel] = useState<InboxLevel>("info");
  const [expires, setExpires] = useState("");
  const [notifyEmail, setNotifyEmail] = useState(false);
  const [busy, setBusy] = useState(false);

  const [emailCfg, setEmailCfg] = useState<EmailConfig | null>(null);
  const [emailHint, setEmailHint] = useState("加载中…");

  useEffect(() => {
    let alive = true;
    adminGet<EmailConfig>("/messages/email-config")
      .then((cfg) => {
        if (!alive) return;
        setEmailCfg(cfg);
        if (cfg.enabled === false) {
          setEmailHint("邮件 worker 已禁用（COMMERCIAL_INBOX_EMAIL_DISABLED=1），勾选无效。");
        } else if (cfg.provider === "stub") {
          setEmailHint("当前为 stub mailer（未配 RESEND_API_KEY），邮件只打日志，不真发出。");
        } else {
          setEmailHint(`已启用，provider=${cfg.provider}。勾选后同事务锁定快照，异步发送。`);
        }
      })
      .catch((e) => {
        if (!alive) return;
        setEmailCfg({ enabled: false, provider: "stub" });
        setEmailHint(`探测邮件配置失败：${apiErrorMessage(e, "请求失败")}`);
      });
    return () => {
      alive = false;
    };
  }, []);

  const emailDisabled = emailCfg?.enabled === false;

  const send = async () => {
    const t = title.trim();
    if (!t) {
      toast("标题不能为空", "error");
      return;
    }
    if (!body.trim()) {
      toast("正文不能为空", "error");
      return;
    }
    if (audience === "user" && !USER_ID_RE.test(userId.trim())) {
      toast("user_id 必须是正整数", "error");
      return;
    }
    let expiresAt: string | undefined;
    if (expires) {
      const d = new Date(expires);
      if (Number.isNaN(d.getTime())) {
        toast("过期时间格式不对", "error");
        return;
      }
      expiresAt = d.toISOString();
    }

    const ok = await confirm({
      title: audience === "all" ? "向全体用户发送站内信？" : `向用户 #${userId.trim()} 发送站内信？`,
      body:
        notifyEmail && !emailDisabled
          ? "将同时向快照内已验证用户发送邮件，操作不可撤销。"
          : "站内信发出后用户铃铛即可拉取。",
      confirmText: "发送",
    });
    if (!ok) return;

    const payload: CreateMessagePayload = { audience, title: t, body_md: body, level };
    if (audience === "user") payload.user_id = userId.trim();
    if (expiresAt) payload.expires_at = expiresAt;
    if (notifyEmail && !emailDisabled) payload.notify_email = true;

    setBusy(true);
    try {
      const r = await adminSend<{ message?: { notify_email?: boolean; email_summary?: { total?: number } } }>(
        "POST",
        "/messages",
        payload,
      );
      if (r?.message?.notify_email) {
        const total = r.message.email_summary?.total ?? 0;
        toast(`已发送，邮件 worker 将异步发出 ${total} 封`, "success");
      } else {
        toast("已发送", "success");
      }
      // 保留 audience / level / user_id / notify_email 方便连发
      setTitle("");
      setBody("");
      setExpires("");
      onSent();
    } catch (e) {
      toast(apiErrorMessage(e, "发送失败"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard title="新建站内信" hint="admin 写入 → 用户铃铛实时拉取">
      {confirmEl}
      <div className="flex flex-col gap-4">
        <Field label="收件范围">
          <Tabs
            value={audience}
            onValueChange={(v) => setAudience(v as InboxAudience)}
            items={AUDIENCE_TABS}
            aria-label="收件范围"
          />
        </Field>

        {audience === "user" && (
          <Field label="user_id">
            <Input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="例如 1234"
              inputMode="numeric"
              className="sm:w-56"
            />
          </Field>
        )}

        <Field label="标题">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="≤200 字"
          />
        </Field>

        <Field label="正文（Markdown）">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            maxLength={16384}
            placeholder="支持完整 Markdown，最长 16KB"
          />
        </Field>

        <div className="flex flex-wrap gap-4">
          <Field label="级别">
            <SelectFilter
              value={level}
              options={LEVEL_OPTIONS}
              onChange={(v) => setLevel(v)}
            />
          </Field>
          <Field label="过期时间" hint="留空则永不过期">
            <Input
              type="datetime-local"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
              className="sm:w-56"
            />
          </Field>
        </div>

        <Field label="邮件推送">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2.5">
              <Switch
                checked={notifyEmail && !emailDisabled}
                disabled={emailDisabled}
                onCheckedChange={(v) => setNotifyEmail(v)}
                aria-label="同时发邮件到用户邮箱"
              />
              <span className="text-[13px] text-fg">
                同时发邮件到用户邮箱（快照创建时刻 active + 已验证 的用户）
              </span>
            </div>
            <p className="text-[12px] text-faint">{emailHint}</p>
          </div>
        </Field>

        <div className="flex justify-end">
          <Button variant="primary" onClick={send} disabled={busy}>
            <Send size={15} />
            {busy ? "发送中…" : "发送"}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-medium text-faint">{label}</span>
        {hint && <span className="text-[11px] text-faint/80">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
