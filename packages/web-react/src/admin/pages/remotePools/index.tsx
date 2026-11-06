import { CheckCircle2, Copy, Plus, RefreshCw, Server, ShieldAlert, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Badge, Button, Checkbox, Field, Input, Modal, useConfirm, useToast } from "../../../components/ui";
import { cn } from "../../../lib/utils";
import { PageHeader, StatCard, StatCardRow } from "../../components";
import { adminGet, adminSend, apiErrorMessage } from "../../lib/adminApi";
import { useAdminPoll } from "../../lib/useAdminPoll";
import { getAdminPage } from "../../registry";

type RemoteDiscoveredModel = {
  upstream_model_id: string;
  display_name: string;
  recommended_remote_slug?: string;
};

type RemoteQuotaWindow = {
  label: string;
  usedPct: number | null;
  resetsAt: string | null;
};

type RemoteAgentNode = {
  id: string;
  label: string;
  ssh_host: string;
  ssh_port: number;
  ssh_user: string;
  host_key_fp: string;
  key_id: string;
  controller_sha256: string;
  mux_cap_slots: number;
  max_hot_slots: number;
  max_active_slots: number;
  status: string;
  health_score: number;
  rtt_ms_p50: number | null;
  rtt_ms_p95: number | null;
  last_probe_at: string | null;
  last_error: string | null;
  install_command: string;
};

type RemoteAgentProfile = {
  id: string;
  node_id: string;
  node_label?: string;
  engine: "cc" | "codex" | "antigravity" | "grok-build";
  profile_name: string;
  account_hint: string | null;
  plan_type: string | null;
  cli_version: string | null;
  runner_mode: "interactive";
  discovered_models: RemoteDiscoveredModel[];
  quota_windows: RemoteQuotaWindow[];
  status: string;
  health_score: number;
  weight: number;
  hot_slots: number;
  active_slots: number;
  max_hot_slots: number;
  max_active_slots: number;
};

type RemoteModelOffer = {
  id: string;
  profile_id: string;
  node_label?: string;
  engine?: string;
  profile_name?: string;
  upstream_model_id: string;
  canonical_model_id: string;
  base_display_name: string;
  remote_display_name: string;
  enabled: boolean;
  catalog_state: string | null;
  placement: "remote_pool";
};

type RemoteAgentBinding = {
  operation_id: string;
  uid: string;
  session_key: string;
  node_label?: string;
  profile_name?: string;
  engine?: string;
  canonical_model_id: string;
  state: string;
  generation: number;
  expires_at: string;
};

type RemotePoolResponse = {
  nodes: RemoteAgentNode[];
  profiles: RemoteAgentProfile[];
  offers: RemoteModelOffer[];
  bindings: RemoteAgentBinding[];
  controller_sha256: string;
};

const ENGINE_LABELS: Record<string, string> = {
  cc: "Claude Code (强制交互式 PTY + oc-bridge)",
  codex: "OpenAI Codex (app-server)",
  antigravity: "Google Antigravity (agy CLI)",
  "grok-build": "xAI Grok Build CLI",
};

export default function RemotePoolsPage() {
  const meta = getAdminPage("remotePools");
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();

  const [showAddModal, setShowAddModal] = useState(false);
  const [label, setLabel] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshUser, setSshUser] = useState("box");
  const [hostKeyFp, setHostKeyFp] = useState("");
  const [creatingNode, setCreatingNode] = useState(false);
  const [probingNodeId, setProbingNodeId] = useState<string | null>(null);

  const [selectedProfile, setSelectedProfile] = useState<RemoteAgentProfile | null>(null);
  const [checkedModels, setCheckedModels] = useState<Record<string, boolean>>({});
  const [publishingOffers, setPublishingOffers] = useState(false);
  const [modelQuery, setModelQuery] = useState("");

  const fetcher = useCallback(() => adminGet<RemotePoolResponse>("/api/admin/remote-pool"), []);
  const { data, loading, refresh: reload } = useAdminPoll(fetcher, { intervalMs: 30_000 });

  const nodes = data?.nodes ?? [];
  const profiles = data?.profiles ?? [];
  const offers = data?.offers ?? [];
  const bindings = data?.bindings ?? [];

  async function handleCreateNode() {
    if (!label.trim() || !sshHost.trim() || !hostKeyFp.trim()) {
      toast("请填写节点名称、SSH 地址与 HostKey SHA256 指纹", "error");
      return;
    }
    setCreatingNode(true);
    try {
      await adminSend("POST", "/api/admin/remote-pool/nodes", {
        label: label.trim(),
        ssh_host: sshHost.trim(),
        ssh_port: Number(sshPort) || 22,
        ssh_user: sshUser.trim() || "box",
        host_key_fp: hostKeyFp.trim(),
      });
      toast("远端节点已添加，可执行一键探测发现已登录底座与模型", "success");
      setShowAddModal(false);
      setLabel("");
      setSshHost("");
      setHostKeyFp("");
      reload();
    } catch (e) {
      toast(apiErrorMessage(e, "添加远端节点失败"), "error");
    } finally {
      setCreatingNode(false);
    }
  }

  async function handleProbeNode(node: RemoteAgentNode) {
    setProbingNodeId(node.id);
    try {
      await adminSend("POST", `/api/admin/remote-pool/nodes/${node.id}/probe`, {});
      toast(`已完成节点 ${node.label} 探测（CC 交互模式校验通过）`, "success");
      reload();
    } catch (e) {
      toast(apiErrorMessage(e, "探测远端节点失败"), "error");
    } finally {
      setProbingNodeId(null);
    }
  }

  async function handleDeleteNode(node: RemoteAgentNode) {
    const ok = await confirm({
      title: `删除远端节点 ${node.label}`,
      body: "将同步移除该节点下的底座 Profile 与模型上架映射，确认继续？",
      confirmText: "删除节点",
      danger: true,
    });
    if (!ok) return;
    try {
      await adminSend("DELETE", `/api/admin/remote-pool/nodes/${node.id}`);
      toast("节点已删除", "success");
      reload();
    } catch (e) {
      toast(apiErrorMessage(e, "删除失败"), "error");
    }
  }

  function openPublishModal(profile: RemoteAgentProfile) {
    const existingByUpstream = new Map(
      offers.filter((o) => o.profile_id === profile.id).map((o) => [o.upstream_model_id, o.enabled]),
    );
    const nextChecked: Record<string, boolean> = {};
    for (const m of profile.discovered_models) {
      nextChecked[m.upstream_model_id] = existingByUpstream.get(m.upstream_model_id) ?? true;
    }
    setCheckedModels(nextChecked);
    setModelQuery("");
    setSelectedProfile(profile);
  }

  function closePublishModal() {
    setSelectedProfile(null);
    setModelQuery("");
  }

  async function handlePublishCheckedModels() {
    if (!selectedProfile) return;
    setPublishingOffers(true);
    try {
      const payloadOffers = selectedProfile.discovered_models.map((m) => ({
        upstream_model_id: m.upstream_model_id,
        base_display_name: m.display_name,
        enabled: Boolean(checkedModels[m.upstream_model_id]),
      }));
      await adminSend("POST", "/api/admin/remote-pool/offers", {
        profile_id: selectedProfile.id,
        offers: payloadOffers,
      });
      toast("远端模型上架配置已同步至模型目录（前端自动带「远端」后缀）", "success");
      setSelectedProfile(null);
      reload();
    } catch (e) {
      toast(apiErrorMessage(e, "模型上架失败"), "error");
    } finally {
      setPublishingOffers(false);
    }
  }

  async function handleToggleProfileStatus(profile: RemoteAgentProfile) {
    const nextStatus = profile.status === "disabled" ? "active" : "disabled";
    try {
      await adminSend("PATCH", `/api/admin/remote-pool/profiles/${profile.id}`, {
        status: nextStatus,
      });
      toast(nextStatus === "active" ? "已恢复参与调度" : "已暂停调度", "success");
      reload();
    } catch (e) {
      toast(apiErrorMessage(e, "状态更新失败"), "error");
    }
  }

  async function handleRevokeBinding(binding: RemoteAgentBinding) {
    const ok = await confirm({
      title: "强制隔离远端会话绑定",
      body: `确认将绑定记录 ${binding.session_key} (${binding.operation_id.slice(0, 8)}) 标记为隔离状态（未经远端停止证明不宣称进程已销毁）？`,
      confirmText: "确认隔离绑定",
      danger: true,
    });
    if (!ok) return;
    try {
      await adminSend("POST", `/api/admin/remote-pool/bindings/${binding.operation_id}/revoke`, {});
      toast("远端绑定已隔离", "success");
      reload();
    } catch (e) {
      toast(apiErrorMessage(e, "操作失败"), "error");
    }
  }

  const th = "px-3 py-2.5 text-left text-meta font-medium text-muted";
  const td = "px-3 py-2.5 align-top";
  const codeCls = "rounded bg-hover px-1.5 py-0.5 font-mono text-xs text-fg";

  const existingEnabledByUpstream = new Map<string, boolean>(
    selectedProfile
      ? offers
          .filter((o) => o.profile_id === selectedProfile.id)
          .map((o) => [o.upstream_model_id, o.enabled] as [string, boolean])
      : [],
  );
  const allModels = selectedProfile?.discovered_models ?? [];
  const q = modelQuery.trim().toLowerCase();
  const filteredModels = q
    ? allModels.filter((m) => {
        const slug = m.recommended_remote_slug ?? `${m.upstream_model_id}-remote`;
        return (
          m.display_name.toLowerCase().includes(q) ||
          m.upstream_model_id.toLowerCase().includes(q) ||
          slug.toLowerCase().includes(q)
        );
      })
    : allModels;
  const checkedCount = allModels.filter((m) => checkedModels[m.upstream_model_id]).length;

  function setManyChecked(models: RemoteDiscoveredModel[], value: boolean) {
    setCheckedModels((prev) => {
      const next = { ...prev };
      for (const m of models) next[m.upstream_model_id] = value;
      return next;
    });
  }

  return (
    <div>
      {confirmEl}
      <PageHeader
        title={meta.title}
        desc={meta.desc}
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => reload()} disabled={loading}>
              <RefreshCw size={14} /> 刷新
            </Button>
            <Button variant="primary" size="sm" onClick={() => setShowAddModal(true)}>
              <Plus size={14} /> 添加远端节点
            </Button>
          </div>
        }
      />

      <StatCardRow>
        <StatCard
          label="在线远端节点"
          value={`${nodes.filter((n) => n.status === "active").length} / ${nodes.length}`}
          hint="SSH ControlMaster 常驻通道"
        />
        <StatCard
          label="已探测底座 Profile"
          value={String(profiles.length)}
          hint="支持 cc / codex / antigravity / grok-build"
        />
        <StatCard
          label="已上架「远端」模型"
          value={String(offers.filter((o) => o.enabled).length)}
          hint="过渡期前端显示名自动带「远端」后缀"
        />
        <StatCard
          label="活跃热驻留会话"
          value={String(bindings.length)}
          hint="24h 滑动租约 · Stop 仅中断回合不杀会话"
        />
      </StatCardRow>

      <div className="my-3.5 flex items-start gap-2.5 rounded-lg border border-success/30 bg-success-soft px-4 py-3 text-sm text-fg">
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />
        <div>
          <strong>CC 交互模式铁律门禁已开启：</strong>
          所有远端 <code className={codeCls}>cc</code> (Claude Code) 节点 100% 强制通过{" "}
          <code className={codeCls}>tmux PTY + oc-bridge Hook</code> 交互式终端会话驱动，严禁退化为{" "}
          <code className={codeCls}>claude -p</code> print 模式；模型勾选上架后，用户选择器将自动呈现为{" "}
          <strong>「模型名 远端」</strong>。
        </div>
      </div>

      {/* 1. 远端节点列表 */}
      <section className="mt-5">
        <h3 className="mb-2.5 flex items-center gap-1.5 text-base font-semibold text-fg">
          <Server size={16} /> 远端主机节点 ({nodes.length})
        </h3>
        {nodes.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-surface p-6 text-center text-sm text-muted">
            暂无远端节点，点击右上角「添加远端节点」接入谷歌云或海外开发机（如 cc5-us）。
          </div>
        ) : (
          <div className="grid gap-3">
            {nodes.map((n) => (
              <div key={n.id} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <strong className="text-base text-fg">{n.label}</strong>
                    <code className={codeCls}>
                      {n.ssh_user}@{n.ssh_host}:{n.ssh_port}
                    </code>
                    <Badge tone={n.status === "active" ? "success" : "warning"}>
                      {n.status === "active" ? "在线 (active)" : n.status}
                    </Badge>
                    {n.rtt_ms_p50 != null && (
                      <span className="text-xs text-muted">
                        RTT p50: {n.rtt_ms_p50}ms / p95: {n.rtt_ms_p95 ?? "-"}ms
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={probingNodeId === n.id}
                      onClick={() => handleProbeNode(n)}
                    >
                      <Sparkles size={14} /> {probingNodeId === n.id ? "探测中…" : "自动探测底座与模型"}
                    </Button>
                    <Button variant="ghost" size="sm" aria-label="删除节点" onClick={() => handleDeleteNode(n)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span>
                    HostKey: <code className="font-mono text-fg">{n.host_key_fp}</code>
                  </span>
                  <span>· 受限公钥一键部署命令：</span>
                  <code className="max-w-[520px] truncate rounded bg-hover px-1.5 py-0.5 font-mono text-[11px] text-fg">
                    {n.install_command}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(n.install_command);
                      toast("已复制受限 authorized_keys 安装命令", "success");
                    }}
                  >
                    <Copy size={12} /> 复制命令
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 2. 已探测的四大底座 Profile 与模型勾选上架 */}
      <section className="mt-6">
        <h3 className="mb-2.5 text-base font-semibold text-fg">
          已探测远端底座 Profile 与额度窗口 ({profiles.length})
        </h3>
        {profiles.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-surface p-5 text-sm text-muted">
            添加节点后点击「自动探测底座与模型」，系统将自动识别节点上的{" "}
            <code className={codeCls}>cc</code>、<code className={codeCls}>codex</code>、
            <code className={codeCls}>antigravity</code>、<code className={codeCls}>grok-build</code>{" "}
            登录态与可用模型。
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full border-collapse text-sm text-fg">
              <thead>
                <tr className="border-b border-border bg-elevated">
                  <th className={th}>节点 / 底座</th>
                  <th className={th}>账号 / 套餐</th>
                  <th className={th}>运行模式</th>
                  <th className={th}>5h / 7d 额度窗口</th>
                  <th className={th}>热驻留 / 活跃槽位</th>
                  <th className={th}>状态</th>
                  <th className={th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-b-0">
                    <td className={td}>
                      <div>
                        <strong>{p.node_label ?? p.node_id.slice(0, 8)}</strong>
                      </div>
                      <div className="text-xs text-muted">
                        {ENGINE_LABELS[p.engine] ?? p.engine} · <code className="font-mono">{p.profile_name}</code>
                      </div>
                    </td>
                    <td className={td}>
                      <div>{p.account_hint ?? "-"}</div>
                      <div className="text-xs text-muted">
                        {p.plan_type ?? "pro"} · {p.cli_version ?? ""}
                      </div>
                    </td>
                    <td className={td}>
                      <Badge tone="success">
                        {p.engine === "cc" ? "interactive (tmux+oc-bridge)" : p.runner_mode}
                      </Badge>
                    </td>
                    <td className={td}>
                      {p.quota_windows.length === 0 ? (
                        <span className="text-muted">待上报</span>
                      ) : (
                        <div className="flex gap-2">
                          {p.quota_windows.map((w) => (
                            <Badge key={w.label} tone="neutral">
                              {w.label}: {w.usedPct != null ? `${w.usedPct}%` : "-"}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className={td}>
                      <code className="font-mono text-xs">
                        hot {p.hot_slots}/{p.max_hot_slots}
                      </code>{" "}
                      ·{" "}
                      <code className="font-mono text-xs">
                        act {p.active_slots}/{p.max_active_slots}
                      </code>
                    </td>
                    <td className={td}>
                      <Badge tone={p.status === "active" ? "success" : "neutral"}>{p.status}</Badge>
                    </td>
                    <td className={td}>
                      <div className="flex gap-1.5">
                        <Button variant="primary" size="sm" onClick={() => openPublishModal(p)}>
                          勾选模型上架 ({p.discovered_models.length})
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => handleToggleProfileStatus(p)}>
                          {p.status === "disabled" ? "启用" : "停用"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 3. 已上架的过渡期远端模型预览 */}
      {offers.length > 0 && (
        <section className="mt-6">
          <h3 className="mb-2.5 text-base font-semibold text-fg">
            已上架远端模型（前端模型选择器自动带「远端」后缀）
          </h3>
          <div className="flex flex-wrap gap-2.5">
            {offers.map((o) => (
              <div key={o.id} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <strong className="text-fg">{o.remote_display_name}</strong>
                  <Badge tone={o.enabled ? "success" : "neutral"} size="sm">
                    {o.enabled ? "已上架" : "已下架"}
                  </Badge>
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  Catalog ID: <code className="font-mono text-fg">{o.canonical_model_id}</code> · 节点:{" "}
                  {o.node_label ?? "-"} ({o.engine})
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 4. 活跃会话绑定运维表 */}
      {bindings.length > 0 && (
        <section className="mt-6">
          <h3 className="mb-2.5 text-base font-semibold text-fg">活跃远端会话绑定 ({bindings.length})</h3>
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full border-collapse text-sm text-fg">
              <thead>
                <tr className="border-b border-border bg-elevated">
                  <th className={th}>Operation ID</th>
                  <th className={th}>UID / SessionKey</th>
                  <th className={th}>节点 / 模型</th>
                  <th className={th}>状态 / Generation</th>
                  <th className={th}>租约到期</th>
                  <th className={th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {bindings.map((b) => (
                  <tr key={b.operation_id} className="border-b border-border last:border-b-0">
                    <td className={td}>
                      <code className="font-mono text-xs">{b.operation_id.slice(0, 8)}</code>
                    </td>
                    <td className={td}>
                      UID {b.uid} · <code className="font-mono text-xs">{b.session_key}</code>
                    </td>
                    <td className={td}>
                      {b.node_label ?? "-"} · <code className="font-mono text-xs">{b.canonical_model_id}</code>
                    </td>
                    <td className={td}>
                      {b.state} (gen {b.generation})
                    </td>
                    <td className={td}>{new Date(b.expires_at).toLocaleString()}</td>
                    <td className={td}>
                      <Button variant="secondary" size="sm" onClick={() => handleRevokeBinding(b)}>
                        <ShieldAlert size={13} /> 强制销毁
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 添加远端节点弹窗 */}
      <Modal
        open={showAddModal}
        onOpenChange={(o) => {
          if (!creatingNode) setShowAddModal(o);
        }}
        title="添加远端底座节点"
        description="接入后可一键探测节点上已登录的底座与可用模型。"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowAddModal(false)} disabled={creatingNode}>
              取消
            </Button>
            <Button variant="primary" size="sm" onClick={handleCreateNode} disabled={creatingNode}>
              {creatingNode ? "保存中…" : "确认添加"}
            </Button>
          </div>
        }
      >
        <div className="grid gap-3">
          <Field label="节点标签 (Label)">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如：cc5-us-gcp-1" />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr_1fr]">
            <Field label="SSH 主机 (IP / 域名)">
              <Input value={sshHost} onChange={(e) => setSshHost(e.target.value)} placeholder="136.86.172.84" />
            </Field>
            <Field label="SSH 端口">
              <Input value={sshPort} onChange={(e) => setSshPort(e.target.value)} placeholder="22" />
            </Field>
            <Field label="SSH 用户名">
              <Input value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="box" />
            </Field>
          </div>
          <Field label="SSH HostKey SHA256 指纹（防 MITM 强制校验）">
            <Input
              value={hostKeyFp}
              onChange={(e) => setHostKeyFp(e.target.value)}
              placeholder="SHA256:44charactersBase64HostKeyFingerprintHere="
            />
          </Field>
        </div>
      </Modal>

      {/* 勾选模型上架弹窗 */}
      <Modal
        open={selectedProfile != null}
        onOpenChange={(o) => {
          if (!o && !publishingOffers) closePublishModal();
        }}
        size="lg"
        title={
          selectedProfile
            ? `勾选模型上架 — ${selectedProfile.node_label ?? ""} (${selectedProfile.engine}/${selectedProfile.profile_name})`
            : "勾选模型上架"
        }
        description={
          <>
            勾选后将以单事务写入 <code className="font-mono text-fg">model_catalog</code> (
            <code className="font-mono text-fg">placement=&apos;remote_pool&apos;</code>
            )，并在前端模型选择器中自动附加「<strong className="text-fg">远端</strong>」后缀。
          </>
        }
        toolbar={
          <div className="flex flex-col gap-2.5 px-1 pb-3">
            <Input
              value={modelQuery}
              onChange={(e) => setModelQuery(e.target.value)}
              placeholder="搜索模型名 / 上游 ID / 目录 ID"
              aria-label="搜索模型"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted">
                已选 <strong className="text-fg">{checkedCount}</strong> / 共 {allModels.length} 个模型
                {q && <> · 筛选出 {filteredModels.length} 个</>}
              </span>
              <div className="flex flex-wrap gap-1.5">
                <Button variant="secondary" size="sm" onClick={() => setManyChecked(filteredModels, true)}>
                  全选当前
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setManyChecked(allModels, false)}>
                  全不选
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setCheckedModels(
                      Object.fromEntries(
                        allModels.map((m) => [m.upstream_model_id, existingEnabledByUpstream.get(m.upstream_model_id) === true]),
                      ),
                    )
                  }
                >
                  仅选已上架
                </Button>
              </div>
            </div>
          </div>
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={closePublishModal} disabled={publishingOffers}>
              取消
            </Button>
            <Button variant="primary" size="sm" onClick={handlePublishCheckedModels} disabled={publishingOffers}>
              {publishingOffers ? "同步中…" : "确认上架所选模型"}
            </Button>
          </div>
        }
      >
        <div className="grid gap-2">
          {filteredModels.length === 0 && (
            <div className="rounded-lg border border-dashed border-border bg-surface p-6 text-center text-sm text-muted">
              {allModels.length === 0 ? "该底座尚未探测到可用模型。" : "没有匹配的模型，换个关键词试试。"}
            </div>
          )}
          {filteredModels.map((m) => {
            const remoteSlug = m.recommended_remote_slug ?? `${m.upstream_model_id}-remote`;
            const previewName = m.display_name.endsWith(" 远端") ? m.display_name : `${m.display_name} 远端`;
            const checked = Boolean(checkedModels[m.upstream_model_id]);
            const wasEnabled = existingEnabledByUpstream.get(m.upstream_model_id) === true;
            return (
              <label
                key={m.upstream_model_id}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 transition-colors",
                  checked
                    ? "border-accent/50 bg-accent/5 hover:bg-accent/10"
                    : "border-border bg-elevated hover:bg-hover",
                )}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Checkbox
                    checked={checked}
                    aria-label={previewName}
                    onChange={(e) =>
                      setCheckedModels((prev) => ({ ...prev, [m.upstream_model_id]: e.target.checked }))
                    }
                  />
                  <div className="min-w-0">
                    <div className="truncate font-medium text-fg">{previewName}</div>
                    <div className="truncate font-mono text-xs text-muted">
                      {m.upstream_model_id} → {remoteSlug}
                    </div>
                  </div>
                </div>
                <Badge tone={wasEnabled && checked ? "success" : checked ? "accent" : "neutral"} size="sm">
                  {wasEnabled && checked ? "已上架" : checked ? "待上架" : wasEnabled ? "将下架" : "未启用"}
                </Badge>
              </label>
            );
          })}
        </div>
      </Modal>
    </div>
  );
}
