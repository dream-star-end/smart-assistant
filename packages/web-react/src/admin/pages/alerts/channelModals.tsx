import { MessageSquare, QrCode, Send, Bot, ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Input,
  Modal,
  Spinner,
  useToast,
} from "../../../components/ui";
import { adminSend } from "../../lib/adminApi";
import { SEVERITY_MIN_OPTIONS } from "./constants";
import { EventPicker, collapseEventTypes } from "./EventPicker";
import { Field, NativeSelect, StepHint } from "./formBits";
import type { AlertChannel, ChannelType, EventMeta, Severity } from "./types";
import { errText } from "./util";

// ─── 新建通道向导 ─────────────────────────────────────────────────────

type WizardType = Exclude<ChannelType, never> | null;

const TYPE_OPTIONS: { type: ChannelType; label: string; desc: string; icon: typeof Send }[] = [
  { type: "ilink_wechat", label: "微信 iLink", desc: "扫码绑定,推给个人微信", icon: QrCode },
  { type: "telegram", label: "Telegram", desc: "BotFather bot_token + chat_id", icon: Send },
  { type: "wecom_bot", label: "企业微信群机器人", desc: "群 Webhook URL", icon: MessageSquare },
  { type: "wecom_aibot", label: "企业微信智能机器人", desc: "长连接 BotID + Secret", icon: Bot },
];

export function CreateChannelWizard({
  open,
  onOpenChange,
  events,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  events: EventMeta[];
  onCreated: () => void;
}) {
  const [type, setType] = useState<WizardType>(null);

  const close = () => {
    onOpenChange(false);
    // 关闭动画后再复位,避免闪回选择页
    setTimeout(() => setType(null), 180);
  };
  const done = () => {
    onCreated();
    close();
  };

  const title = type === null ? "新建告警通道" : `新建通道 · ${TYPE_OPTIONS.find((o) => o.type === type)?.label}`;

  return (
    <Modal open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())} title={title}>
      {type === null && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {TYPE_OPTIONS.map((o) => (
            <button
              key={o.type}
              type="button"
              onClick={() => setType(o.type)}
              className="flex items-start gap-3 rounded-xl border border-border bg-surface p-3.5 text-left outline-none transition-colors hover:border-border-strong hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <o.icon size={18} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-medium text-fg">{o.label}</span>
                <span className="block text-[12px] text-faint">{o.desc}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {type !== null && (
        <div className="flex flex-col gap-4">
          <button
            type="button"
            onClick={() => setType(null)}
            className="inline-flex w-fit items-center gap-1 text-[12.5px] text-muted outline-none hover:text-fg focus-visible:underline"
          >
            <ArrowLeft size={13} /> 换一种通道类型
          </button>
          {type === "ilink_wechat" ? (
            <IlinkBindFlow onConfirmed={done} />
          ) : (
            <SecretChannelForm type={type} events={events} onCreated={done} />
          )}
        </div>
      )}
    </Modal>
  );
}

// ─── Telegram / 群机器人 / 智能机器人 表单(共用骨架,字段按 type 分支)──────

function SecretChannelForm({
  type,
  events,
  onCreated,
}: {
  type: Exclude<ChannelType, "ilink_wechat">;
  events: EventMeta[];
  onCreated: () => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [severity, setSeverity] = useState<Severity>("warning");
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // type-specific secrets
  const [f1, setF1] = useState(""); // tg bot_token / wecom webhook / aibot botid
  const [f2, setF2] = useState(""); // tg chat_id / aibot secret

  const submit = async () => {
    const lbl = label.trim();
    if (!lbl || lbl.length > 64) return toast("标签必填,长度 1..64", "error");
    let path: string;
    let body: Record<string, unknown>;
    const eventTypes = selected; // create 语义:空数组=全部
    if (type === "telegram") {
      if (!f1.trim()) return toast("Bot Token 必填", "error");
      if (!f2.trim()) return toast("Chat ID 必填", "error");
      path = "/alerts/channels/telegram";
      body = { label: lbl, bot_token: f1.trim(), chat_id: f2.trim(), severity_min: severity, event_types: eventTypes };
    } else if (type === "wecom_bot") {
      if (!f1.trim()) return toast("Webhook 地址 或 key 必填", "error");
      path = "/alerts/channels/wecom";
      body = { label: lbl, webhook: f1.trim(), severity_min: severity, event_types: eventTypes };
    } else {
      if (!f1.trim()) return toast("BotID 必填", "error");
      if (!f2.trim()) return toast("长连接 Secret 必填", "error");
      path = "/alerts/channels/wecom-aibot";
      body = { label: lbl, botid: f1.trim(), secret: f2.trim(), severity_min: severity, event_types: eventTypes };
    }
    setSubmitting(true);
    try {
      const r = await adminSend<{ channel?: { label?: string } }>("POST", path, body);
      toast(
        type === "wecom_aibot"
          ? `通道已创建: ${r.channel?.label ?? lbl}。请给机器人发一条消息完成绑定。`
          : `通道已创建: ${r.channel?.label ?? lbl}`,
        "success",
      );
      onCreated();
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {type === "telegram" && (
        <StepHint
          steps={[
            <>用 Telegram 找 <code>@BotFather</code>,<code>/newbot</code> 拿 bot_token(形如 <code>123456:ABC-xxx</code>)</>,
            <>把 bot 加进目标 chat / channel,或直接私聊它</>,
            <>获取 chat_id:私聊填数字,群聊填 <code>-100…</code>,频道填 <code>@channelusername</code></>,
          ]}
        />
      )}
      {type === "wecom_bot" && (
        <StepHint
          steps={[
            <>目标企业微信群:群设置 → 群机器人 → 添加机器人</>,
            <>复制机器人 Webhook 地址(<code>https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…</code>)</>,
            <>整条 URL 粘到下面即可(也可只粘 <code>key</code> 值)</>,
          ]}
        />
      )}
      {type === "wecom_aibot" && (
        <StepHint
          steps={[
            <>企业微信管理后台 → 安全与管理 → 管理工具 → 智能机器人 → 创建/选择机器人</>,
            <>在机器人「API 模式」选 <b>长连接</b>,拿 <code>BotID</code> 与长连接专用 <code>Secret</code></>,
            <>创建后 <b>在企业微信里给该机器人发一条消息</b> 完成绑定(之后告警推到该会话)</>,
          ]}
        />
      )}

      <Field label="标签 label(必填,1..64)">
        <Input value={label} maxLength={64} placeholder="例如 ops-alert" onChange={(e) => setLabel(e.target.value)} />
      </Field>

      {type === "telegram" && (
        <>
          <Field label="Bot Token(必填)">
            <Input type="password" autoComplete="new-password" spellCheck={false} value={f1} placeholder="123456:ABC-xxx…" onChange={(e) => setF1(e.target.value)} />
          </Field>
          <Field label="Chat ID(必填,数字 或 @username)">
            <Input value={f2} maxLength={64} spellCheck={false} placeholder="-1001234567890 或 @my_channel" onChange={(e) => setF2(e.target.value)} />
          </Field>
        </>
      )}
      {type === "wecom_bot" && (
        <Field label="Webhook 地址 或 key(必填)">
          <Input type="password" autoComplete="new-password" spellCheck={false} value={f1} placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" onChange={(e) => setF1(e.target.value)} />
        </Field>
      )}
      {type === "wecom_aibot" && (
        <>
          <Field label="BotID(必填,非机密)">
            <Input autoComplete="off" spellCheck={false} value={f1} placeholder="机器人 BotID" onChange={(e) => setF1(e.target.value)} />
          </Field>
          <Field label="长连接 Secret(必填,机密)">
            <Input type="password" autoComplete="new-password" spellCheck={false} value={f2} placeholder="长连接专用 Secret" onChange={(e) => setF2(e.target.value)} />
          </Field>
        </>
      )}

      <Field label="最低严重度">
        <NativeSelect value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
          {SEVERITY_MIN_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </Field>

      <Field label="订阅事件" hint="留空 / 全勾 = 全部订阅;部分勾 = 白名单">
        <EventPicker events={events} value={selected} onChange={setSelected} />
      </Field>

      <div className="flex justify-end">
        <Button variant="primary" onClick={submit} disabled={submitting}>
          {submitting ? "创建中…" : "创建"}
        </Button>
      </div>
    </div>
  );
}

// ─── iLink 扫码绑定 ───────────────────────────────────────────────────

const IMG_URL_RE = /^https?:\/\/.*\.(png|jpe?g|gif|svg|webp)(\?|$)/i;
const QR_DEADLINE_MS = 125_000;
const POLL_MIN_GAP_MS = 2_000;

/**
 * iLink QR 绑定:POST /ilink/qrcode 拿码 → 客户端把 qrcode_img_content(短链字符串)
 * encode 成二维码图 → 循环 POST /ilink/poll(qrcode) 到 confirmed / 超时 / 卸载中止。
 * 服务端每次 poll 自己 long-poll ~35s;pending 之间加最小间隔兜底防紧循环。
 */
function IlinkBindFlow({ onConfirmed }: { onConfirmed: () => void }) {
  const toast = useToast();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [imgSrc, setImgSrc] = useState("");
  const [statusText, setStatusText] = useState("正在向 iLink 申请二维码…");
  const [errMsg, setErrMsg] = useState("");
  const onConfirmedRef = useRef(onConfirmed);
  onConfirmedRef.current = onConfirmed;

  useEffect(() => {
    let aborted = false;
    (async () => {
      let qr: { qrcode: string; qrcode_img_content?: string };
      try {
        qr = await adminSend("POST", "/alerts/ilink/qrcode", {});
      } catch (e) {
        if (!aborted) {
          setPhase("error");
          setErrMsg(`申请二维码失败: ${errText(e)}`);
        }
        return;
      }
      if (aborted) return;

      const raw = qr.qrcode_img_content || "";
      let src = "";
      if (raw.startsWith("data:")) src = raw;
      else if (IMG_URL_RE.test(raw)) src = raw;
      else if (raw) {
        try {
          const { qrDataUrl } = await import("./qr/qr");
          src = qrDataUrl(raw);
        } catch (e) {
          console.error("[alerts] QR encode failed:", e);
        }
      }
      if (aborted) return;
      setImgSrc(src);
      setPhase("ready");
      setStatusText("等待扫码…(会长轮询直到 ~120s 过期)");

      const deadline = Date.now() + QR_DEADLINE_MS;
      while (!aborted && Date.now() < deadline) {
        const started = Date.now();
        let poll: { status?: string; channel?: { label?: string } };
        try {
          poll = await adminSend("POST", "/alerts/ilink/poll", { qrcode: qr.qrcode });
        } catch (e) {
          if (aborted) return;
          setPhase("error");
          setErrMsg(`poll 失败: ${errText(e)}`);
          return;
        }
        if (aborted) return;
        if (poll?.status === "confirmed") {
          toast(`通道已绑定: ${poll.channel?.label ?? ""}`, "success");
          onConfirmedRef.current();
          return;
        }
        // pending:服务端若快速返回,补齐最小间隔防紧循环
        const gap = POLL_MIN_GAP_MS - (Date.now() - started);
        if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      }
      if (!aborted) setStatusText("超时,请关闭后重新打开");
    })();
    return () => {
      aborted = true;
    };
  }, []);

  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <p className="text-[12.5px] leading-relaxed text-muted">
        用<strong>已注册该机器人的微信</strong>扫码,确认后请再向机器人发任意一句话以捕获 context_token。
      </p>
      {phase === "loading" && (
        <div className="flex items-center gap-2 py-8 text-[13px] text-faint">
          <Spinner size={15} /> 正在向 iLink 申请二维码…
        </div>
      )}
      {phase === "error" && (
        <div className="w-full rounded-lg border border-danger/40 bg-danger-soft px-3 py-2.5 text-[12.5px] text-danger">
          {errMsg}
        </div>
      )}
      {phase === "ready" && (
        <>
          {imgSrc ? (
            <div className="rounded-xl border border-border bg-white p-3">
              <img src={imgSrc} alt="iLink 绑定二维码" width={220} height={220} className="size-[220px] object-contain" />
            </div>
          ) : (
            <div className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2.5 text-[12.5px] text-danger">
              iLink 没返回可渲染的二维码内容
            </div>
          )}
          <p className="text-[12px] text-faint">{statusText}</p>
        </>
      )}
    </div>
  );
}

// ─── 编辑通道 ─────────────────────────────────────────────────────────

export function EditChannelModal({
  channel,
  events,
  onOpenChange,
  onSaved,
}: {
  channel: AlertChannel | null;
  events: EventMeta[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [severity, setSeverity] = useState<Severity>("warning");
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // 打开(channel 变化)时播种表单;空 event_types = 订阅全部 → 勾全部
  useEffect(() => {
    if (!channel) return;
    setLabel(channel.label);
    setSeverity(channel.severity_min);
    const all = events.map((e) => e.event_type);
    setSelected(channel.event_types.length === 0 ? all : channel.event_types);
  }, [channel, events]);

  const submit = async () => {
    if (!channel) return;
    const lbl = label.trim();
    if (!lbl || lbl.length > 64) return toast("标签长度 1..64", "error");
    const all = events.map((e) => e.event_type);
    setSubmitting(true);
    try {
      await adminSend("PATCH", `/alerts/channels/${channel.id}`, {
        label: lbl,
        severity_min: severity,
        event_types: collapseEventTypes(selected, all),
      });
      toast("已保存", "success");
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={channel !== null}
      onOpenChange={onOpenChange}
      title={channel ? `编辑通道 #${channel.id} · ${channel.label}` : "编辑通道"}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={submitting}>
            {submitting ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="标签 label">
          <Input value={label} maxLength={64} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="最低严重度(低于此级别的不发)">
          <NativeSelect value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
            {SEVERITY_MIN_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="订阅事件" hint="留空 / 全勾 = 全部订阅;部分勾 = 白名单">
          <EventPicker events={events} value={selected} onChange={setSelected} />
        </Field>
      </div>
    </Modal>
  );
}
