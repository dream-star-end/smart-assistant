import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Checkbox, Modal, Progress, Spinner } from "../../../components/ui";
import { DataTable, type Column } from "../../components";
import { adminGet, adminSend, apiErrorMessage } from "../../lib/adminApi";
import { fmtDateTime } from "./cells";

export interface BoxClaudeProfile {
  profile: string;
  config_dir: string;
  enabled: boolean;
  is_default: boolean;
  login_state: "unknown" | "logged_in" | "logged_out";
  projects_mode: "unknown" | "root" | "shared" | "absent" | "own";
  selectable: boolean;
  email_hint: string | null;
  org_type: string | null;
  duplicate_of: string | null;
  utilization: number | null;
  cooldown_until: string | null;
  cooldown_reason: string | null;
  last_seen_at: string | null;
}
interface BoxClaudeProfilesResponse {
  available?: boolean;
  profiles: BoxClaudeProfile[];
  implicit_default: boolean;
  policy: { utilization_ceiling: number };
}

const NOT_SELECTABLE_REASON: Record<string, string> = {
  logged_out: "未登录:在 Box 里用该目录登录后重新扫描",
  own: "目录自带会话记录,不是产品专用目录,不能勾选",
  absent: "尚未接入:重新扫描会自动接入已登录的目录",
};

function reasonText(p: BoxClaudeProfile): string {
  if (p.login_state !== "logged_in") return NOT_SELECTABLE_REASON.logged_out!;
  return NOT_SELECTABLE_REASON[p.projects_mode] ?? "不可用";
}

function Health({ p, ceiling }: { p: BoxClaudeProfile; ceiling: number }) {
  if (p.cooldown_until) {
    const why =
      p.cooldown_reason === "login_required"
        ? "登录失效"
        : p.cooldown_reason === "profile_unsafe"
          ? "目录校验失败(登录或共享目录被改动)"
          : p.cooldown_reason === "quota_exhausted"
            ? "额度用尽"
            : "暂不可用";
    return <Badge tone="danger">{`${why},${fmtDateTime(p.cooldown_until)} 前不参与`}</Badge>;
  }
  if (p.utilization === null) return <span className="text-muted">暂无数据</span>;
  const pct = Math.min(100, Math.round(p.utilization * 100));
  return (
    <div className="flex min-w-32 items-center gap-2">
      <Progress value={pct} size="sm" tone={p.utilization >= ceiling ? "warning" : "neutral"} className="w-20" />
      <span className="tabular-nums">{pct}%</span>
      {p.utilization >= ceiling && <Badge tone="warning">接近上限</Badge>}
    </div>
  );
}

/** 账号池 → Cursor(Box)账号 → 该 Box 里的 Claude Code 登录:发现、勾选生效、选默认。 */
export function BoxClaudeProfilesModal({
  open,
  onOpenChange,
  accountId,
  accountLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string | null;
  accountLabel: string;
}) {
  const [data, setData] = useState<BoxClaudeProfilesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"load" | "scan" | "save" | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [defaultName, setDefaultName] = useState<string>("default");
  const [saved, setSaved] = useState(false);
  // Every request belongs to the account that was open when it started; an answer for another
  // account (opened and closed meanwhile) must not touch this one's state or be saved under it.
  const generation = useRef(0);

  const adopt = useCallback((r: BoxClaudeProfilesResponse) => {
    setData(r);
    const on = r.profiles.filter((p) => p.enabled);
    setChecked(new Set(on.map((p) => p.profile)));
    setDefaultName(r.profiles.find((p) => p.is_default)?.profile ?? on[0]?.profile ?? "default");
  }, []);

  const load = useCallback(async () => {
    if (!accountId) return;
    const mine = ++generation.current;
    setBusy("load");
    setError(null);
    try {
      const r = await adminGet<BoxClaudeProfilesResponse>("/box-claude-profiles", { account_id: accountId });
      if (mine === generation.current) adopt(r);
    } catch (e) {
      if (mine === generation.current) setError(apiErrorMessage(e, "请求失败"));
    } finally {
      if (mine === generation.current) setBusy(null);
    }
  }, [accountId, adopt]);

  useEffect(() => {
    // Invalidate whatever was in flight for the previous account (also on close).
    generation.current += 1;
    setData(null);
    setChecked(new Set());
    setDefaultName("default");
    setError(null);
    setBusy(null);
    setSaved(false);
    if (!open || !accountId) return;
    void load();
  }, [open, accountId, load]);

  const scan = async () => {
    if (!accountId) return;
    const mine = ++generation.current;
    setBusy("scan");
    setError(null);
    setSaved(false);
    try {
      const r = await adminSend<BoxClaudeProfilesResponse>("POST", "/box-claude-profiles/discover", { account_id: accountId });
      if (mine === generation.current) adopt(r);
    } catch (e) {
      if (mine === generation.current) setError(apiErrorMessage(e, "扫描失败"));
    } finally {
      if (mine === generation.current) setBusy(null);
    }
  };

  const dirty = useMemo(() => {
    if (!data) return false;
    const was = new Set(data.profiles.filter((p) => p.enabled).map((p) => p.profile));
    const wasDefault = data.profiles.find((p) => p.is_default)?.profile;
    return (
      was.size !== checked.size || [...checked].some((n) => !was.has(n)) || (wasDefault ?? "") !== defaultName
    );
  }, [data, checked, defaultName]);

  const toggle = (name: string, on: boolean) => {
    setSaved(false);
    const next = new Set(checked);
    if (on) next.add(name);
    else next.delete(name);
    setChecked(next);
    if (!on && defaultName === name) setDefaultName([...next][0] ?? "");
    if (on && !defaultName) setDefaultName(name);
  };

  const save = async () => {
    if (!accountId) return;
    const mine = ++generation.current;
    setBusy("save");
    setError(null);
    try {
      const r = await adminSend<BoxClaudeProfilesResponse>("PUT", "/box-claude-profiles", {
        account_id: accountId,
        enabled: [...checked],
        default: defaultName,
      });
      if (mine === generation.current) {
        adopt(r);
        setSaved(true);
      }
    } catch (e) {
      if (mine === generation.current) setError(apiErrorMessage(e, "保存失败"));
    } finally {
      if (mine === generation.current) setBusy(null);
    }
  };

  const rows = data?.profiles ?? [];
  const ceiling = data?.policy.utilization_ceiling ?? 0.92;
  const columns: Column<BoxClaudeProfile>[] = [
    {
      key: "use",
      title: "生效",
      width: 64,
      render: (p) => (
        <Checkbox
          aria-label={`启用 ${p.profile}`}
          checked={checked.has(p.profile)}
          disabled={!p.selectable || busy !== null}
          title={p.selectable ? undefined : reasonText(p)}
          onChange={(e) => toggle(p.profile, e.target.checked)}
        />
      ),
    },
    {
      key: "default",
      title: "默认",
      width: 64,
      render: (p) => (
        <input
          type="radio"
          name="box-claude-default"
          className="accent-accent"
          aria-label={`默认 ${p.profile}`}
          checked={defaultName === p.profile}
          disabled={!checked.has(p.profile) || busy !== null}
          onChange={() => {
            setSaved(false);
            setDefaultName(p.profile);
          }}
        />
      ),
    },
    {
      key: "name",
      title: "Claude Code 登录",
      render: (p) => (
        <div className="flex flex-col">
          <span className="font-mono text-meta">{p.config_dir}</span>
          <span className="text-caption text-muted">
            {p.email_hint ?? "未登录"}
            {p.org_type ? ` · ${p.org_type}` : ""}
          </span>
          {!p.selectable && <span className="text-caption text-warning">{reasonText(p)}</span>}
          {p.duplicate_of && (
            <span className="text-caption text-warning">{`与 ${p.duplicate_of} 是同一个 Claude 账号,同时勾选不会增加额度`}</span>
          )}
        </div>
      ),
    },
    { key: "health", title: "5 小时额度", render: (p) => <Health p={p} ceiling={ceiling} /> },
  ];

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`账号 #${accountId ?? ""} — Box 内的 Claude Code 账号`}
      description={accountLabel}
      className="max-w-3xl"
    >
      <div className="flex flex-col gap-3">
        <p className="text-caption text-muted">
          勾选的登录会一起参与调度:同一用户尽量固定用同一个(利于缓存和会话续接),只有该登录额度用尽、登录失效或过忙时才换到其它已勾选的登录,恢复后自动换回。默认登录用于无用户标识的请求,并在负载均衡时略有优先。
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        {data?.available === false && (
          <Alert tone="warning">这个版本没有 Box 多账号功能(缺少 box_claude_profiles 表),只使用默认登录。</Alert>
        )}
        {data?.implicit_default && data.available !== false && (
          <Alert tone="info">
            还没有扫描过这个 Box:目前只使用默认登录(~/.claude)。点“扫描”列出 Box 里的全部 Claude Code 登录。
          </Alert>
        )}
        {busy === "load" && !data ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted">
            <Spinner className="size-4" /> 正在读取…
          </div>
        ) : (
          rows.length > 0 && <DataTable columns={columns} rows={rows} rowKey={(p) => p.profile} />
        )}
        <details className="text-caption text-muted">
          <summary className="cursor-pointer">如何新增一个 Claude Code 账号</summary>
          <ol className="mt-1 list-decimal pl-5">
            <li>在这个 Box 的终端里:mkdir -p ~/.claude-名称(名称只含小写字母、数字和连字符)</li>
            <li>CLAUDE_CONFIG_DIR=~/.claude-名称 claude,按提示 /login 登录要加入的账号。</li>
            <li>回到这里点“扫描”,勾选新出现的登录并保存。不要把含有自己会话记录的目录(如开发用的账号目录)勾进来。</li>
          </ol>
        </details>
        <div className="flex items-center justify-end gap-2">
          {saved && <span className="text-caption text-success">已保存</span>}
          <Button size="sm" variant="secondary" onClick={() => void scan()} disabled={busy !== null || data?.available === false}>
            {busy === "scan" ? "扫描中…" : "扫描 Box"}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={busy !== null || !dirty || checked.size === 0}>
            {busy === "save" ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
