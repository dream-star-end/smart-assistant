import { CheckCircle2, Copy, Plus, RefreshCw, Server, ShieldAlert, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Button, useConfirm, useToast } from "../../../components/ui";
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

  const fetcher = useCallback(() => adminGet<RemotePoolResponse>("/api/admin/remote-pool"), []);
  const { data, loading, reload } = useAdminPoll(fetcher, [], { intervalMs: 30_000 });

  const nodes = data?.nodes ?? [];
  const profiles = data?.profiles ?? [];
  const offers = data?.offers ?? [];
  const bindings = data?.bindings ?? [];

  async function handleCreateNode() {
    if (!label.trim() || !sshHost.trim() || !hostKeyFp.trim()) {
      toast.error("请填写节点名称、SSH 地址与 HostKey SHA256 指纹");
      return;
    }
    setCreatingNode(true);
    try {
      await adminSend("/api/admin/remote-pool/nodes", "POST", {
        label: label.trim(),
        ssh_host: sshHost.trim(),
        ssh_port: Number(sshPort) || 22,
        ssh_user: sshUser.trim() || "box",
        host_key_fp: hostKeyFp.trim(),
      });
      toast.success("远端节点已添加，可执行一键探测发现已登录底座与模型");
      setShowAddModal(false);
      setLabel("");
      setSshHost("");
      setHostKeyFp("");
      reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, "添加远端节点失败"));
    } finally {
      setCreatingNode(false);
    }
  }

  async function handleProbeNode(node: RemoteAgentNode) {
    setProbingNodeId(node.id);
    try {
      await adminSend(`/api/admin/remote-pool/nodes/${node.id}/probe`, "POST", {});
      toast.success(`已完成节点 ${node.label} 探测（CC 交互模式校验通过）`);
      reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, "探测远端节点失败"));
    } finally {
      setProbingNodeId(null);
    }
  }

  async function handleDeleteNode(node: RemoteAgentNode) {
    const ok = await confirm({
      title: `删除远端节点 ${node.label}`,
      description: "将同步移除该节点下的底座 Profile 与模型上架映射，确认继续？",
      confirmText: "删除节点",
      danger: true,
    });
    if (!ok) return;
    try {
      await adminSend(`/api/admin/remote-pool/nodes/${node.id}`, "DELETE");
      toast.success("节点已删除");
      reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, "删除失败"));
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
    setSelectedProfile(profile);
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
      await adminSend("/api/admin/remote-pool/offers", "POST", {
        profile_id: selectedProfile.id,
        offers: payloadOffers,
      });
      toast.success("远端模型上架配置已同步至模型目录（前端自动带「远端」后缀）");
      setSelectedProfile(null);
      reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, "模型上架失败"));
    } finally {
      setPublishingOffers(false);
    }
  }

  async function handleToggleProfileStatus(profile: RemoteAgentProfile) {
    const nextStatus = profile.status === "disabled" ? "active" : "disabled";
    try {
      await adminSend(`/api/admin/remote-pool/profiles/${profile.id}`, "PATCH", {
        status: nextStatus,
      });
      toast.success(nextStatus === "active" ? "已恢复参与调度" : "已暂停调度");
      reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, "状态更新失败"));
    }
  }

  async function handleRevokeBinding(binding: RemoteAgentBinding) {
    const ok = await confirm({
      title: "强制隔离远端会话绑定",
      description: `确认将绑定记录 ${binding.session_key} (${binding.operation_id.slice(0, 8)}) 标记为隔离状态（未经远端停止证明不宣称进程已销毁）？`,
      confirmText: "确认隔离绑定",
      danger: true,
    });
    if (!ok) return;
    try {
      await adminSend(`/api/admin/remote-pool/bindings/${binding.operation_id}/revoke`, "POST", {});
      toast.success("远端绑定已隔离");
      reload();
    } catch (e) {
      toast.error(apiErrorMessage(e, "操作失败"));
    }
  }

  return (
    <div>
      {confirmEl}
      <PageHeader
        title={meta.title}
        desc={meta.desc}
        actions={
          <div style={{ display: "flex", gap: 8 }}>
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

      <div
        style={{
          margin: "14px 0",
          padding: "12px 16px",
          borderRadius: 8,
          background: "var(--bg-subtle, rgba(16, 185, 129, 0.08))",
          border: "1px solid rgba(16, 185, 129, 0.25)",
          fontSize: 13,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <CheckCircle2 size={16} style={{ color: "#10b981", flexShrink: 0 }} />
        <div>
          <strong>CC 交互模式铁律门禁已开启：</strong>
          所有远端 <code>cc</code> (Claude Code) 节点 100% 强制通过{" "}
          <code>tmux PTY + oc-bridge Hook</code> 交互式终端会话驱动，严禁退化为{" "}
          <code>claude -p</code> print 模式；模型勾选上架后，用户选择器将自动呈现为{" "}
          <strong>「模型名 远端」</strong>。
        </div>
      </div>

      {/* 1. 远端节点列表 */}
      <section style={{ marginTop: 18 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
          <Server size={16} /> 远端主机节点 ({nodes.length})
        </h3>
        {nodes.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", border: "1px dashed var(--border)", borderRadius: 8, color: "var(--fg-muted)" }}>
            暂无远端节点，点击右上角「添加远端节点」接入谷歌云或海外开发机（如 cc5-us）。
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {nodes.map((n) => (
              <div
                key={n.id}
                style={{
                  padding: 14,
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--bg-card)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <strong style={{ fontSize: 15 }}>{n.label}</strong>
                    <code style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4, background: "var(--bg-muted)" }}>
                      {n.ssh_user}@{n.ssh_host}:{n.ssh_port}
                    </code>
                    <span
                      style={{
                        fontSize: 12,
                        padding: "2px 8px",
                        borderRadius: 999,
                        background: n.status === "active" ? "rgba(16,185,129,0.15)" : "rgba(245,158,11,0.15)",
                        color: n.status === "active" ? "#10b981" : "#f59e0b",
                      }}
                    >
                      {n.status === "active" ? "在线 (active)" : n.status}
                    </span>
                    {n.rtt_ms_p50 != null && (
                      <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                        RTT p50: {n.rtt_ms_p50}ms / p95: {n.rtt_ms_p95 ?? "-"}ms
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={probingNodeId === n.id}
                      onClick={() => handleProbeNode(n)}
                    >
                      <Sparkles size={14} /> {probingNodeId === n.id ? "探测中…" : "自动探测底座与模型"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDeleteNode(n)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "var(--fg-muted)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span>HostKey: <code>{n.host_key_fp}</code></span>
                  <span>· 受限公钥一键部署命令：</span>
                  <code style={{ fontSize: 11, padding: "2px 6px", background: "var(--bg-muted)", borderRadius: 4, maxWidth: 520, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {n.install_command}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(n.install_command);
                      toast.success("已复制受限 authorized_keys 安装命令");
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
      <section style={{ marginTop: 24 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
          已探测远端底座 Profile 与额度窗口 ({profiles.length})
        </h3>
        {profiles.length === 0 ? (
          <div style={{ padding: 20, border: "1px dashed var(--border)", borderRadius: 8, color: "var(--fg-muted)", fontSize: 13 }}>
            添加节点后点击「自动探测底座与模型」，系统将自动识别节点上的 <code>cc</code>、<code>codex</code>、<code>antigravity</code>、<code>grok-build</code> 登录态与可用模型。
          </div>
        ) : (
          <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-muted)", textAlign: "left" }}>
                  <th style={{ padding: "10px 12px" }}>节点 / 底座</th>
                  <th style={{ padding: "10px 12px" }}>账号 / 套餐</th>
                  <th style={{ padding: "10px 12px" }}>运行模式</th>
                  <th style={{ padding: "10px 12px" }}>5h / 7d 额度窗口</th>
                  <th style={{ padding: "10px 12px" }}>热驻留 / 活跃槽位</th>
                  <th style={{ padding: "10px 12px" }}>状态</th>
                  <th style={{ padding: "10px 12px" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => (
                  <tr key={p.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "10px 12px" }}>
                      <div><strong>{p.node_label ?? p.node_id.slice(0, 8)}</strong></div>
                      <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                        {ENGINE_LABELS[p.engine] ?? p.engine} · <code>{p.profile_name}</code>
                      </div>
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <div>{p.account_hint ?? "-"}</div>
                      <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>{p.plan_type ?? "pro"} · {p.cli_version ?? ""}</div>
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <code style={{ fontSize: 12, color: "#10b981" }}>
                        {p.engine === "cc" ? "interactive (tmux+oc-bridge)" : p.runner_mode}
                      </code>
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      {p.quota_windows.length === 0 ? (
                        <span style={{ color: "var(--fg-muted)" }}>待上报</span>
                      ) : (
                        <div style={{ display: "flex", gap: 8 }}>
                          {p.quota_windows.map((w) => (
                            <span key={w.label} style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4, background: "var(--bg-muted)" }}>
                              {w.label}: {w.usedPct != null ? `${w.usedPct}%` : "-"}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <code>hot {p.hot_slots}/{p.max_hot_slots}</code> · <code>act {p.active_slots}/{p.max_active_slots}</code>
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <span style={{ color: p.status === "active" ? "#10b981" : "var(--fg-muted)" }}>
                        {p.status}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <div style={{ display: "flex", gap: 6 }}>
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
        <section style={{ marginTop: 24 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
            已上架远端模型（前端模型选择器自动带「远端」后缀）
          </h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {offers.map((o) => (
              <div
                key={o.id}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--bg-card)",
                  fontSize: 13,
                }}
              >
                <div>
                  <strong>{o.remote_display_name}</strong>{" "}
                  <span style={{ fontSize: 11, color: o.enabled ? "#10b981" : "var(--fg-muted)" }}>
                    ({o.enabled ? "已上架" : "已下架"})
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                  Catalog ID: <code>{o.canonical_model_id}</code> · 节点: {o.node_label ?? "-"} ({o.engine})
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 4. 活跃会话绑定运维表 */}
      {bindings.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
            活跃远端会话绑定 ({bindings.length})
          </h3>
          <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-muted)", textAlign: "left" }}>
                  <th style={{ padding: "8px 12px" }}>Operation ID</th>
                  <th style={{ padding: "8px 12px" }}>UID / SessionKey</th>
                  <th style={{ padding: "8px 12px" }}>节点 / 模型</th>
                  <th style={{ padding: "8px 12px" }}>状态 / Generation</th>
                  <th style={{ padding: "8px 12px" }}>租约到期</th>
                  <th style={{ padding: "8px 12px" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {bindings.map((b) => (
                  <tr key={b.operation_id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "8px 12px" }}><code>{b.operation_id.slice(0, 8)}</code></td>
                    <td style={{ padding: "8px 12px" }}>UID {b.uid} · <code>{b.session_key}</code></td>
                    <td style={{ padding: "8px 12px" }}>{b.node_label ?? "-"} · <code>{b.canonical_model_id}</code></td>
                    <td style={{ padding: "8px 12px" }}>{b.state} (gen {b.generation})</td>
                    <td style={{ padding: "8px 12px" }}>{new Date(b.expires_at).toLocaleString()}</td>
                    <td style={{ padding: "8px 12px" }}>
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
      {showAddModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div style={{ width: 520, maxWidth: "92vw", background: "var(--bg-card, #1e1e24)", padding: 20, borderRadius: 10, border: "1px solid var(--border)" }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>添加远端底座节点</h3>
            <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
              <label>
                <div>节点标签 (Label)</div>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="例如：cc5-us-gcp-1"
                  style={{ width: "100%", padding: "6px 10px", marginTop: 4, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-input, transparent)", color: "inherit" }}
                />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8 }}>
                <label>
                  <div>SSH 主机 (IP / 域名)</div>
                  <input
                    value={sshHost}
                    onChange={(e) => setSshHost(e.target.value)}
                    placeholder="136.86.172.84"
                    style={{ width: "100%", padding: "6px 10px", marginTop: 4, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-input, transparent)", color: "inherit" }}
                  />
                </label>
                <label>
                  <div>SSH 端口</div>
                  <input
                    value={sshPort}
                    onChange={(e) => setSshPort(e.target.value)}
                    placeholder="22"
                    style={{ width: "100%", padding: "6px 10px", marginTop: 4, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-input, transparent)", color: "inherit" }}
                  />
                </label>
                <label>
                  <div>SSH 用户名</div>
                  <input
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    placeholder="box"
                    style={{ width: "100%", padding: "6px 10px", marginTop: 4, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-input, transparent)", color: "inherit" }}
                  />
                </label>
              </div>
              <label>
                <div>SSH HostKey SHA256 指纹（防 MITM 强制校验）</div>
                <input
                  value={hostKeyFp}
                  onChange={(e) => setHostKeyFp(e.target.value)}
                  placeholder="SHA256:44charactersBase64HostKeyFingerprintHere="
                  style={{ width: "100%", padding: "6px 10px", marginTop: 4, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-input, transparent)", color: "inherit" }}
                />
              </label>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <Button variant="secondary" size="sm" onClick={() => setShowAddModal(false)}>
                取消
              </Button>
              <Button variant="primary" size="sm" onClick={handleCreateNode} disabled={creatingNode}>
                {creatingNode ? "保存中…" : "确认添加"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 勾选模型上架弹窗 */}
      {selectedProfile && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div style={{ width: 560, maxWidth: "92vw", background: "var(--bg-card, #1e1e24)", padding: 20, borderRadius: 10, border: "1px solid var(--border)" }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
              勾选模型上架 — {selectedProfile.node_label} ({selectedProfile.engine}/{selectedProfile.profile_name})
            </h3>
            <p style={{ fontSize: 12, color: "var(--fg-muted)", marginBottom: 12 }}>
              勾选后将以单事务写入 <code>model_catalog</code> (<code>placement=&apos;remote_pool&apos;</code>)，并在前端模型选择器中自动附加「<strong>远端</strong>」后缀。
            </p>
            <div style={{ display: "grid", gap: 8 }}>
              {selectedProfile.discovered_models.map((m) => {
                const remoteSlug = m.recommended_remote_slug ?? `${m.upstream_model_id}-remote`;
                const previewName = m.display_name.endsWith(" 远端") ? m.display_name : `${m.display_name} 远端`;
                return (
                  <label
                    key={m.upstream_model_id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "8px 12px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={Boolean(checkedModels[m.upstream_model_id])}
                        onChange={(e) =>
                          setCheckedModels((prev) => ({
                            ...prev,
                            [m.upstream_model_id]: e.target.checked,
                          }))
                        }
                      />
                      <div>
                        <div style={{ fontWeight: 600 }}>{previewName}</div>
                        <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                          上游: <code>{m.upstream_model_id}</code> → 目录 ID: <code>{remoteSlug}</code>
                        </div>
                      </div>
                    </div>
                    <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: "rgba(16,185,129,0.15)", color: "#10b981" }}>
                      自动「远端」后缀
                    </span>
                  </label>
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <Button variant="secondary" size="sm" onClick={() => setSelectedProfile(null)}>
                取消
              </Button>
              <Button variant="primary" size="sm" onClick={handlePublishCheckedModels} disabled={publishingOffers}>
                {publishingOffers ? "同步中…" : "确认上架所选模型"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
