import { useEffect, useState } from "react";
import { Button, Input, Modal, Spinner, useToast } from "../../../components/ui";
import { adminSend, apiErrorMessage } from "../../lib/adminApi";
import { Field, Select } from "./form";
import type { EgressProxyRow } from "./types";

function errMsg(e: unknown): string {
  return apiErrorMessage(e, "请求失败");
}

/**
 * 代理池条目创建 / 编辑模态。
 *  - create:label + url(明文,创建后只展示遮蔽串)+ status + notes。
 *  - edit:label / status / notes 可改;url 留空=不改(安全:不回显明文,以遮蔽串为 placeholder)。
 */
export function EgressProxyFormModal({
  open,
  onOpenChange,
  row,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 传入=编辑;不传=新建。 */
  row?: EgressProxyRow;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isCreate = !row;
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"active" | "disabled">("active");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLabel(row?.label ?? "");
    setUrl("");
    setStatus(row?.status ?? "active");
    setNotes(row?.notes ?? "");
  }, [open, row]);

  const submit = async () => {
    const lbl = label.trim();
    if (!lbl) {
      toast("label 必填", "error");
      return;
    }
    const u = url.trim();
    if (isCreate && !u) {
      toast("url 必填", "error");
      return;
    }
    setSaving(true);
    try {
      if (isCreate) {
        const body: Record<string, unknown> = { label: lbl, url: u, status };
        if (notes !== "") body.notes = notes;
        await adminSend("POST", "/egress-proxies", body);
        toast("已创建", "success");
      } else {
        const patch: Record<string, unknown> = { label: lbl, status, notes };
        if (u) patch.url = u;
        await adminSend("PATCH", `/egress-proxies/${encodeURIComponent(row!.id)}`, patch);
        toast("已保存", "success");
      }
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast(`${isCreate ? "创建" : "保存"}失败: ${errMsg(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isCreate ? "新建代理" : `编辑代理 · ${row?.label ?? ""}`}
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
        <Field label="label(展示名,唯一)">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例:tokyo-residential-1" />
        </Field>
        <Field
          label={isCreate ? "URL(明文,创建后只展示遮蔽串)" : "当前 URL(已遮蔽,留空即不改)"}
          hint={isCreate ? "http://user:pass@host:port 或 socks5://…" : undefined}
        >
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={isCreate ? "http://user:pass@host:port 或 socks5://…" : row?.url_masked}
          />
        </Field>
        <Field label="status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as "active" | "disabled")}>
            <option value="active">active</option>
            <option value="disabled">disabled</option>
          </Select>
        </Field>
        <Field label="notes(可选)">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="备注" />
        </Field>
      </div>
    </Modal>
  );
}
