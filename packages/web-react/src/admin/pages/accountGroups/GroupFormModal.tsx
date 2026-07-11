import { useEffect, useState } from "react";
import { Button, Input, Modal, Spinner, Switch, useToast } from "../../../components/ui";
import { adminSend, apiErrorMessage } from "../../lib/adminApi";
import { Field, Select } from "./form";
import { type AccountGroup, GROUP_KINDS } from "./types";

function errMsg(e: unknown): string {
  return apiErrorMessage(e, "请求失败");
}

const parseModels = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * 账号分组创建 / 编辑模态。
 *  - create:label + kind + provider(v5 ccb-only 仅 claude)+ enabled + priority + models。POST /account-groups。
 *  - edit:label / priority / models 可改。label|priority 变更走 PATCH /account-groups/:id;
 *    models 变更走 PUT /account-groups/:id/models(后端 models 独立端点)。enabled 由卡片头 Switch 快速切换。
 */
export function GroupFormModal({
  open,
  onOpenChange,
  group,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 传入=编辑;不传=新建。 */
  group?: AccountGroup;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isCreate = !group;
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"official_oauth" | "api_relay">("api_relay");
  const [enabled, setEnabled] = useState(true);
  const [priority, setPriority] = useState("100");
  const [models, setModels] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLabel(group?.label ?? "");
    setKind(group?.kind ?? "api_relay");
    setEnabled(group?.enabled ?? true);
    setPriority(String(group?.priority ?? 100));
    setModels((group?.models ?? []).join(", "));
  }, [open, group]);

  const submit = async () => {
    const lbl = label.trim();
    if (!lbl) {
      toast("名称必填", "error");
      return;
    }
    const prio = Number(priority || "100");
    if (!Number.isInteger(prio)) {
      toast("优先级必须是整数", "error");
      return;
    }
    setSaving(true);
    try {
      if (isCreate) {
        await adminSend("POST", "/account-groups", {
          label: lbl,
          kind,
          provider: "claude",
          enabled,
          priority: prio,
          models: parseModels(models),
        });
        toast("已创建", "success");
      } else {
        // label|priority 变更 → PATCH;models 变更 → PUT /models(端点分离)。
        const metaChanged = lbl !== group!.label || prio !== group!.priority;
        const nextModels = parseModels(models);
        const modelsChanged = nextModels.join(",") !== (group!.models ?? []).join(",");
        if (metaChanged) {
          await adminSend("PATCH", `/account-groups/${encodeURIComponent(group!.id)}`, {
            label: lbl,
            priority: prio,
          });
        }
        if (modelsChanged) {
          await adminSend("PUT", `/account-groups/${encodeURIComponent(group!.id)}/models`, {
            models: nextModels,
          });
        }
        toast(metaChanged || modelsChanged ? "已更新" : "无改动", "success");
      }
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast(`${isCreate ? "创建" : "更新"}失败: ${errMsg(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isCreate ? "新建账号分组" : `编辑分组 #${group?.id ?? ""}`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? <Spinner className="size-4" /> : isCreate ? "创建" : "保存"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="名称">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如 Yunwu GPT 中转站" />
        </Field>
        {isCreate && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="类型">
              <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                {GROUP_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k === "official_oauth" ? "官方 OAuth 订阅" : "API 中转站"}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="provider" hint="v5 ccb-only:仅 claude。">
              <Select value="claude" disabled>
                <option value="claude">claude</option>
              </Select>
            </Field>
          </div>
        )}
        {isCreate && (
          <Field label="启用">
            <div className="flex h-10 items-center">
              <Switch checked={enabled} onCheckedChange={setEnabled} />
              <span className="ml-2 text-sm text-muted">{enabled ? "启用" : "停用"}</span>
            </div>
          </Field>
        )}
        <Field label="优先级(数字越小越优先)">
          <Input
            type="number"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
        </Field>
        <Field label="模型 id(逗号分隔;路由边界)" hint="留空=不限定精确模型。">
          <Input value={models} onChange={(e) => setModels(e.target.value)} placeholder="如 gpt-5.5, claude-…" />
        </Field>
      </div>
    </Modal>
  );
}
