/**
 * Selfheal user recovery notices.
 *
 * This is the only selfheal user-notification exit. It is deliberately retrospective:
 * a candidate exists only after a trusted fully-automatic repair, a fresh recovered probe,
 * exact per-request impact evidence and explicit WeCom approval. Recipients are frozen when
 * proposed and may only shrink to the still-online subset at send time.
 */
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { query as realQuery, tx as realTx } from "../db/queries.js";
import { rootLogger, type Logger } from "../logging/logger.js";
import type { AibotInboundMessage, WecomAibotConnectionManager } from "../admin/wecomAibotConnection.js";
import { captureUserImpactFence, isUserImpactFenceCurrent } from "./userImpact.js";

const APPROVAL_TTL_MS = 5 * 60_000;
const SEND_WINDOW_MS = 30_000;
const CANDIDATE_MAX_AGE_MS = 5 * 60_000;
const TICK_MS = 5_000;

export interface TrustedRepairAttestation {
  version: 1;
  repairId: string;
  incidentId: string;
  conditionKey: string;
  target: string;
  action: string;
  executionMode: "fully_automatic";
  executed: true;
  remoteResult: { ok: true; target: string; healthOk: true; checkedAt: string };
}

export function parseTrustedRepairAttestation(
  detail: unknown,
  expected: { repairId: string; incidentId: string; conditionKey: string },
): TrustedRepairAttestation | null {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const a = (detail as Record<string, unknown>).trusted_attestation;
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const x = a as Record<string, unknown>;
  const remote = x.remoteResult;
  if (!remote || typeof remote !== "object" || Array.isArray(remote)) return null;
  const r = remote as Record<string, unknown>;
  if (
    x.version !== 1 || x.repairId !== expected.repairId ||
    x.incidentId !== expected.incidentId || x.conditionKey !== expected.conditionKey ||
    (expected.conditionKey !== "ops.monitor:svc_v5" && expected.conditionKey !== "ops.monitor:http_v5") ||
    x.target !== "service:v5" || x.action !== "deploy_v5" ||
    x.executionMode !== "fully_automatic" || x.executed !== true ||
    r.ok !== true || r.healthOk !== true || r.target !== x.target ||
    typeof r.checkedAt !== "string" || !Number.isFinite(Date.parse(r.checkedAt))
  ) return null;
  return a as TrustedRepairAttestation;
}

function recipientHash(ids: string[]): string {
  return createHash("sha256").update([...ids].sort().join(",")).digest("hex");
}
function newCode(bytes: number): string { return randomBytes(bytes).toString("hex").toUpperCase(); }
function maskUid(uid: string): string {
  return uid.length <= 4 ? `${uid[0] ?? "*"}***` : `${uid.slice(0, 2)}***${uid.slice(-2)}`;
}

interface CandidateRow {
  repair_id: string; incident_id: string; incident_rev: string; policy_id: string; condition_key: string;
  user_title: string; user_message: string; done_detail: unknown; channel_id: string; approver_binding_id: string;
}
interface ProposalRow {
  id: string; incident_id: string; incident_rev: string; repair_id: string; short_code: string;
  recipients_hash: string; recipient_count: number; title: string; message: string;
  condition_key: string; target: string; channel_id: string; approver_binding_id: string;
}

export interface UserNoticeApprovalDeps {
  query: typeof realQuery;
  tx: typeof realTx;
  onlineUserSubset: (uids: string[]) => string[];
  broadcastToUsers: (uids: string[], payload: unknown) => number;
  sendWecom: (
    channelId: string,
    chatId: string,
    chatType: "single" | "group",
    markdown: string,
  ) => Promise<void>;
  logger: Logger;
}

async function ensureBindingCode(deps: UserNoticeApprovalDeps): Promise<void> {
  await deps.query(
    `INSERT INTO selfheal_notice_approver_bindings
       (channel_id, chat_id, chat_type, from_user_id, binding_code, active)
     SELECT c.id, 'pending', 'single', 'pending', $1, FALSE
       FROM admin_alert_channels c
      WHERE c.channel_type='wecom_aibot' AND c.enabled=TRUE AND c.activation_status='active'
        AND NOT EXISTS (SELECT 1 FROM selfheal_notice_approver_bindings b WHERE b.channel_id=c.id)
      ORDER BY c.id LIMIT 1`,
    [newCode(4)],
  );
}

async function createProposal(deps: UserNoticeApprovalDeps): Promise<number> {
  const candidates = await deps.query<CandidateRow>(
    `SELECT r.id::text repair_id, i.id::text incident_id, i.rev::text incident_rev, p.id::text policy_id,
            i.condition_key, i.user_title, i.user_message, e.detail done_detail,
            b.channel_id::text channel_id, b.id::text approver_binding_id
       FROM codex_repairs r
       JOIN incidents i ON i.id=r.incident_id
       JOIN incident_policies p ON p.id=i.policy_id
       JOIN admin_alert_rule_state c ON c.rule_id=i.condition_key
       JOIN LATERAL (
         SELECT detail FROM codex_repair_events
          WHERE repair_id=r.id AND kind='done' ORDER BY id DESC LIMIT 1
       ) e ON TRUE
       JOIN selfheal_notice_approver_bindings b ON b.active=TRUE
      WHERE r.status='succeeded' AND i.status='resolved'
        AND i.resolve_source IN ('codex','auto') AND p.auto_repair=TRUE
        AND p.user_notice_enabled=TRUE AND c.firing=FALSE
        AND c.mode='probe' AND c.observed_at > r.verify_after
        AND c.observed_at > COALESCE((SELECT MAX(x.observed_at) FROM selfheal_user_impact_evidence x
          WHERE x.incident_id=i.id AND x.policy_id=p.id AND x.condition_key=i.condition_key
            AND x.target='service:v5'), '-infinity'::timestamptz)
        AND r.finished_at > NOW()-($1::bigint*INTERVAL '1 millisecond')
        AND NOT EXISTS (SELECT 1 FROM selfheal_user_notice_proposals n WHERE n.repair_id=r.id)
      ORDER BY r.id LIMIT 10`,
    [CANDIDATE_MAX_AGE_MS],
  );
  let created = 0;
  for (const row of candidates.rows) {
    const att = parseTrustedRepairAttestation(row.done_detail, {
      repairId: row.repair_id, incidentId: row.incident_id, conditionKey: row.condition_key,
    });
    if (!att) continue;
    const evidence = await deps.query<{ id: string; user_id: string }>(
      `SELECT DISTINCT ON (user_id) id::text, user_id::text
         FROM selfheal_user_impact_evidence
        WHERE incident_id=$1::bigint AND policy_id=$2::bigint
          AND condition_key=$3 AND target=$4
        ORDER BY user_id, observed_at DESC`,
      [row.incident_id, row.policy_id, row.condition_key, att.target],
    );
    const byUser = new Map(evidence.rows.map((x) => [x.user_id, x.id]));
    const frozen = deps.onlineUserSubset([...byUser.keys()]).sort();
    if (frozen.length === 0) continue;
    const hash = recipientHash(frozen);
    const inserted = await deps.tx(async (client: PoolClient) => {
      const n = await client.query<{ id: string }>(
        `INSERT INTO selfheal_user_notice_proposals
           (incident_id,incident_rev,repair_id,policy_id,condition_key,target,short_code,recipients_hash,
            recipient_count,title,message,channel_id,approver_binding_id,expires_at)
         SELECT $1::bigint,$2::bigint,$3::bigint,$4::bigint,$5,$6,$7,$8,$9,$10,$11,$12::bigint,b.id,
                NOW()+($14::bigint*INTERVAL '1 millisecond')
           FROM selfheal_notice_approver_bindings b
          WHERE b.id=$13::bigint AND b.active=TRUE AND b.channel_id=$12::bigint
            AND EXISTS (
              SELECT 1 FROM codex_repairs r
              JOIN incidents i ON i.id=r.incident_id
              JOIN incident_policies p ON p.id=i.policy_id
              JOIN admin_alert_rule_state c ON c.rule_id=i.condition_key
              WHERE r.id=$3::bigint AND r.status='succeeded'
                AND i.id=$1::bigint AND i.rev=$2::bigint AND i.status='resolved'
                AND i.policy_id=$4::bigint AND i.condition_key=$5
                AND i.resolve_source IN ('codex','auto')
                AND p.auto_repair=TRUE AND p.user_notice_enabled=TRUE
                AND c.firing=FALSE AND c.mode='probe' AND c.observed_at>r.verify_after
                AND c.observed_at>COALESCE((SELECT MAX(x.observed_at) FROM selfheal_user_impact_evidence x
                  WHERE x.incident_id=i.id AND x.policy_id=p.id AND x.condition_key=i.condition_key
                    AND x.target=$6),'-infinity'::timestamptz)
                AND r.finished_at>NOW()-($15::bigint*INTERVAL '1 millisecond'))
         ON CONFLICT (repair_id) DO NOTHING RETURNING id::text`,
        [row.incident_id,row.incident_rev,row.repair_id,row.policy_id,row.condition_key,att.target,newCode(3),hash,
         frozen.length,row.user_title,`刚刚受影响，现已由系统自动恢复。${row.user_message}`,row.channel_id,
         row.approver_binding_id,APPROVAL_TTL_MS,CANDIDATE_MAX_AGE_MS],
      );
      const id = n.rows[0]?.id;
      if (!id) return false;
      for (const uid of frozen) {
        await client.query(
          `INSERT INTO selfheal_user_notice_recipients(proposal_id,user_id,evidence_id)
           VALUES($1::bigint,$2::bigint,$3::bigint)`, [id,uid,byUser.get(uid)],
        );
      }
      return true;
    });
    if (inserted) created++;
  }
  return created;
}

async function notifyPending(deps: UserNoticeApprovalDeps): Promise<void> {
  const rows = await deps.query<ProposalRow>(
    `UPDATE selfheal_user_notice_proposals SET approval_claimed_at=NOW(), updated_at=NOW()
      WHERE id IN (
        SELECT id FROM selfheal_user_notice_proposals
         WHERE status='pending' AND approval_notified_at IS NULL AND expires_at>NOW()
           AND (approval_claimed_at IS NULL OR approval_claimed_at<NOW()-INTERVAL '2 minutes')
         ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED)
      RETURNING id::text,incident_id::text,incident_rev::text,repair_id::text,short_code,recipients_hash,
                recipient_count,title,message,condition_key,target,channel_id::text,approver_binding_id::text`,
  );
  for (const row of rows.rows) {
    const binding = await deps.query<{ chat_id: string; chat_type: "single" | "group" }>(
      `SELECT chat_id,chat_type FROM selfheal_notice_approver_bindings
        WHERE id=$1::bigint AND active=TRUE`, [row.approver_binding_id],
    );
    if (!binding.rows[0]) continue;
    const users = await deps.query<{ user_id: string }>(
      `SELECT user_id::text FROM selfheal_user_notice_recipients WHERE proposal_id=$1 ORDER BY user_id`, [row.id],
    );
    const masked = users.rows.map((x) => maskUid(x.user_id)).join("、");
    const markdown = [
      `🟠 **用户恢复通知待审批 #${row.short_code}**`,
      `> 事故:${row.incident_id}  修复:${row.repair_id}`,
      `> 目标:\`${row.target}\``,
      `> 文案:${row.title} — ${row.message}`,
      `> 收件人:${row.recipient_count} 人（${masked}）`,
      `> 冻结人群哈希:\`${row.recipients_hash}\``,
      `> 5 分钟内回复 **同意 ${row.short_code}** 或 **拒绝 ${row.short_code}**`,
      `> 只会发送给上述冻结人群中发送瞬间仍在线者，不会扩群。`,
    ].join("\n");
    try {
      await deps.sendWecom(
        row.channel_id,
        binding.rows[0].chat_id,
        binding.rows[0].chat_type,
        markdown,
      );
      await deps.query(
        `UPDATE selfheal_user_notice_proposals SET approval_notified_at=NOW(),approval_claimed_at=NULL,updated_at=NOW()
          WHERE id=$1::bigint AND status='pending'`, [row.id],
      );
    } catch (err) {
      await deps.query(
        `UPDATE selfheal_user_notice_proposals SET approval_claimed_at=NULL,updated_at=NOW()
          WHERE id=$1::bigint AND status='pending'`, [row.id],
      );
      deps.logger.warn("selfheal_notice_approval_notify_failed", { proposalId: row.id, err: String(err) });
    }
  }
}

async function sendApproved(deps: UserNoticeApprovalDeps): Promise<void> {
  await deps.query(`UPDATE selfheal_user_notice_proposals SET status='expired',updated_at=NOW()
    WHERE status='pending' AND expires_at<=NOW()`);
  await deps.query(`UPDATE selfheal_user_notice_proposals SET status='skipped',
      decision_reason=CASE WHEN status='sending' THEN 'delivery outcome unknown after interrupted send'
                           ELSE 'send window expired' END,updated_at=NOW()
    WHERE status IN ('approved','sending') AND send_by<NOW()`);
  await deps.query(`UPDATE selfheal_user_notice_proposals n
       SET status='skipped',decision_reason='recovery no longer current',updated_at=NOW()
     WHERE n.status='approved' AND NOT EXISTS (
       SELECT 1 FROM incidents i
       JOIN codex_repairs r ON r.id=n.repair_id AND r.incident_id=i.id
       JOIN incident_policies p ON p.id=i.policy_id
       JOIN admin_alert_rule_state c ON c.rule_id=i.condition_key
       WHERE i.id=n.incident_id AND i.rev=n.incident_rev AND i.status='resolved'
         AND i.resolve_source IN ('codex','auto') AND r.status='succeeded'
         AND p.auto_repair=TRUE AND p.user_notice_enabled=TRUE
         AND c.firing=FALSE AND c.mode='probe' AND c.observed_at>r.verify_after
         AND c.observed_at>COALESCE((SELECT MAX(x.observed_at) FROM selfheal_user_impact_evidence x
           WHERE x.incident_id=i.id AND x.policy_id=p.id AND x.condition_key=i.condition_key
             AND x.target=n.target),'-infinity'::timestamptz)
         AND r.finished_at>NOW()-($1::bigint*INTERVAL '1 millisecond'))`, [CANDIDATE_MAX_AGE_MS]);
  const claims = await deps.query<ProposalRow>(
    `UPDATE selfheal_user_notice_proposals SET status='sending',updated_at=NOW()
      WHERE id IN (SELECT id FROM selfheal_user_notice_proposals
        WHERE status='approved' AND send_by>=NOW() ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED)
      RETURNING id::text,incident_id::text,incident_rev::text,repair_id::text,short_code,recipients_hash,
                recipient_count,title,message,condition_key,target,channel_id::text,approver_binding_id::text`,
  );
  for (const row of claims.rows) {
    const impactFence=captureUserImpactFence(row.condition_key,row.target);
    if(impactFence===null){
      await deps.query(`UPDATE selfheal_user_notice_proposals SET status='approved',updated_at=NOW()
        WHERE id=$1::bigint AND status='sending' AND send_by>=NOW()`,[row.id]);
      continue;
    }
    await deps.tx(async (client: PoolClient) => {
      const current = await client.query(
        `SELECT 1 FROM selfheal_user_notice_proposals n
          JOIN incidents i ON i.id=n.incident_id
          JOIN codex_repairs r ON r.id=n.repair_id AND r.incident_id=i.id
          JOIN incident_policies p ON p.id=i.policy_id
          JOIN admin_alert_rule_state c ON c.rule_id=i.condition_key
         WHERE n.id=$1::bigint AND n.status='sending' AND n.send_by>=NOW()
           AND i.rev=n.incident_rev AND i.status='resolved' AND i.resolve_source IN ('codex','auto')
           AND r.status='succeeded' AND p.auto_repair=TRUE AND p.user_notice_enabled=TRUE
           AND c.firing=FALSE AND c.mode='probe' AND c.observed_at>r.verify_after
           AND c.observed_at>COALESCE((SELECT MAX(x.observed_at) FROM selfheal_user_impact_evidence x
             WHERE x.incident_id=i.id AND x.policy_id=p.id AND x.condition_key=i.condition_key
               AND x.target=n.target),'-infinity'::timestamptz)
           AND r.finished_at>NOW()-($2::bigint*INTERVAL '1 millisecond')
         FOR UPDATE OF n,i,r,c`, [row.id,CANDIDATE_MAX_AGE_MS],
      );
      if (!current.rows[0]) {
        await client.query(
          `UPDATE selfheal_user_notice_proposals
              SET status='skipped',decision_reason='recovery no longer current',updated_at=NOW()
            WHERE id=$1::bigint AND status='sending'`, [row.id],
        );
        return [] as string[];
      }
      const recips = await client.query<{ user_id: string }>(
        `SELECT user_id::text FROM selfheal_user_notice_recipients
          WHERE proposal_id=$1::bigint ORDER BY user_id`, [row.id],
      );
      const online = deps.onlineUserSubset(recips.rows.map((x) => x.user_id));
      const delivered: string[] = [];
      const payload = {
        type: "sys.incident", incidentId: row.incident_id, rev: Number(row.incident_rev), status: "resolved",
        severity: "info", surface: "recovery", title: row.title, message: row.message, ts: Date.now(),
      };
      // recordUserImpact marks the fence synchronously before its async INSERT. A failure that
      // starts while the DB revalidation is in flight therefore aborts this send even before
      // its evidence row commits; the next tick waits for a newer recovery probe.
      if(!isUserImpactFenceCurrent(row.condition_key,row.target,impactFence)){
        await client.query(`UPDATE selfheal_user_notice_proposals SET status='approved',updated_at=NOW()
          WHERE id=$1::bigint AND status='sending' AND send_by>=NOW()`,[row.id]);
        return [] as string[];
      }
      for (const uid of online) if (deps.broadcastToUsers([uid], payload) > 0) delivered.push(uid);
      if (delivered.length) await client.query(
        `UPDATE selfheal_user_notice_recipients SET sent_at=NOW()
          WHERE proposal_id=$1::bigint AND user_id=ANY($2::bigint[])`, [row.id,delivered],
      );
      await client.query(
        `UPDATE selfheal_user_notice_proposals
            SET status=$2,sent_at=CASE WHEN $2='sent' THEN NOW() END,sent_recipient_count=$3,
                decision_reason=CASE WHEN $2='skipped' THEN 'no frozen recipient still online' ELSE decision_reason END,
                updated_at=NOW()
          WHERE id=$1::bigint AND status='sending'`, [row.id,delivered.length ? "sent" : "skipped",delivered.length],
      );
      return delivered;
    });
  }
}

async function notifyReceipts(deps: UserNoticeApprovalDeps): Promise<void> {
  const rows = await deps.query<ProposalRow & { status: "sent" | "skipped"; decision_reason: string | null }>(
    `UPDATE selfheal_user_notice_proposals SET receipt_claimed_at=NOW(),updated_at=NOW()
      WHERE id IN (SELECT id FROM selfheal_user_notice_proposals
        WHERE status IN ('sent','skipped') AND approval_notified_at IS NOT NULL
          AND receipt_notified_at IS NULL
          AND (receipt_claimed_at IS NULL OR receipt_claimed_at<NOW()-INTERVAL '2 minutes')
        ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED)
      RETURNING id::text,incident_id::text,incident_rev::text,repair_id::text,short_code,recipients_hash,
                recipient_count,title,message,target,channel_id::text,approver_binding_id::text,status,decision_reason`,
  );
  for (const row of rows.rows) {
    const binding = await deps.query<{ chat_id: string; chat_type: "single" | "group" }>(
      `SELECT chat_id,chat_type FROM selfheal_notice_approver_bindings WHERE id=$1::bigint`, [row.approver_binding_id],
    );
    const sent = await deps.query<{ user_id: string }>(
      `SELECT user_id::text FROM selfheal_user_notice_recipients
        WHERE proposal_id=$1::bigint AND sent_at IS NOT NULL ORDER BY user_id`, [row.id],
    );
    const ids=sent.rows.map((x)=>x.user_id);
    if (!binding.rows[0]) {
      await deps.query(`UPDATE selfheal_user_notice_proposals SET receipt_claimed_at=NULL,updated_at=NOW() WHERE id=$1`,[row.id]);
      continue;
    }
    try {
      await deps.sendWecom(row.channel_id,binding.rows[0].chat_id,binding.rows[0].chat_type,[
        `🔵 **用户恢复通知执行回执 #${row.short_code}**`,
        `> 事故:${row.incident_id}  修复:${row.repair_id}`,
        `> 结果:${row.status}${row.decision_reason ? `（${row.decision_reason}）` : ""}`,
        `> 冻结:${row.recipient_count} 人，确认在线发送:${ids.length} 人`,
        `> 确认发送人群:${ids.map(maskUid).join("、") || "无"}`,
        `> 确认发送人群哈希:\`${recipientHash(ids)}\``,
      ].join("\n"));
      await deps.query(`UPDATE selfheal_user_notice_proposals
        SET receipt_notified_at=NOW(),receipt_claimed_at=NULL,updated_at=NOW() WHERE id=$1`,[row.id]);
    } catch(err) {
      await deps.query(`UPDATE selfheal_user_notice_proposals SET receipt_claimed_at=NULL,updated_at=NOW() WHERE id=$1`,[row.id]);
      deps.logger.warn("selfheal_notice_receipt_failed",{proposalId:row.id,err:String(err)});
    }
  }
}

export async function handleNoticeApprovalCommand(
  msg: AibotInboundMessage,
  deps: Pick<UserNoticeApprovalDeps,"tx">,
): Promise<string | null> {
  const text = msg.text?.trim();
  if (!text || !msg.reqId || !msg.fromUserId) return null;
  const bind = /^绑定审批\s+([0-9A-F]{8})$/i.exec(text);
  const decision = /^(同意|拒绝)\s+([0-9A-F]{6})$/i.exec(text);
  if (!bind && !decision) return null;
  if (!msg.chatType) return "审批命令缺少企微原始 chat_type，已拒绝处理。";
  return deps.tx(async (client: PoolClient) => {
    const replay = await client.query(
      `INSERT INTO selfheal_wecom_inbound_dedupe(channel_id,req_id) VALUES($1::bigint,$2)
       ON CONFLICT DO NOTHING`, [msg.channelId,msg.reqId],
    );
    if ((replay.rowCount ?? 0) === 0) return "该企微命令已处理，已忽略重复回调。";
    if (bind) {
      const b = await client.query(
        `UPDATE selfheal_notice_approver_bindings SET chat_id=$2,chat_type=$3,from_user_id=$4,
                active=TRUE,bound_at=NOW()
          WHERE channel_id=$1::bigint AND binding_code=UPPER($5) AND active=FALSE
            AND NOT EXISTS(SELECT 1 FROM selfheal_notice_approver_bindings WHERE active=TRUE)
          RETURNING id`, [msg.channelId,msg.chatId,msg.chatType,msg.fromUserId,bind[1]],
      );
      return (b.rowCount ?? 0) ? "✅ 自愈用户通知审批身份已绑定。" : "绑定码无效、已使用或已有审批人。";
    }
    const binding = await client.query<{ id: string }>(
      `SELECT id::text FROM selfheal_notice_approver_bindings
        WHERE active=TRUE AND channel_id=$1::bigint AND chat_id=$2 AND chat_type=$3 AND from_user_id=$4`,
      [msg.channelId,msg.chatId,msg.chatType,msg.fromUserId],
    );
    if (!binding.rows[0]) return "无权审批：当前企业微信身份未绑定。";
    const code = decision![2].toUpperCase();
    const p = await client.query<{ id: string; expires_at: Date }>(
      `SELECT id::text,expires_at FROM selfheal_user_notice_proposals
        WHERE short_code=$1 AND status='pending' FOR UPDATE`, [code],
    );
    if (!p.rows[0]) return "审批单不存在或已处理。";
    const now = await client.query<{ now: Date }>(`SELECT NOW() AS now`);
    if (p.rows[0].expires_at <= now.rows[0].now) {
      await client.query(`UPDATE selfheal_user_notice_proposals SET status='expired',decision_req_id=$2,updated_at=NOW() WHERE id=$1`, [p.rows[0].id,msg.reqId]);
      return "审批已过期，已跳过用户通知并继续后续流程。";
    }
    const approve = decision![1] === "同意";
    await client.query(
      `UPDATE selfheal_user_notice_proposals SET status=$2,approver_binding_id=$3::bigint,
              decision_req_id=$4,approved_at=CASE WHEN $2='approved' THEN NOW() END,
              send_by=CASE WHEN $2='approved' THEN NOW()+($5::bigint*INTERVAL '1 millisecond') END,
              decision_reason=CASE WHEN $2='rejected' THEN 'rejected by approver' END,updated_at=NOW()
        WHERE id=$1::bigint`, [p.rows[0].id,approve?"approved":"rejected",binding.rows[0].id,msg.reqId,SEND_WINDOW_MS],
    );
    return approve ? `✅ 已同意 #${code}，只向冻结人群中仍在线用户发送。` : `⏭️ 已拒绝 #${code}，跳过用户通知并继续后续流程。`;
  });
}

export interface UserNoticeApprovalHandle { stop(): Promise<void>; runNow(): Promise<void>; }
export function startUserNoticeApproval(
  manager: WecomAibotConnectionManager,
  partial: Pick<UserNoticeApprovalDeps,"onlineUserSubset"|"broadcastToUsers"> & Partial<UserNoticeApprovalDeps>,
): UserNoticeApprovalHandle {
  const deps: UserNoticeApprovalDeps = {
    query: partial.query ?? realQuery, tx: partial.tx ?? realTx,
    onlineUserSubset: partial.onlineUserSubset, broadcastToUsers: partial.broadcastToUsers,
    sendWecom: partial.sendWecom ?? ((id,chatId,chatType,md) => manager.sendTo(id,chatId,chatType,md)),
    logger: partial.logger ?? rootLogger.child({subsys:"selfheal",module:"userNoticeApproval"}),
  };
  let stopped=false, inflight: Promise<void>|null=null;
  manager.setInboundHandler((msg) => handleNoticeApprovalCommand(msg,{tx:deps.tx}));
  const runNow = () => {
    if (inflight) return inflight;
    inflight=(async()=>{ await ensureBindingCode(deps); await createProposal(deps); await notifyPending(deps); await sendApproved(deps); await notifyReceipts(deps); })()
      .catch((err)=>deps.logger.warn("selfheal_notice_tick_failed",{err:String(err)})).finally(()=>{inflight=null;});
    return inflight;
  };
  const timer=setInterval(()=>{if(!stopped) void runNow();},TICK_MS); timer.unref?.(); void runNow();
  return { async stop(){stopped=true;clearInterval(timer);manager.setInboundHandler(null);if(inflight) await inflight;}, runNow };
}
