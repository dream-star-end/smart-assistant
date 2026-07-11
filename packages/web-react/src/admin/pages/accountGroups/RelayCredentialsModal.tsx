import { Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Input,
  Modal,
  Spinner,
  Textarea,
  useConfirm,
  useToast,
} from "../../../components/ui";
import { DataTable, type Column } from "../../components";
import { adminGet, adminSend, apiErrorMessage } from "../../lib/adminApi";
import { Field, Select } from "./form";
import type { RelayCredential } from "./types";

function errMsg(e: unknown): string {
  return apiErrorMessage(e, "请求失败");
}

const credTone = (s: string) => (s === "active" ? "success" : s === "cooldown" ? "warning" : "neutral");

/**
 * 中转站凭据子区(仅 api_relay 分组)。列表 + 内联新增(secret 只提交一次、不回显)+ 启停 + 删除。
 * 端点:GET/POST /account-groups/:id/relay-credentials、PATCH/DELETE /account-groups/relay-credentials/:id。
 */
export function RelayCredentialsModal({
  open,
  onOpenChange,
  groupId,
  groupLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupId: string | null;
  groupLabel: string;
}) {
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();
  const [rows, setRows] = useState<RelayCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!open || groupId == null) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setShowCreate(false);
    void adminGet<{ rows: RelayCredential[] }>(
      `/account-groups/${encodeURIComponent(groupId)}/relay-credentials`,
    )
      .then((d) => {
        if (alive) setRows(Array.isArray(d.rows) ? d.rows : []);
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
  }, [open, groupId, tick]);

  const toggleStatus = useCallback(
    async (c: RelayCredential) => {
      const status = c.status === "active" ? "disabled" : "active";
      try {
        await adminSend("PATCH", `/account-groups/relay-credentials/${encodeURIComponent(c.id)}`, { status });
        toast("已更新", "success");
        refresh();
      } catch (e) {
        toast(`更新失败:${errMsg(e)}`, "error");
      }
    },
    [toast, refresh],
  );

  const doDelete = useCallback(
    async (c: RelayCredential) => {
      const ok = await confirm({
        title: `删除中转站凭据 #${c.id}`,
        body: "删除后该 API key 不再参与调度;正在使用该凭据的请求不会被前端自动迁移。",
        danger: true,
        confirmText: "删除",
      });
      if (!ok) return;
      try {
        await adminSend("DELETE", `/account-groups/relay-credentials/${encodeURIComponent(c.id)}`);
        toast("已删除", "success");
        refresh();
      } catch (e) {
        toast(`删除失败:${errMsg(e)}`, "error");
      }
    },
    [confirm, toast, refresh],
  );

  const columns: Column<RelayCredential>[] = [
    { key: "label", title: "label", render: (c) => <span className="font-medium">{c.label}</span> },
    { key: "base_url", title: "base_url", render: (c) => <span className="font-mono text-[12px] break-all">{c.base_url}</span> },
    { key: "model_provider", title: "provider", render: (c) => <span className="font-mono text-[12px]">{c.model_provider}</span> },
    { key: "status", title: "状态", width: 80, render: (c) => <Badge tone={credTone(c.status)}>{c.status}</Badge> },
    { key: "health_score", title: "health", align: "right", cellClassName: "tabular-nums", render: (c) => c.health_score },
    { key: "last_error", title: "最近错误", render: (c) => (c.last_error ? <span className="text-[12px] text-danger" title={c.last_error}>{c.last_error}</span> : <span className="text-faint">—</span>) },
    {
      key: "actions",
      title: "操作",
      align: "right",
      render: (c) => (
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => toggleStatus(c)}>
            {c.status === "active" ? "停用" : "启用"}
          </Button>
          <Button size="sm" variant="ghost" className="text-danger" onClick={() => doDelete(c)}>
            删除
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`中转站凭据 · ${groupLabel}`}
      description={groupId ? `#${groupId}` : undefined}
      className="max-w-3xl"
    >
      <div className="flex flex-col gap-3">
        <div className="flex justify-end">
          <Button size="sm" variant={showCreate ? "secondary" : "primary"} onClick={() => setShowCreate((v) => !v)}>
            <Plus size={15} /> {showCreate ? "收起" : "添加 API key"}
          </Button>
        </div>

        {showCreate && groupId != null && (
          <CreateCredentialForm
            groupId={groupId}
            onCreated={() => {
              setShowCreate(false);
              refresh();
            }}
          />
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted">
            <Spinner className="size-4" /> 加载中…
          </div>
        ) : error ? (
          <div className="py-6 text-center text-sm text-danger">加载失败:{error}</div>
        ) : (
          <DataTable columns={columns} rows={rows} rowKey={(c) => c.id} emptyTitle="暂无凭据" />
        )}
      </div>
      {confirmEl}
    </Modal>
  );
}

/** 内联「添加中转站 API Key」表单。secret 只提交一次、不回显。 */
function CreateCredentialForm({ groupId, onCreated }: { groupId: string; onCreated: () => void }) {
  const toast = useToast();
  const [label, setLabel] = useState("Yunwu");
  const [baseUrl, setBaseUrl] = useState("https://yunwu.ai/v1");
  const [modelProvider, setModelProvider] = useState("api111");
  const [providerName, setProviderName] = useState("Yunwu");
  const [wireApi, setWireApi] = useState("responses");
  const [authMethod, setAuthMethod] = useState("apikey");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!label.trim() || !baseUrl.trim() || !modelProvider.trim()) {
      toast("label / base_url / model_provider 必填", "error");
      return;
    }
    if (!apiKey.trim()) {
      toast("API key 必填", "error");
      return;
    }
    setSaving(true);
    try {
      await adminSend("POST", `/account-groups/${encodeURIComponent(groupId)}/relay-credentials`, {
        label: label.trim(),
        base_url: baseUrl.trim(),
        model_provider: modelProvider.trim(),
        provider_name: providerName.trim() || null,
        wire_api: wireApi,
        preferred_auth_method: authMethod,
        disable_response_storage: true,
        api_key: apiKey.trim(),
        status: "active",
      });
      toast("已保存", "success");
      onCreated();
    } catch (e) {
      toast(`保存失败: ${errMsg(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="label">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="base_url">
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </Field>
        <Field label="model_provider">
          <Input value={modelProvider} onChange={(e) => setModelProvider(e.target.value)} />
        </Field>
        <Field label="provider_name">
          <Input value={providerName} onChange={(e) => setProviderName(e.target.value)} />
        </Field>
        <Field label="wire_api">
          <Select value={wireApi} onChange={(e) => setWireApi(e.target.value)}>
            <option value="responses">responses</option>
            <option value="chat">chat</option>
          </Select>
        </Field>
        <Field label="preferred_auth_method">
          <Select value={authMethod} onChange={(e) => setAuthMethod(e.target.value)}>
            <option value="apikey">apikey</option>
            <option value="chatgpt">chatgpt</option>
          </Select>
        </Field>
      </div>
      <Field label="API key(只提交一次,不会回显)">
        <Textarea value={apiKey} rows={2} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
      </Field>
      <div className="flex justify-end">
        <Button size="sm" variant="primary" onClick={submit} disabled={saving}>
          {saving ? <Spinner className="size-4" /> : "保存"}
        </Button>
      </div>
    </div>
  );
}
