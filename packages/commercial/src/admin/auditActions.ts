/**
 * admin_audit action 单一权威注册表(审计体系整改批)。
 *
 * 动机:此前 action 是各调用点内联字符串,写入侧零校验,已出现命名破格
 * (`blocked_route_bypass` 无点号——已迁 security_events)与层级分歧
 * (`credits.adjust` vs `org.credits.adjust`——已统一为 `user.credits.adjust`)。
 * 本表把 action 收敛为编译期字面量类型 + 运行时校验,新增 admin 操作审计
 * 必须先在这里登记,消除"每加一个 action 多一种拼法"的一整类风险。
 *
 * 每个 action 声明两个属性:
 *   kind — 'write' 变更操作 / 'read' 敏感读取(导出、看会话、拉容器日志)。
 *          读写共用 admin_audit 一张表(读敏感数据本身就是需留痕的操作),
 *          UI/查询按 kind 派生的 action 集合过滤,不在表里冗余存 kind 列。
 *   mode — 审计写入失败时的政策:
 *     'tx'          fail-closed:审计失败 → 业务失败。有业务事务的场景必须在事务内
 *                   调 writeAdminAudit(传 tx client,失败回滚);无事务的敏感读
 *                   (sessions.read)则阻断响应——"记不下你看过,就不给看"。
 *                   资金/权限/封禁/计费配置类强制此档。
 *     'best-effort' 业务成功后补写(writeAdminAuditBestEffort):失败不冒泡,
 *                   但 writeAdminAudit 内部已发 critical 告警 + Prometheus 计数,
 *                   丢失是"响亮的",不是静默的。
 *   writeAdminAuditBestEffort 对 mode='tx' 的 action 直接抛错(编程错误,fail-fast),
 *   这是"敏感操作不得降级为 best-effort"政策的运行时执行点。
 *
 * 命名约定(写入侧校验强制):全小写 `名词[.子名词].动词`,如 `user.patch` /
 * `user.credits.adjust` / `marketplace.skill.revoke`。target 约定 `类型:id`。
 */

export interface AdminAuditActionSpec {
  kind: "write" | "read";
  mode: "tx" | "best-effort";
}

export const ADMIN_AUDIT_ACTIONS = {
  // ── 用户/组织(资金与权限面,一律 tx fail-closed)─────────────────
  "user.patch": { kind: "write", mode: "tx" },
  "user.credits.adjust": { kind: "write", mode: "tx" },
  "org.create": { kind: "write", mode: "tx" },
  "org.patch": { kind: "write", mode: "tx" },
  "org.credits.adjust": { kind: "write", mode: "tx" },
  "org.invoice.process": { kind: "write", mode: "tx" },

  // ── 计费/模型配置(tx)────────────────────────────────────────────
  "pricing.patch": { kind: "write", mode: "tx" },
  "plan.patch": { kind: "write", mode: "tx" },
  "model_grant.add": { kind: "write", mode: "tx" },
  "model_grant.remove": { kind: "write", mode: "tx" },
  "provider_ops.put": { kind: "write", mode: "tx" },
  // 模型 catalog 状态机(0135 / 方案 §7 步 5)。catalog 是**执行与计费的安全权威表**
  // (哪个模型能跑、跑成什么样、按什么价扣),全部 tx fail-closed:审计写不下去 = 业务回滚。
  "model_catalog.stage": { kind: "write", mode: "tx" },
  "model_catalog.activate": { kind: "write", mode: "tx" },
  "model_catalog.disable": { kind: "write", mode: "tx" },
  "model_catalog.switch": { kind: "write", mode: "tx" },

  // ── 系统配置(tx)─────────────────────────────────────────────────
  "system_settings.set": { kind: "write", mode: "tx" },
  "literature_config.patch": { kind: "write", mode: "tx" },
  "research_config.patch": { kind: "write", mode: "tx" },
  "research_config.secret": { kind: "write", mode: "tx" },

  // ── 告警面(channel CRUD 走 tx;test/retry 是无业务 tx 的动作)────
  "alert_channel.create": { kind: "write", mode: "tx" },
  "alert_channel.patch": { kind: "write", mode: "tx" },
  "alert_channel.delete": { kind: "write", mode: "tx" },
  "alert_channel.reactivate": { kind: "write", mode: "tx" },
  "alert_channel.test": { kind: "write", mode: "best-effort" },
  "alert_silence.create": { kind: "write", mode: "tx" },
  "alert_silence.delete": { kind: "write", mode: "tx" },
  "alert_rule.ack": { kind: "write", mode: "tx" },
  "alert_outbox.retry": { kind: "write", mode: "best-effort" },

  // ── 自愈体系(v5 selfheal)—— 全部 tx fail-closed(运维处置必须留痕)─
  "incident.resolve": { kind: "write", mode: "tx" },
  // 收尾批 H1b:解除 condition 压制(误压回滚;target=condition:<key>)。
  "condition.unsuppress": { kind: "write", mode: "tx" },
  // 收尾批 §B:一键放行 pending_release 的 Tier2 修复部署(target=repair:<id>)。
  "repair.release": { kind: "write", mode: "tx" },

  // ── 反馈/收件箱────────────────────────────────────────────────────
  "feedback.ack": { kind: "write", mode: "tx" },
  "inbox.create": { kind: "write", mode: "best-effort" },
  "inbox.delete": { kind: "write", mode: "best-effort" },

  // ── 账号池/中继/出口代理(操作本身多步非事务,best-effort)────────
  "account.create": { kind: "write", mode: "best-effort" },
  "account.patch": { kind: "write", mode: "best-effort" },
  "account.reset_cooldown": { kind: "write", mode: "best-effort" },
  "account.delete": { kind: "write", mode: "best-effort" },
  "account_group.create": { kind: "write", mode: "best-effort" },
  "account_group.patch": { kind: "write", mode: "best-effort" },
  "account_group.delete": { kind: "write", mode: "best-effort" },
  "account_group.models.set": { kind: "write", mode: "best-effort" },
  "relay_credential.create": { kind: "write", mode: "best-effort" },
  "relay_credential.patch": { kind: "write", mode: "best-effort" },
  "relay_credential.delete": { kind: "write", mode: "best-effort" },
  "egress_proxy.create": { kind: "write", mode: "best-effort" },
  "egress_proxy.patch": { kind: "write", mode: "best-effort" },
  "egress_proxy.delete": { kind: "write", mode: "best-effort" },
  "oauth.exchange": { kind: "write", mode: "best-effort" },

  // ── 容器/compute host 运维──────────────────────────────────────────
  "agent_container.restart": { kind: "write", mode: "best-effort" },
  "agent_container.stop": { kind: "write", mode: "best-effort" },
  "agent_container.remove": { kind: "write", mode: "best-effort" },
  "agent_container.logs": { kind: "read", mode: "best-effort" },
  "compute_host.create": { kind: "write", mode: "best-effort" },
  "compute_host.drain": { kind: "write", mode: "best-effort" },
  "compute_host.revoke": { kind: "write", mode: "best-effort" },
  "compute_host.remove": { kind: "write", mode: "best-effort" },
  "compute_host.quarantine_clear": { kind: "write", mode: "best-effort" },
  "compute_host.update_expires_at": { kind: "write", mode: "best-effort" },
  "compute_host.distribute_image_all": { kind: "write", mode: "best-effort" },
  "compute_host.distribute_image": { kind: "write", mode: "best-effort" },

  // ── 市场技能人工运营(整改批新增覆盖:此前上/下架完全无痕)────────
  // review/revoke 的业务 tx 在 marketplaceDb 内部,handler 层拿不到 client,
  // 走 best-effort(失败有 critical 告警,非静默)。
  "marketplace.skill.review": { kind: "write", mode: "best-effort" },
  "marketplace.skill.review_batch": { kind: "write", mode: "best-effort" },
  "marketplace.skill.revoke": { kind: "write", mode: "best-effort" },
  "marketplace.skill.featured": { kind: "write", mode: "best-effort" },

  // ── 连接器平台 OAuth App(平台自有 client 凭据 provisioning)────────
  // 这是 clientProvisioning='platform' 的**信任闸**:有没有这一行,决定用户能不能用平台
  // 身份一键授权某个连接器。等同 literature_config.secret 的分量(平台级密钥写入)→ 强制
  // tx fail-closed:审计写不下,provision/删除一律不许成功(单语句业务,包 tx 无成本)。
  "connector_platform_oauth.put": { kind: "write", mode: "tx" },
  "connector_platform_oauth.delete": { kind: "write", mode: "tx" },

  // ── 敏感读取────────────────────────────────────────────────────────
  // sessions.read 有意 fail-closed(直接 await writeAdminAudit,失败 → 500):
  // 看用户会话内容是最重的隐私读取,留痕失败就不放行。
  "sessions.read": { kind: "read", mode: "tx" },
  "ledger.export_csv": { kind: "read", mode: "tx" },
  "users.export_csv": { kind: "read", mode: "tx" },
  "orders.export_csv": { kind: "read", mode: "tx" },
} as const satisfies Record<string, AdminAuditActionSpec>;

export type AdminAuditAction = keyof typeof ADMIN_AUDIT_ACTIONS;

export function isAdminAuditAction(v: string): v is AdminAuditAction {
  return Object.prototype.hasOwnProperty.call(ADMIN_AUDIT_ACTIONS, v);
}

/** 按 kind 取 action 子集(UI 的"只看写操作/只看敏感读取"过滤用)。 */
export function auditActionsByKind(kind: AdminAuditActionSpec["kind"]): AdminAuditAction[] {
  return (Object.keys(ADMIN_AUDIT_ACTIONS) as AdminAuditAction[]).filter(
    (a) => ADMIN_AUDIT_ACTIONS[a].kind === kind,
  );
}
