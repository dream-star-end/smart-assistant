import { Inbox, Search, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";
import { Badge, Button, EmptyState, Input, Spinner, useToast } from "../../../components/ui";
import { type Column, DataTable, FilterBar, PageHeader } from "../../components";
import { adminGet, adminSend, apiErrorMessage } from "../../lib/adminApi";
import { getAdminPage } from "../../registry";

type PricingRow = {
  model_id: string;
  display_name: string | null;
  visibility: string;
  enabled: boolean;
};
type GrantRow = { model_id: string };

export default function ModelGrantsPage() {
  const meta = getAdminPage("modelGrants");
  const toast = useToast();

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<{ uid: string; email: string } | null>(null);
  const [searching, setSearching] = useState(false);

  const pricingCache = useRef<PricingRow[] | null>(null);
  const [restricted, setRestricted] = useState<PricingRow[]>([]);
  const [grantedSet, setGrantedSet] = useState<Set<string>>(new Set());
  const [loadingGrants, setLoadingGrants] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [togglingModel, setTogglingModel] = useState<string | null>(null);

  const loadGrants = async (uid: string) => {
    setLoadingGrants(true);
    setError(null);
    try {
      if (!pricingCache.current) {
        const pr = await adminGet<{ rows: PricingRow[] }>("/pricing");
        pricingCache.current = pr.rows ?? [];
      }
      const grantsResp = await adminGet<{ rows: GrantRow[] }>(
        `/users/${encodeURIComponent(uid)}/model-grants`,
      );
      setGrantedSet(new Set((grantsResp.rows ?? []).map((g) => g.model_id)));
      // 只列需要授权的模型(visibility != public)。
      setRestricted(
        (pricingCache.current ?? []).filter((p) => (p.visibility || "public") !== "public"),
      );
    } catch (e) {
      setError(apiErrorMessage(e, "加载失败"));
    } finally {
      setLoadingGrants(false);
    }
  };

  const search = async () => {
    const q = query.trim();
    if (!q) {
      toast("输入邮箱或 UID", "info");
      return;
    }
    setSearching(true);
    try {
      let uid = "";
      let email = "";
      if (/^\d+$/.test(q)) {
        const detail = await adminGet<{ user?: { id: string; email: string } }>(
          `/users/${encodeURIComponent(q)}/detail`,
        );
        uid = String(detail.user?.id ?? q);
        email = detail.user?.email ?? "";
      } else {
        const data = await adminGet<{ rows: Array<{ id: string; email: string | null }> }>("/users", {
          q,
          limit: 5,
        });
        const rows = data.rows ?? [];
        const exact = rows.find((r) => (r.email || "").toLowerCase() === q.toLowerCase());
        const hit = exact || rows[0];
        if (!hit) {
          toast("未找到用户", "info");
          return;
        }
        uid = String(hit.id);
        email = hit.email || "";
      }
      setSelected({ uid, email });
      await loadGrants(uid);
    } catch (e) {
      toast(`查询失败：${apiErrorMessage(e, "请求失败")}`, "error");
    } finally {
      setSearching(false);
    }
  };

  const toggleGrant = async (modelId: string, grant: boolean) => {
    if (!selected) return;
    setTogglingModel(modelId);
    try {
      if (grant) {
        await adminSend("POST", `/users/${encodeURIComponent(selected.uid)}/model-grants`, {
          model_id: modelId,
        });
        toast(`已授权 ${modelId}`, "success");
      } else {
        await adminSend(
          "DELETE",
          `/users/${encodeURIComponent(selected.uid)}/model-grants/${encodeURIComponent(modelId)}`,
        );
        toast(`已撤销 ${modelId}`, "success");
      }
      await loadGrants(selected.uid);
    } catch (e) {
      toast(`失败：${apiErrorMessage(e, "请求失败")}`, "error");
    } finally {
      setTogglingModel(null);
    }
  };

  const columns: Column<PricingRow>[] = [
    { key: "model_id", title: "model_id", cellClassName: "font-mono text-[12px]", render: (r) => r.model_id },
    { key: "display_name", title: "显示名", render: (r) => r.display_name || "—" },
    {
      key: "visibility",
      title: "visibility",
      render: (r) => <Badge tone="neutral">{r.visibility || "public"}</Badge>,
    },
    {
      key: "enabled",
      title: "启用",
      render: (r) => <Badge tone={r.enabled ? "success" : "neutral"}>{r.enabled ? "on" : "off"}</Badge>,
    },
    {
      key: "actions",
      title: "授权",
      align: "right",
      render: (r) => {
        const isGranted = grantedSet.has(r.model_id);
        return (
          <Button
            variant={isGranted ? "danger" : "secondary"}
            size="sm"
            disabled={togglingModel === r.model_id}
            onClick={() => toggleGrant(r.model_id, !isGranted)}
          >
            {isGranted ? "撤销" : "授权"}
          </Button>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={meta.title} desc={meta.desc} />

      <FilterBar>
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") search();
            }}
            placeholder="用户邮箱 或 UID"
            className="h-9 w-full pl-9 sm:w-64"
          />
        </div>
        <Button variant="primary" size="sm" onClick={search} disabled={searching}>
          {searching ? "查询中…" : "查询"}
        </Button>
        {selected && (
          <span className="text-[12.5px] text-muted">
            当前:{selected.email || "—"} <span className="font-mono">(uid={selected.uid})</span>
          </span>
        )}
      </FilterBar>

      {!selected ? (
        <EmptyState icon={ShieldCheck} title="输入用户邮箱或 UID 开始" hint="visibility = admin / hidden 的模型按用户灰度授权" />
      ) : loadingGrants ? (
        <div className="flex items-center justify-center py-16">
          <Spinner />
        </div>
      ) : error ? (
        <EmptyState
          icon={Inbox}
          title="加载失败"
          hint={error}
          action={
            <Button variant="secondary" size="sm" onClick={() => loadGrants(selected.uid)}>
              重试
            </Button>
          }
        />
      ) : restricted.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="无受限模型" hint="所有定价均为 visibility=public,无需授权" />
      ) : (
        <DataTable columns={columns} rows={restricted} rowKey={(r) => r.model_id} />
      )}
    </div>
  );
}
