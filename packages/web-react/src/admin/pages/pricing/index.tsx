import { Inbox, RotateCw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  EmptyState,
  Modal,
  Textarea,
  useConfirm,
  useToast,
} from "../../../components/ui";
import { PageHeader } from "../../components";
import { adminGet, adminSend, ApiError, apiErrorMessage } from "../../lib/adminApi";
import { useAdminPoll } from "../../lib/useAdminPoll";
import { getAdminPage } from "../../registry";
import { ModelRow, type PriceChange } from "./ModelRow";
import { ProviderCard } from "./ProviderCard";
import type { HealthMode, Inflight, ModelOpsResp, ModelRowData, ProviderData, StatsResp } from "./types";

function PriceChangeTable({ changes }: { changes: PriceChange[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-border text-left text-[12px] text-faint">
            <th className="py-1.5 pr-3">项</th>
            <th className="py-1.5 pr-3 text-right">旧(分/Mtok)</th>
            <th className="py-1.5 text-right">新(分/Mtok)</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr key={c.field} className="border-b border-border/60 last:border-0">
              <td className="py-1.5 pr-3">{c.label}</td>
              <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-muted">{c.from}</td>
              <td className="py-1.5 text-right font-mono tabular-nums font-semibold text-fg">{c.to}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-[12.5px] text-warning">保存后计费立即生效,请核对每 Mtok 分值。</p>
    </div>
  );
}

function ExtraPromptModal({
  model,
  onClose,
  onSave,
}: {
  model: ModelRowData | null;
  onClose: () => void;
  onSave: (value: string | null) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setText(model?.extra_system_prompt ?? "");
  }, [model]);
  const submit = async () => {
    setSaving(true);
    try {
      await onSave(text.trim() === "" ? null : text);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={model !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={model ? `行为补丁 · ${model.model_id}` : "行为补丁"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <label className="text-[12px] text-faint">extra_system_prompt(per-model 行为补丁)</label>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          maxLength={4096}
          placeholder="留空=不注入。例:完成一个步骤后,不要 yield,继续推进至全部目标完成"
        />
        <p className="text-[11.5px] leading-relaxed text-faint">
          作为 system prompt 注入到 extra-prompt.md 末尾。修改仅对<b>新 spawn</b>的会话生效,
          运行中的会话不换文案。上限 4096 字。
        </p>
      </div>
    </Modal>
  );
}

export default function PricingPage() {
  const meta = getAdminPage("pricing");
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();

  const [models, setModels] = useState<ModelRowData[]>([]);
  const [providers, setProviders] = useState<ProviderData[]>([]);
  const [inflight, setInflight] = useState<Record<string, Inflight | null>>({});
  const [provInflight, setProvInflight] = useState<Record<string, number>>({});
  const [statsMeta, setStatsMeta] = useState<{ source: string; started_at: string | null }>({
    source: "local",
    started_at: null,
  });
  const [rowNonce, setRowNonce] = useState<Record<string, number>>({});
  const [provNonce, setProvNonce] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [extraModel, setExtraModel] = useState<ModelRowData | null>(null);

  const modelsRef = useRef<ModelRowData[]>(models);
  modelsRef.current = models;
  const inflightRef = useRef(inflight);
  inflightRef.current = inflight;

  // ── 全量加载(挂载 + 手动刷新)──
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const data = await adminGet<ModelOpsResp>("/model-ops");
        if (!alive) return;
        setModels(data.models ?? []);
        setProviders(data.providers ?? []);
        setInflight(
          Object.fromEntries((data.models ?? []).map((m) => [m.model_id, m.inflight ?? null])),
        );
        setProvInflight(
          Object.fromEntries((data.providers ?? []).map((p) => [p.id, p.inflight_current ?? 0])),
        );
        setStatsMeta({
          source: data.stats?.source ?? "local",
          started_at: data.stats?.started_at ?? null,
        });
      } catch (e) {
        if (alive) setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadTick]);

  // ── 30s 并发快照轮询:只刷 inflight / provInflight / 提示,绝不重拉全量、不碰行内编辑 ──
  const statsPoll = useAdminPoll<StatsResp>(() => adminGet<StatsResp>("/model-ops/stats"), {
    intervalMs: 30_000,
    enabled: !loading && !error,
    deps: [loading, error],
  });
  useEffect(() => {
    const stats = statsPoll.data;
    if (!stats) return;
    const ms = modelsRef.current;
    const prev = inflightRef.current;
    const nextInflight: Record<string, Inflight | null> = {};
    for (const m of ms) {
      const fresh = stats.by_model?.[m.model_id];
      if (fresh) {
        nextInflight[m.model_id] = {
          current: fresh.current ?? 0,
          peak: fresh.peak ?? 0,
          peak_at: fresh.peak_at ?? null,
        };
      } else if (prev[m.model_id]) {
        // 快照无条目但历史有记录 → 当前归 0,峰值保留(峰值只由后端权威)。
        nextInflight[m.model_id] = { ...(prev[m.model_id] as Inflight), current: 0 };
      } else {
        nextInflight[m.model_id] = null;
      }
    }
    setInflight(nextInflight);
    const provSum: Record<string, number> = {};
    for (const m of ms) {
      provSum[m.provider.id] =
        (provSum[m.provider.id] ?? 0) + Number(nextInflight[m.model_id]?.current ?? 0);
    }
    setProvInflight(provSum);
    setStatsMeta({ source: stats.source, started_at: stats.started_at });
  }, [statsPoll.data]);

  // ── 局部刷新:重拉全量,只替换目标行/卡片(bump nonce → 仅它 remount,其余保留草稿)──
  const refreshModel = async (modelId: string) => {
    try {
      const data = await adminGet<ModelOpsResp>("/model-ops");
      const fresh = (data.models ?? []).find((m) => m.model_id === modelId);
      if (!fresh) {
        setReloadTick((t) => t + 1);
        return;
      }
      setModels((prev) => prev.map((m) => (m.model_id === modelId ? fresh : m)));
      setInflight((prev) => ({ ...prev, [modelId]: fresh.inflight ?? null }));
      setRowNonce((n) => ({ ...n, [modelId]: (n[modelId] ?? 0) + 1 }));
    } catch {
      setReloadTick((t) => t + 1);
    }
  };
  const refreshProvider = async (id: string) => {
    try {
      const data = await adminGet<ModelOpsResp>("/model-ops");
      const fresh = (data.providers ?? []).find((p) => p.id === id);
      if (!fresh) {
        setReloadTick((t) => t + 1);
        return;
      }
      setProviders((prev) => prev.map((p) => (p.id === id ? fresh : p)));
      setProvInflight((prev) => ({ ...prev, [id]: fresh.inflight_current ?? 0 }));
      setProvNonce((n) => ({ ...n, [id]: (n[id] ?? 0) + 1 }));
    } catch {
      setReloadTick((t) => t + 1);
    }
  };

  const errMsg = (e: unknown) => apiErrorMessage(e, "请求失败");

  // ── 写路径回调 ──
  const savePricing = async (
    model: ModelRowData,
    patch: Record<string, unknown>,
    changes: PriceChange[],
  ) => {
    if (changes.length > 0) {
      const ok = await confirm({
        title: `确认价格改动 · ${model.display_name || model.model_id}`,
        body: <PriceChangeTable changes={changes} />,
        confirmText: "确认保存",
      });
      if (!ok) return;
    }
    try {
      await adminSend("PATCH", `/pricing/${encodeURIComponent(model.model_id)}`, patch);
      toast(`${model.model_id} 已保存`, "success");
      await refreshModel(model.model_id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) toast("数据已被他人修改,请刷新", "error");
      else toast(`保存失败：${errMsg(e)}`, "error");
    }
  };

  const toggleEnabled = async (model: ModelRowData, next: boolean) => {
    if (!next) {
      const ok = await confirm({
        title: `确认下线 ${model.display_name || model.model_id}?`,
        body: "现网用户立即不可选。",
        danger: true,
        confirmText: "确认下线",
      });
      if (!ok) return;
    }
    try {
      await adminSend("PATCH", `/pricing/${encodeURIComponent(model.model_id)}`, {
        enabled: next,
        if_match_lock_version: model.lock_version,
      });
      toast(next ? `${model.model_id} 已上线` : `${model.model_id} 已下线`, "success");
      await refreshModel(model.model_id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) toast("数据已被他人修改,请刷新", "error");
      else toast(`操作失败：${errMsg(e)}`, "error");
    }
  };

  const saveExtra = async (value: string | null) => {
    if (!extraModel) return;
    try {
      await adminSend("PATCH", `/pricing/${encodeURIComponent(extraModel.model_id)}`, {
        extra_system_prompt: value,
        if_match_lock_version: extraModel.lock_version,
      });
      toast(`${extraModel.model_id} 行为补丁已保存`, "success");
      const id = extraModel.model_id;
      setExtraModel(null);
      await refreshModel(id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) toast("数据已被他人修改,请刷新", "error");
      else toast(`保存失败：${errMsg(e)}`, "error");
    }
  };

  const saveProvider = async (id: string, body: Record<string, unknown>) => {
    try {
      await adminSend("PUT", `/providers/${encodeURIComponent(id)}`, body);
      toast(`${id} 已保存`, "success");
      await refreshProvider(id);
    } catch (e) {
      toast(`保存失败：${errMsg(e)}`, "error");
    }
  };

  const setHealthMode = async (provider: ProviderData, mode: HealthMode) => {
    const label = mode === "auto" ? "自动" : mode === "forced_degraded" ? "强制降级" : "强制健康";
    const ok = await confirm({
      title: `将「${provider.display_name || provider.id}」降级策略改为「${label}」?`,
      body:
        mode === "forced_healthy"
          ? "强制健康会压住实测降级,请确认服务确实可用。"
          : mode === "forced_degraded"
            ? "强制降级会让该服务商立即被调度回避。"
            : "恢复为自动:按实测健康度调度。",
      danger: mode === "forced_degraded",
    });
    if (!ok) return;
    try {
      await adminSend("PUT", `/providers/${encodeURIComponent(provider.id)}`, { health_mode: mode });
      toast(`${provider.display_name || provider.id} 降级策略 → ${label}`, "success");
      await refreshProvider(provider.id);
    } catch (e) {
      toast(`设置失败：${errMsg(e)}`, "error");
    }
  };

  if (error) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title={meta.title} desc={meta.desc} />
        <EmptyState
          icon={Inbox}
          title="加载模型与服务商失败"
          hint={apiErrorMessage(error, "加载失败")}
          action={
            <Button variant="secondary" size="sm" onClick={() => setReloadTick((t) => t + 1)}>
              重试
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={meta.title}
        desc={meta.desc}
        actions={
          <Button variant="secondary" size="sm" onClick={() => setReloadTick((t) => t + 1)}>
            <RotateCw size={15} />
            刷新
          </Button>
        }
      />

      {statsMeta.source === "local_fallback" && (
        <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
          <TriangleAlert size={15} className="shrink-0" />
          egress 统计不可达,并发数据可能不完整
        </div>
      )}

      {/* ── 服务商 ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[14px] font-semibold text-fg">服务商</h2>
          <span className="text-[12px] text-faint">
            共 {providers.length} 家 · key / 订阅 / 探测延迟 / 并发
          </span>
        </div>
        {loading ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-72 animate-pulse rounded-xl border border-border bg-surface" />
            ))}
          </div>
        ) : providers.length === 0 ? (
          <EmptyState icon={Inbox} title="无服务商" />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {providers.map((p) => (
              <ProviderCard
                key={`${p.id}:${reloadTick}:${provNonce[p.id] ?? 0}`}
                provider={p}
                inflightCurrent={provInflight[p.id] ?? 0}
                onSave={(body) => saveProvider(p.id, body)}
                onSetHealthMode={(mode) => setHealthMode(p, mode)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── 模型 ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[14px] font-semibold text-fg">模型</h2>
          <span className="text-[12px] text-faint">共 {models.length} 个 · 行内编辑,逐行保存</span>
        </div>
        <p className="text-[12px] text-faint">价格单位:分/百万token;上下线即时生效(NOTIFY 热加载)</p>
        {loading ? (
          <div className="h-64 animate-pulse rounded-xl border border-border bg-surface" />
        ) : models.length === 0 ? (
          <EmptyState icon={Inbox} title="无模型" />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-surface">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-surface">
                <tr className="border-b border-border text-left text-[12px] font-medium text-faint">
                  <th className="px-3 py-2.5">模型ID</th>
                  <th className="px-3 py-2.5">显示名</th>
                  <th className="px-3 py-2.5">服务商</th>
                  <th className="px-3 py-2.5" title="当前并发;峰值自 egress 启动累计,重启归零">
                    并发
                  </th>
                  <th className="px-3 py-2.5">24h 用量</th>
                  <th className="px-3 py-2.5">输入价</th>
                  <th className="px-3 py-2.5">输出价</th>
                  <th className="px-3 py-2.5">缓存读</th>
                  <th className="px-3 py-2.5">缓存写</th>
                  <th className="px-3 py-2.5">multiplier</th>
                  <th className="px-3 py-2.5">思考深度</th>
                  <th className="px-3 py-2.5">可见性</th>
                  <th className="px-3 py-2.5">状态</th>
                  <th className="px-3 py-2.5 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <ModelRow
                    key={`${m.model_id}:${reloadTick}:${rowNonce[m.model_id] ?? 0}`}
                    model={m}
                    inflight={inflight[m.model_id] ?? null}
                    startedAt={statsMeta.started_at}
                    onSavePricing={(patch, changes) => savePricing(m, patch, changes)}
                    onToggleEnabled={(next) => toggleEnabled(m, next)}
                    onOpenExtra={() => setExtraModel(m)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ExtraPromptModal model={extraModel} onClose={() => setExtraModel(null)} onSave={saveExtra} />
      {confirmEl}
    </div>
  );
}
