import { KeyRound, Layers, MoreHorizontal, Plus, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Switch,
  useConfirm,
  useToast,
} from "../../../components/ui";
import {
  KeyValue,
  PageHeader,
  SectionCard,
  StatCard,
  StatCardRow,
} from "../../components";
import { adminGet, adminSend, apiErrorMessage } from "../../lib/adminApi";
import { getAdminPage } from "../../registry";
import { GroupFormModal } from "./GroupFormModal";
import { RelayCredentialsModal } from "./RelayCredentialsModal";
import { ACCOUNT_GROUP_KIND_LABEL, type AccountGroup } from "./types";

function errMsg(e: unknown): string {
  return apiErrorMessage(e, "请求失败");
}

export default function AccountGroupsPage() {
  const meta = getAdminPage("accountGroups");
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();

  const [groups, setGroups] = useState<AccountGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // 首载 + 手动刷新(accountGroups 不在 30s 自动轮询名单)。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void adminGet<{ rows: AccountGroup[] }>("/account-groups")
      .then((d) => {
        if (alive) setGroups(Array.isArray(d.rows) ? d.rows : []);
      })
      .catch((e) => {
        if (alive) setError(errMsg(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tick]);

  const [formGroup, setFormGroup] = useState<AccountGroup | null | undefined>(undefined);
  const formOpen = formGroup !== undefined;
  const [credsGroup, setCredsGroup] = useState<AccountGroup | null>(null);

  const toggleEnabled = useCallback(
    async (g: AccountGroup) => {
      try {
        await adminSend("PATCH", `/account-groups/${encodeURIComponent(g.id)}`, { enabled: !g.enabled });
        toast("已更新", "success");
        refresh();
      } catch (e) {
        toast(`更新失败:${errMsg(e)}`, "error");
      }
    },
    [toast, refresh],
  );

  const doDelete = useCallback(
    async (g: AccountGroup) => {
      const ok = await confirm({
        title: `删除账号分组 #${g.id}`,
        body: `分组:${g.label}。关联模型 / 中转站凭据会一起删除,Claude 账号会解绑。`,
        danger: true,
        confirmText: "删除",
      });
      if (!ok) return;
      try {
        await adminSend("DELETE", `/account-groups/${encodeURIComponent(g.id)}`);
        toast("已删除", "success");
        refresh();
      } catch (e) {
        toast(`删除失败:${errMsg(e)}`, "error");
      }
    },
    [confirm, toast, refresh],
  );

  const total = groups.length;
  const enabledN = groups.filter((g) => g.enabled).length;
  const relayN = groups.filter((g) => g.kind === "api_relay").length;
  const oauthN = groups.filter((g) => g.kind === "official_oauth").length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={meta.title}
        desc={loading ? "加载中…" : `共 ${total} 组`}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={refresh}>
              <RefreshCw size={15} /> 刷新
            </Button>
            <Button variant="primary" size="sm" onClick={() => setFormGroup(null)}>
              <Plus size={15} /> 新建分组
            </Button>
          </>
        }
      />

      <StatCardRow>
        <StatCard label="分组总数" value={total.toLocaleString()} icon={Layers} loading={loading} />
        <StatCard label="启用中" value={enabledN.toLocaleString()} tone="success" loading={loading} />
        <StatCard label="API 中转站" value={relayN.toLocaleString()} icon={Server} loading={loading} />
        <StatCard label="官方订阅" value={oauthN.toLocaleString()} icon={KeyRound} loading={loading} />
      </StatCardRow>

      {error ? (
        <div className="rounded-xl border border-danger/40 bg-danger-soft/40 px-4 py-6 text-center text-sm text-danger">
          加载失败:{error}
        </div>
      ) : loading ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-44 animate-pulse rounded-xl border border-border bg-surface" />
          ))}
        </div>
      ) : total === 0 ? (
        <div className="rounded-xl border border-border bg-surface">
          <EmptyState
            icon={Layers}
            title="暂无分组"
            hint="新建账号分组以定义容量、权重和 provider / 模型路由边界。"
            action={
              <Button size="sm" variant="primary" onClick={() => setFormGroup(null)}>
                <Plus size={15} /> 新建分组
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {groups.map((g) => (
            <GroupCard
              key={g.id}
              group={g}
              onToggle={() => toggleEnabled(g)}
              onEdit={() => setFormGroup(g)}
              onCreds={() => setCredsGroup(g)}
              onDelete={() => doDelete(g)}
            />
          ))}
        </div>
      )}

      <GroupFormModal
        open={formOpen}
        onOpenChange={(o) => !o && setFormGroup(undefined)}
        group={formGroup ?? undefined}
        onSaved={refresh}
      />
      <RelayCredentialsModal
        open={credsGroup !== null}
        onOpenChange={(o) => !o && setCredsGroup(null)}
        groupId={credsGroup?.id ?? null}
        groupLabel={credsGroup?.label ?? ""}
      />
      {confirmEl}
    </div>
  );
}

function GroupCard({
  group: g,
  onToggle,
  onEdit,
  onCreds,
  onDelete,
}: {
  group: AccountGroup;
  onToggle: () => void;
  onEdit: () => void;
  onCreds: () => void;
  onDelete: () => void;
}) {
  const isRelay = g.kind === "api_relay";
  return (
    <SectionCard
      title={g.label}
      hint={`#${g.id} · ${ACCOUNT_GROUP_KIND_LABEL[g.kind] ?? g.kind}`}
      action={
        <div className="flex items-center gap-2">
          <Switch checked={g.enabled} onCheckedChange={onToggle} aria-label="启用分组" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton size="sm" shape="square" aria-label="分组操作">
                <MoreHorizontal size={16} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>编辑</DropdownMenuItem>
              {isRelay && <DropdownMenuItem onSelect={onCreds}>中转站凭据</DropdownMenuItem>}
              <DropdownMenuItem onSelect={onDelete} className="text-danger">
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
      bodyClassName="flex flex-col gap-3"
    >
      <div>
        <KeyValue label="provider" value={<span className="font-mono">{g.provider}</span>} />
        <KeyValue label="类型" value={ACCOUNT_GROUP_KIND_LABEL[g.kind] ?? g.kind} />
        <KeyValue label="优先级" value={<span className="tabular-nums">{g.priority}</span>} />
        <KeyValue
          label="启用"
          value={<Badge tone={g.enabled ? "success" : "neutral"}>{g.enabled ? "enabled" : "disabled"}</Badge>}
        />
      </div>
      <div>
        <p className="mb-1.5 text-[12px] font-medium text-faint">
          模型路由边界{g.models.length > 0 ? `(${g.models.length})` : ""}
        </p>
        {g.models.length === 0 ? (
          <span className="text-[12px] text-faint">不限定精确模型</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {g.models.map((m) => (
              <span key={m} className="rounded-md bg-hover px-2 py-0.5 font-mono text-[11.5px] text-muted">
                {m}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Button size="sm" variant="secondary" onClick={onEdit}>
          编辑
        </Button>
        {isRelay && (
          <Button size="sm" variant="secondary" onClick={onCreds}>
            中转站凭据
          </Button>
        )}
        <Button size="sm" variant="ghost" className="text-danger" onClick={onDelete}>
          删除
        </Button>
      </div>
    </SectionCard>
  );
}
