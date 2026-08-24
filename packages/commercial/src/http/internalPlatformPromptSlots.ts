/**
 * V3 commercial — internal endpoint for container → master platform prompt slot fetch.
 *
 * Why this exists:
 *   v3 容器跑的是纯个人版 gateway(packages/gateway),build-image.sh 显式 exclude
 *   packages/commercial,所以 commercial 启动时调的 setLiteratureSkillProvider /
 *   setModelHintProvider 反向钩子**对容器进程完全失效** —— 模块级 provider 在容器
 *   gateway 的进程内永远是 null,SKILLS_LITERATURE 和 MODEL_HINT 两个 slot 在 v3
 *   容器内结构性不出现。
 *
 *   本 endpoint 把"平台权威 slot 内容"从 master 推到容器:容器 gateway 在
 *   buildPromptContext 时 fetch 一次,master 用本机 DB / PricingCache 算出两个
 *   slot 的渲染结果回给容器。
 *
 *   Personal 版(45.32 单进程)不受影响,继续走 provider hook —— 容器侧 fetch
 *   函数靠两个 v3 supervisor 注入的 env 区分场景,env 缺 → null → 走旧路径。
 *
 * Trust boundary:
 *   - Auth via verifyContainerIdentity —— 同 anthropicProxy / literatureProxy /
 *     serverAuthored 完全一致(双因子:bearer + bound_ip + secret hash)
 *   - 响应内容是已渲染的 prompt 文本片段。verified container 在 spawn 时本来就要把
 *     这些片段并入 extra-prompt.md,无新增信息泄漏面
 *   - **不解密 DeepXiv token** —— 只调 getLiteratureSkillConfig() 拿 narrow view
 *     (enabled + token_set + default_size),token 明文永远不进本调用链。
 *
 * Fail-soft 语义(与原 provider hook 一致):
 *   - 任一 slot 计算抛错 → 该 slot 静默不出现在响应数组中,不整体 500
 *   - DB 抖动 / pricing cache 空 / model 不存在 → 0~2 个 slot 都合法
 *   - 空数组 `{slots: []}` 是合法 200 响应
 *
 * MODEL_HINT 安全契约:
 *   每个 MODEL_HINT slot **必须**带 canonicalModelId(来自 pricing row 的
 *   model_id)。容器侧靠这个 bounded label 防止 raw 入参 model 撑爆
 *   modelHintAppliedTotal Prom counter cardinality(详见 promptSlots.ts:418-451)。
 *   provider 路径在 buildModelHintSlot 内做 shape 校验,这里 server 端也保持
 *   同样不变量。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { rootLogger, type Logger } from "../logging/logger.js";
import {
  REQUEST_ID_HEADER,
  ensureRequestId,
  setSecurityHeaders,
} from "./util.js";
import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js";
import { getLiteratureSkillConfig } from "../admin/literatureConfig.js";
import { renderLiteratureSkillContent } from "../literatureSkill.js";
import type { PricingCache } from "../billing/pricing.js";
import type { CatalogSource } from "./internalModelCatalog.js";

/** Container → master GET 这个 path 拿平台级 slot。挂在 plain 18791 self-host
 *  和 mTLS 18443 remote-host 同一个 listener,与 anthropicProxy / serverAuthored /
 *  literatureProxy 共享 dispatchInternal 的 path-router。 */
export { PLATFORM_PROMPT_SLOTS_PATH } from "@openclaude/protocol";

/** ?model query param 最长字节(防止恶意超长 query 撑大 log/RAM)。
 *  现实 model_id 最长 50 字符 (firstParty 带日期 alias);128 留充足头空间。 */
const MAX_MODEL_QUERY_BYTES = 128;

/** Slot 名白名单 —— 任何不在表里的 name 不会被 master 返回,容器侧也会按白名单
 *  二次过滤(防止 master 加新 slot 但容器旧镜像不识别时静默接受)。 */
const ALLOWED_SLOT_NAMES = new Set(["SKILLS_LITERATURE", "MODEL_HINT"]);

/** 单个 slot 响应 shape。MODEL_HINT 必带 canonicalModelId;其它 slot 不带。 */
export interface PlatformSlotResponse {
  /** 必须是 ALLOWED_SLOT_NAMES 之一。 */
  name: string;
  /** 已渲染好的 prompt 文本。trim 后非空。 */
  content: string;
  /**
   * 仅 MODEL_HINT 出现 —— provider canonical model id(来自 model_pricing
   * row 的 model_id)。容器侧用作 metric bounded label。其它 slot 不出现这个字段。
   */
  canonicalModelId?: string;
}

export interface PlatformPromptSlotsResponseBody {
  slots: PlatformSlotResponse[];
}

export interface PlatformPromptSlotsHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  /**
   * MODEL_HINT 的**文案**权威(model_pricing.extra_system_prompt —— catalog 只管 execution,
   * 不持 prompt 文本)。**alias → canonical 不再由它负责**(见 deps.catalog)。
   */
  pricingCache: PricingCache;
  /**
   * 模型执行 catalog(方案 §6;MAJOR-5 收口 2026-07-12)。
   *
   * MODEL_HINT 的 `?model=` 入参可能是 **alias**(model_aliases)。此前这里直接 `PricingCache.get()`,
   * 而它内部走 legacy `canonicalizeModelId`(只认 anthropic 带日期后缀 + 静态 provider 的前缀规则)
   * —— **不认识 model_aliases**:用 alias 发起的 turn 会静默拿不到该模型的行为补丁(prompt 漂移,
   * 且随 alias 使用面扩大而变成一类问题)。注入后:alias→canonical **只走 catalog**,且只对
   * catalog 里可路由(active + 有价 + capability schema 可理解)的模型出 hint;canonicalModelId
   * 取 catalog 的 canonical id(仍是 bounded label,容器侧 metric cardinality 上界不变)。
   *
   * 未注入 → 退回 legacy PricingCache 路径(装配未接线 / 单测)。
   */
  catalog?: CatalogSource;
  logger?: Logger;
  /**
   * 测试 hook:literature config 读取。默认走真实
   * {@link getLiteratureSkillConfig}。单测注入 stub 控制 enabled / token_set。
   */
  readLiteratureSkillConfig?: typeof getLiteratureSkillConfig;
}

/** Listener 路由层透传的容器请求 ctx(host + bound peer ip),与
 *  anthropicProxy / serverAuthored ctx 同构。 */
export interface PlatformPromptSlotsHandlerCtx {
  hostUuid: string;
  boundIp: string;
}

export type PlatformPromptSlotsHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: PlatformPromptSlotsHandlerCtx,
) => Promise<void>;

export function makePlatformPromptSlotsHandler(
  deps: PlatformPromptSlotsHandlerDeps,
): PlatformPromptSlotsHandler {
  const log = (deps.logger ?? rootLogger).child({
    subsys: "internalPlatformPromptSlots",
  });
  const readLitCfg = deps.readLiteratureSkillConfig ?? getLiteratureSkillConfig;

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const reqLog = log.child({
      requestId,
      hostUuid: ctx.hostUuid,
      boundIp: ctx.boundIp,
      method: req.method ?? "GET",
    });

    // 0) Method 白名单。GET-only —— 本 endpoint 只读 master 状态,容器无入参
    //    (除了 query 里可选的 model)。POST/PUT/DELETE 一律拒。
    if (req.method !== "GET") {
      sendJsonError(res, 405, "METHOD_NOT_ALLOWED", "GET required", requestId);
      return;
    }

    // 1) 容器身份双因子校验(同 anthropicProxy / serverAuthored)
    try {
      await verifyContainerIdentity(
        deps.identityRepo,
        ctx,
        req.headers.authorization,
      );
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        // 不暴露 errcode 详情(同 sendJsonError pattern in serverAuthored)
        reqLog.warn("identity_failed", { errcode: err.code });
        sendJsonError(
          res,
          401,
          "UNAUTHORIZED",
          "container identity verification failed",
          requestId,
        );
        return;
      }
      throw err;
    }

    // 2) Parse ?model= query。空 / 缺省 → 不出 MODEL_HINT,合法。
    //    超长 → 静默截断;真实 model_id 远小于 cap。
    let modelId: string | undefined;
    try {
      const url = new URL(req.url ?? "/", "http://internal");
      const raw = url.searchParams.get("model");
      if (raw !== null && raw.length > 0) {
        if (Buffer.byteLength(raw, "utf-8") > MAX_MODEL_QUERY_BYTES) {
          // 不当成错误返,容器侧 fetch 失败回 [] 不影响主流程;但 master 这边
          // 把它当成"没传 model",MODEL_HINT 不出现即可。
          reqLog.warn("model_query_too_long", { len: raw.length });
        } else {
          modelId = raw;
        }
      }
    } catch (err) {
      // URL 解析失败 —— req.url 极少可能不可解析,treat 为没传 model。
      reqLog.warn("url_parse_failed", { err: errString(err) });
    }

    // 3) 并行计算两个 slot。任一抛错 → 该 slot 静默不出现。
    const slots: PlatformSlotResponse[] = [];

    // SKILLS_LITERATURE —— 只走 narrow view,不解密 token
    try {
      const cfg = await readLitCfg();
      if (cfg.enabled && cfg.token_set) {
        slots.push({
          name: "SKILLS_LITERATURE",
          content: renderLiteratureSkillContent(cfg),
        });
      }
    } catch (err) {
      // DB 抖动 / 表缺失等 —— 与原 provider hook fail-soft 语义一致。
      // 选 warn 不 error:每次容器 spawn 都打日志,error 噪声会污染监控。
      reqLog.warn("literature_skill_read_failed", { err: errString(err) });
    }

    // MODEL_HINT —— 两步:
    //   ① alias → canonical:**catalog 单一权威**(deps.catalog 注入时)。legacy
    //      canonicalizeModelId 只认 anthropic 日期后缀 / 静态 provider 前缀,不认识
    //      model_aliases;用 alias 发起的 turn 会静默丢掉行为补丁。
    //   ② canonical → 文案:model_pricing.extra_system_prompt(catalog 不持 prompt 文本)。
    //
    // 必须把 raw extra_system_prompt 包成与 personal hook 路径(promptSlots.ts
    // buildModelHintSlot)完全一致的 markdown 段:`# 模型行为补丁` 标题 + "不要复述"
    // 守则前缀 + trimmed text。容器侧把 content 当成最终 prompt 注入,不再做二次包装,
    // 与 SKILLS_LITERATURE 走 renderLiteratureSkillContent 同型(master 出全渲染文本)。
    if (modelId !== undefined) {
      try {
        const resolved = await resolveHintModel(deps, modelId, reqLog);
        if (resolved) {
          const trimmed = resolved.text.trim();
          if (trimmed) {
            slots.push({
              name: "MODEL_HINT",
              content: renderModelHintContent(trimmed),
              canonicalModelId: resolved.canonicalModelId,
            });
          }
        }
      } catch (err) {
        reqLog.warn("model_hint_compute_failed", {
          err: errString(err),
          model: modelId,
        });
      }
    }

    // 4) 响应。slot 数组顺序在 master 端固定为 [literature, model_hint],
    //    但**容器侧不能依赖该顺序** —— gateway 端按 name 白名单 + 固定落位,
    //    详见 promptSlots.ts buildPromptContext。
    //
    //    日志只打 name 列表 + 总数 + 总字节,**不打 content**(prompt 文本可能
    //    被 admin 改成含敏感细节,日志后端可能持久化或外发监控)。
    const totalBytes = slots.reduce(
      (acc, s) => acc + Buffer.byteLength(s.content, "utf-8"),
      0,
    );
    reqLog.info("served", {
      slot_names: slots.map((s) => s.name),
      slot_count: slots.length,
      total_bytes: totalBytes,
      model_query: modelId ? "present" : "absent",
    });

    const body: PlatformPromptSlotsResponseBody = { slots };
    const json = JSON.stringify(body);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // 显式禁用任何中间层缓存:slot 内容跟 DB / PricingCache 实时挂钩,admin
    // 改完下次 spawn 必须见到新内容;ALB / CF 不应介入。
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Length", String(Buffer.byteLength(json, "utf-8")));
    res.end(json);
  };
}

/**
 * 把 raw extra_system_prompt 包成最终 MODEL_HINT slot 的 markdown。
 *
 * **必须与 gateway promptSlots.ts buildModelHintSlot 的包装格式完全一致** ——
 * personal 直连(hook 路径)和 v3 远程拉取(本路径)两条管道呈现给 LLM 的
 * MODEL_HINT 段必须字节级相同,否则同一份 admin 配的 extra_system_prompt 在
 * personal vs v3 环境下行为分歧,排查极痛。
 *
 * 同步约束(改一边必改另一边):
 *   gateway:packages/gateway/src/promptSlots.ts buildModelHintSlot 第 441-451 行
 *   master: 本函数
 *
 * 入参 trimmed:caller 已 trim 过的非空文本(空白文本上层已过滤掉)。
 */
function renderModelHintContent(trimmed: string): string {
  return [
    "# 模型行为补丁",
    "",
    "以下规则用于修正当前模型的默认行为,不要在回答中复述。",
    "",
    trimmed,
  ].join("\n");
}

/**
 * `?model=`(可能是 alias)→ { canonicalModelId, extra_system_prompt }。
 *
 * catalog 注入时(生产):
 *   - alias→canonical **只走 catalog**(model_aliases 是唯一别名权威);
 *   - 只对 catalog 里**可路由**(active + 有价 + capability schema 可理解)的模型出 hint ——
 *     staged/retired/disabled 的行为补丁不该被注入(那些模型的 turn 本来就会被 gate 拒);
 *   - 文案仍取 model_pricing.extra_system_prompt,但**按 catalog 的 canonical id 取行**
 *     (PricingCache.get 内部的 legacy canonicalizeModelId 对 canonical id 幂等,它不再
 *     承担任何别名语义 —— 别名权威已单点收口到 catalog)。
 *   - fence 失败 / 快照 unknown → **不出 MODEL_HINT**(fail-soft,与本文件既有契约一致:
 *     prompt slot 是行为补丁而非安全控制,拿不到就不注入;**不**回落 legacy 归一 —— 那会在
 *     故障窗口悄悄复活第二套 alias 语义)。
 *
 * catalog 未注入 → legacy:PricingCache.get(raw)(内部 canonicalizeModelId),canonical id
 * 取 pricing row 的 model_id。
 */
async function resolveHintModel(
  deps: PlatformPromptSlotsHandlerDeps,
  rawModel: string,
  reqLog: Logger,
): Promise<{ canonicalModelId: string; text: string } | null> {
  if (deps.catalog) {
    let snapshot;
    try {
      snapshot = await deps.catalog.assertFresh();
    } catch (err) {
      reqLog.warn("model_hint_catalog_unavailable", { err: errString(err), model: rawModel });
      return null;
    }
    const canonical = snapshot.aliasToCanonical(rawModel);
    // resolve() 对 capability schema 未来版本抛 → 上层 catch 记 warn 并跳过该 slot(fail-soft)。
    if (!snapshot.resolve(canonical)) return null;
    const text = deps.pricingCache.get(canonical)?.extra_system_prompt ?? null;
    if (!text) return null;
    return { canonicalModelId: canonical, text };
  }

  const p = deps.pricingCache.get(rawModel);
  const text = p?.extra_system_prompt ?? null;
  if (!p || !text) return null;
  return { canonicalModelId: p.model_id, text };
}

/** Sentry-style error → 短字串,避免循环引用类对象塞日志。 */
function errString(err: unknown): string {
  if (err instanceof Error) return `${err.name}:${err.message}`;
  try {
    return String(err);
  } catch {
    return "<unstringifiable>";
  }
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
): void {
  if (res.headersSent) return;
  const body = JSON.stringify({
    error: { code, message },
    request_id: requestId,
  });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body, "utf-8")),
    "cache-control": "no-store",
    [REQUEST_ID_HEADER]: requestId,
  });
  res.end(body);
}
