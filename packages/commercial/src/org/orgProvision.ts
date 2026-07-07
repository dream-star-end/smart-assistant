/**
 * 企业版(P3.1 二期 · 批次 F)—— 自助开通(org_provision)履约逻辑。
 *
 * 承接 payment/orders.ts 的 fulfillPaidOrderTx(kind='org_provision' 分支):在 markOrderPaid
 * 的**同一事务(client)**内,把"付款成功"翻译为"建 org + owner membership + org 订阅",并回填
 * orders.org_id(与 org 订阅/加席单对称,让开通单进入该 org 的订单历史)。
 *
 * 单一权威 / 幂等边界:
 *   - 建 org+owner 复用 orgs.ts::createOrg(owner 单一权威 uq_org_owner);发订阅复用
 *     orgSubscriptions.ts::grantOrgSubscriptionTx(期内池池化)。本模块不新造第二套建 org 路径。
 *   - **payer 行锁(SELECT ... FOR UPDATE users)**串行化同一付款人的并发开通:第一单建 org 后
 *     其 membership 使该 payer 有 active org,后到单在锁释放后读到 → 走冲突分支(不建第二个 org)。
 *   - uq_user_active_org partial unique 是最后一道结构防线(即便绕过行锁,重复 membership 也 23505)。
 *
 * §13 显式接受的极小概率窗口:履约时若 payer 已属于其它 org(uq_user_active_org),**不建 org**、
 * 订单仍照常置 paid(由 markOrderPaid 续推),并发 critical 告警交人工处置(为其新组织退款或改绑)。
 * 告警走既有 alert outbox(与 payment.ts 同权威源);enqueue 只是一次同 DB 的 outbox INSERT(实际
 * 下发由独立 dispatcher 负责),故此处 await 之不引入外部依赖挂起面,且让"冲突已被 durable 记录"确定成立。
 */

import type { PoolClient } from "pg";
import { createOrg } from "./orgs.js";
import { grantOrgSubscriptionTx } from "./orgSubscriptions.js";
import { enqueueAlert } from "../admin/alertOutbox.js";
import { EVENTS } from "../admin/alertEvents.js";

/**
 * 自助开通新建 org 的默认席位上限。**与 orgs.ts::createOrg 的 maxMembers 默认(100)一致**——
 * 开通向导据此校验 seats <= 此值(orders.ts::createOrgProvisionOrder),履约时也显式传给 createOrg,
 * 使"付费席位 seats <= 组织成员上限 max_members"的不变量在开通即成立(席位闸 min(seats,max) 有意义)。
 */
export const DEFAULT_ORG_MAX_MEMBERS = 100;

export interface FulfillOrgProvisionInput {
  /** orders.id(回填 org_id 用)。 */
  orderId: string;
  /** orders.order_no(审计 / 告警 / 订阅 ref)。 */
  orderNo: string;
  /** 付款人 = 新 org 的 owner(orders.user_id)。 */
  payerUserId: string;
  /** 新建组织名(orders.org_name,已在建单时校验 1..200)。 */
  orgName: string;
  /** org 套餐 code(orders.plan_code)。 */
  planCode: string;
  /** 席位数(orders.plan_seats)。 */
  seats: number;
}

export interface FulfillOrgProvisionResult {
  /** true=已建 org+owner+订阅;false=payer 已入他 org,未建(冲突,已告警)。 */
  created: boolean;
  /** 新建 org 的 id(created=false 时为 null)。 */
  orgId: string | null;
}

/**
 * 履约自助开通单(在调用方 markOrderPaid 事务内)。返回是否新建 org。
 * 不修改订单状态/ledger 回写——那由 markOrderPaid 续推(org_provision 无个人钱包流水)。
 */
export async function fulfillOrgProvisionTx(
  client: PoolClient,
  input: FulfillOrgProvisionInput,
): Promise<FulfillOrgProvisionResult> {
  // 1) 锁 payer 行:串行化同付款人的并发开通 + 校验 payer 存在。
  const u = await client.query<{ id: string }>(
    "SELECT id::text AS id FROM users WHERE id = $1::bigint FOR UPDATE",
    [input.payerUserId],
  );
  if (u.rows.length === 0) {
    throw new TypeError(`org_provision order ${input.orderNo}: payer ${input.payerUserId} not found`);
  }

  // 2) 权威复核:payer 当前无 active org(uq_user_active_org 窗口)。
  const existing = await client.query<{ org_id: string }>(
    "SELECT org_id::text AS org_id FROM org_memberships WHERE user_id = $1::bigint AND status = 'active' LIMIT 1",
    [input.payerUserId],
  );
  if (existing.rows.length > 0) {
    await alertProvisionConflict(input, existing.rows[0].org_id);
    return { created: false, orgId: null };
  }

  // 3) 一个事务:建 org(active,created_by=payer,默认 max_members)+ owner membership + org 订阅。
  const org = await createOrg(
    {
      name: input.orgName,
      ownerUserId: input.payerUserId,
      createdBy: input.payerUserId,
      maxMembers: DEFAULT_ORG_MAX_MEMBERS,
    },
    client,
  );
  await grantOrgSubscriptionTx(client, {
    orgId: org.id,
    planCode: input.planCode,
    seats: input.seats,
    operatorUserId: input.payerUserId,
    orderRef: input.orderNo,
  });

  // 4) 回填 orders.org_id → 开通单归入新 org(与 org 订阅/加席单对称,进 org 订单历史)。
  await client.query("UPDATE orders SET org_id = $1::bigint WHERE id = $2::bigint", [org.id, input.orderId]);

  return { created: true, orgId: org.id };
}

/**
 * 冲突告警:付款人已属于其它 org,开通单已 paid 但未建 org,需人工处置。
 * 复用 PAYMENT_CALLBACK_CONFLICT(语义=已付订单落到本地状态冲突、需人工核对对账)——不新增
 * 事件类型(alertEvents.ts 非本批次所有权),dedupe_key 绑定 order_no 防风暴。enqueue 失败只 warn。
 */
async function alertProvisionConflict(
  input: FulfillOrgProvisionInput,
  existingOrgId: string,
): Promise<void> {
  try {
    await enqueueAlert({
      event_type: EVENTS.PAYMENT_CALLBACK_CONFLICT,
      severity: "critical",
      title: "自助开通订单冲突:付款人已属于其它组织",
      body:
        `自助开通单 \`${input.orderNo}\`(付款人 user_id=${input.payerUserId})履约时发现该用户` +
        `已是组织 ${existingOrgId} 的活跃成员。订单已置 paid 但**未创建新组织**,需人工核对:` +
        `为其退款或改绑到新组织。`,
      payload: {
        order_no: input.orderNo,
        payer_user_id: input.payerUserId,
        existing_org_id: existingOrgId,
        org_name: input.orgName,
        plan_code: input.planCode,
        seats: input.seats,
      },
      dedupe_key: `org.provision_conflict:${input.orderNo}`,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[org/provision] conflict alert enqueue failed order=${input.orderNo}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
