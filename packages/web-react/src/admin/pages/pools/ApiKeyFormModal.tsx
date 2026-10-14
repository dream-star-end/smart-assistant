import { type ReactNode, useEffect, useState } from "react";
import { Button, Input, Modal, Spinner, useToast } from "../../../components/ui";
import { adminSend, apiErrorMessage } from "../../lib/adminApi";
import { serviceLabel } from "./types";

function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: label 经 children 隐式关联表单控件
    <label className="flex flex-col gap-1.5">
      <span className="text-meta font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] leading-snug text-faint">{hint}</span>}
    </label>
  );
}

/** 给某个服务池添加 API key。key 明文只在提交时发送一次,之后只显示末 4 位。 */
export function ApiKeyFormModal({
  open,
  onOpenChange,
  services,
  initialService,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  services: string[];
  initialService: string;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [service, setService] = useState(initialService);
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setService(initialService);
    setApiKey("");
    setLabel("");
  }, [open, initialService]);

  const submit = async () => {
    const key = apiKey.trim();
    if (!service || !key) {
      toast("服务和 API key 必填", "error");
      return;
    }
    setSaving(true);
    try {
      await adminSend("POST", "/pools/keys", { service, api_key: key, label: label.trim() });
      toast("已添加,立即参与调度", "success");
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast(`添加失败:${apiErrorMessage(e, "请求失败")}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="添加 API key"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? <Spinner className="size-4" /> : "添加"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="服务池">
          <select
            className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-base md:text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-ring"
            value={service}
            onChange={(e) => setService(e.target.value)}
          >
            {services.map((s) => (
              <option key={s} value={s}>
                {serviceLabel(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="API key" hint="加密保存;提交后页面只显示末 4 位。">
          <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </Field>
        <Field label="备注名(可选)">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例:备用 key 2" />
        </Field>
      </div>
    </Modal>
  );
}
