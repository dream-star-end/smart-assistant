import {
  MARKETPLACE_CATEGORIES,
  isMarketplaceCategoryId,
} from "@openclaude/protocol/marketplaceTaxonomy";
import { CheckCircle2, ChevronRight, Plus, Sparkles, Upload, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, apiErrorMessage } from "../../lib/api";
import {
  type HumanMetaDraft,
  OUTCOME_MAX_LEN,
  OUTCOMES_MAX,
  USE_CASE_MAX_LEN,
  USE_CASE_MIN_LEN,
  USE_CASES_MAX,
  marketplaceArtifactKind,
  suggestSlug,
  validateHumanMeta,
} from "../../lib/marketplace";
import type {
  AuthSession,
  MarketplaceCapabilityRef,
  MarketplaceMyPublish,
  MarketplaceRiskFlag,
  PublicModel,
  SkillSummary,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import {
  Alert,
  Badge,
  Button,
  Field,
  IconButton,
  Input,
  ListSkeleton,
  Panel,
  Select,
  Skeleton,
  Tabs,
  Textarea,
  TimeAgo,
  useConfirm,
  useToast,
} from "../ui";
import { friendlyRiskFlags } from "./riskFlags";

// ─────────────────────────────────────────────────────────────────────────────
// 本面板的三条铁律(2026-07-26 面板层改造):
//  1. **校验错误必须落在出错的那个字段上**,并把用户带过去(scrollIntoView + focus)。
//     旧实现只在表单最顶部塞一条 Alert,而「发布」按钮在 5–6 屏之外的底部 ——
//     用户点了按钮什么也看不到,主观等于"点了没反应"。
//  2. **草稿状态一律提到 PublishPanel 层**。旧实现三张表单靠条件渲染切换,点一下
//     「发布智能体」pill 就把写好的 SKILL.md 随组件卸载静默清空。
//  3. **提交按钮常驻**(sticky 操作条)并实时播报"还差哪几项必填",不必滚到底才知道。
// ─────────────────────────────────────────────────────────────────────────────

type PublishKind = "skill" | "agent" | "connector";

/** 校验失败的定位信息:field = 要聚焦的控件 id;scope = 归属的人向元数据分组。 */
type MetaScope = "category" | "useCases" | "outcomes" | "humanMd";
type FormError = { field: string | null; scope?: MetaScope; message: string };
type MetaErrors = Partial<Record<MetaScope, string>>;

/** 滚动到目标节点。jsdom 没有 scrollIntoView,故必须探测后再调。 */
function scrollIntoViewSafe(el: Element | null | undefined, block: ScrollLogicalPosition = "center") {
  if (!el || typeof el.scrollIntoView !== "function") return;
  el.scrollIntoView({ block, behavior: "smooth" });
}

/** 把用户带到首个出错的控件:先滚进视口中央,再聚焦(聚焦不再二次滚动)。 */
function focusField(id: string) {
  if (typeof document === "undefined") return;
  const el = document.getElementById(id);
  if (!el) return;
  scrollIntoViewSafe(el);
  if (typeof el.focus === "function") el.focus({ preventScroll: true });
}

/** 版本号 patch 位 +1(被拒后重新提交时自动递增,避免撞版本号)。 */
function bumpPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return version;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** 「我的发布」记录属于哪条发布路径(决定回填到哪张表单)。 */
function publishKindOf(r: MarketplaceMyPublish): PublishKind {
  if (r.kind === "agent") return "agent";
  if (r.kind === "connector" || marketplaceArtifactKind(r) === "plugin") return "connector";
  return "skill";
}

/**
 * 人向元数据的**归属字段**判定。校验规则与文案的唯一权威仍是 `validateHumanMeta`
 * (仓内契约,与后端 parseHumanMeta 对齐);这里只按它的检查顺序判断这条文案属于
 * 哪个分组,好把用户带到对应控件 —— 不复制文案,文案改了也不会错位。
 */
function metaFieldError(meta: HumanMetaDraft, idPrefix: string): FormError | null {
  const message = validateHumanMeta(meta);
  if (!message) return null;
  if (!isMarketplaceCategoryId(meta.category))
    return { field: `${idPrefix}-category`, scope: "category", message };
  const useCases = meta.useCases.map((s) => s.trim()).filter(Boolean);
  const useCasesBad =
    useCases.length < 1 ||
    useCases.length > USE_CASES_MAX ||
    useCases.some((s) => s.length < USE_CASE_MIN_LEN || s.length > USE_CASE_MAX_LEN);
  if (useCasesBad) return { field: `${idPrefix}-usecase-0`, scope: "useCases", message };
  const outcomes = meta.outcomeExamples.map((s) => s.trim()).filter(Boolean);
  const outcomesBad =
    outcomes.length > OUTCOMES_MAX || outcomes.some((s) => s.length > OUTCOME_MAX_LEN);
  if (outcomesBad) return { field: `${idPrefix}-outcome-0`, scope: "outcomes", message };
  return { field: `${idPrefix}-humanmd`, scope: "humanMd", message };
}

/** 人向元数据草稿的初始值(useCases 至少 1 行输入框;其余空)。 */
function emptyHumanMeta(): HumanMetaDraft {
  return { category: "", useCases: [""], outcomeExamples: [], humanMd: "" };
}

/**
 * 人向商品元数据字段(分类 / 适用场景 / 效果示例 / 详细介绍)——三条发布路径
 * **对称复用**同一套控件,保证语义与校验一致。受控组件,状态由 PublishPanel 持有。
 */
function HumanMetaFields({
  idPrefix,
  meta,
  onChange,
  errors,
}: {
  idPrefix: string;
  meta: HumanMetaDraft;
  onChange: (next: HumanMetaDraft) => void;
  errors?: MetaErrors;
}) {
  const selected = MARKETPLACE_CATEGORIES.find((c) => c.id === meta.category);
  const setUseCase = (i: number, v: string) =>
    onChange({ ...meta, useCases: meta.useCases.map((x, j) => (j === i ? v : x)) });
  const setOutcome = (i: number, v: string) =>
    onChange({ ...meta, outcomeExamples: meta.outcomeExamples.map((x, j) => (j === i ? v : x)) });

  return (
    <Panel title="商品信息" hint="帮用户判断「适不适合我、能达成什么」。">
      <div className="flex flex-col gap-4">
        <Field
          label="分类"
          required
          htmlFor={`${idPrefix}-category`}
          hint={selected?.blurb}
          error={errors?.category}
        >
          <Select
            id={`${idPrefix}-category`}
            value={meta.category}
            onValueChange={(v) => onChange({ ...meta, category: v })}
            placeholder="请选择分类…"
            options={MARKETPLACE_CATEGORIES.map((c) => ({ value: c.id, label: c.label }))}
          />
        </Field>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-meta font-medium text-muted">
              适用场景
              <span aria-hidden="true" className="ml-0.5 text-danger">
                *
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={meta.useCases.length >= USE_CASES_MAX}
              onClick={() => onChange({ ...meta, useCases: [...meta.useCases, ""] })}
            >
              <Plus size={13} /> 添加场景
            </Button>
          </div>
          <ul className="flex flex-col gap-2">
            {meta.useCases.map((u, i) => (
              <li key={i} className="flex items-center gap-2">
                <Input
                  id={`${idPrefix}-usecase-${i}`}
                  aria-label={`适用场景 ${i + 1}`}
                  value={u}
                  onChange={(e) => setUseCase(i, e.target.value)}
                  placeholder="例：把中文论文摘要翻译成地道英文并保留术语"
                />
                {meta.useCases.length > 1 && (
                  <IconButton
                    variant="muted"
                    shape="square"
                    aria-label={`删除适用场景 ${i + 1}`}
                    onClick={() =>
                      onChange({ ...meta, useCases: meta.useCases.filter((_, j) => j !== i) })
                    }
                  >
                    <X size={15} />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
          <p className="text-caption text-faint">
            必填 1–{USE_CASES_MAX} 条，每条 {USE_CASE_MIN_LEN}–{USE_CASE_MAX_LEN} 字。
          </p>
          {errors?.useCases && <p className="text-caption text-danger">{errors.useCases}</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-meta font-medium text-muted">能达成什么效果</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={meta.outcomeExamples.length >= OUTCOMES_MAX}
              onClick={() => onChange({ ...meta, outcomeExamples: [...meta.outcomeExamples, ""] })}
            >
              <Plus size={13} /> 添加效果示例
            </Button>
          </div>
          {meta.outcomeExamples.length > 0 && (
            <ul className="flex flex-col gap-2">
              {meta.outcomeExamples.map((o, i) => (
                <li key={i} className="flex items-center gap-2">
                  <Input
                    id={`${idPrefix}-outcome-${i}`}
                    aria-label={`效果示例 ${i + 1}`}
                    value={o}
                    onChange={(e) => setOutcome(i, e.target.value)}
                    placeholder="给它 X → 得到 Y，例：给一段乱码日志 → 得到定位到根因的排查结论"
                  />
                  <IconButton
                    variant="muted"
                    shape="square"
                    aria-label={`删除效果示例 ${i + 1}`}
                    onClick={() =>
                      onChange({
                        ...meta,
                        outcomeExamples: meta.outcomeExamples.filter((_, j) => j !== i),
                      })
                    }
                  >
                    <X size={15} />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          <p className="text-caption text-faint">
            选填 0–{OUTCOMES_MAX} 条，每条不超过 {OUTCOME_MAX_LEN} 字。
          </p>
          {errors?.outcomes && <p className="text-caption text-danger">{errors.outcomes}</p>}
        </div>

        <Field
          label="详细介绍"
          hint="选填，支持 Markdown。"
          htmlFor={`${idPrefix}-humanmd`}
          error={errors?.humanMd}
        >
          <Textarea
            id={`${idPrefix}-humanmd`}
            value={meta.humanMd}
            onChange={(e) => onChange({ ...meta, humanMd: e.target.value })}
            rows={6}
            className="resize-y"
            placeholder="向用户介绍它的亮点、适合的人群、使用建议、注意事项……"
          />
        </Field>
      </div>
    </Panel>
  );
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SLUG_HINT = "小写字母 / 数字 / 连字符，2–64 位。";
const VERSION_HINT = "N.N.N，例如 1.0.0。";
const SUBMIT_HINT = "提交后进入平台审核，通过后才会上架。";

/** 能力工具集(与后端 VETTED_AGENT_TOOLSETS/详情页 TOOLSET_LABEL 对齐)。core 恒选。 */
const TOOLSET_OPTIONS: { value: string; label: string; hint: string; locked?: boolean }[] = [
  { value: "core", label: "核心", hint: "文件 / 终端 / 基础工具", locked: true },
  { value: "browser", label: "浏览器", hint: "操作真实浏览器" },
  { value: "research", label: "研究检索", hint: "文献检索与引用" },
  { value: "web_context", label: "网页提取", hint: "抓取网页 / 文档" },
];

/**
 * 常驻底部操作条:左侧实时播报"还差哪几项必填"+ 本次提交的失败原因,右侧主按钮。
 * 提交按钮**不禁用** —— 点击即定位到首个缺项,比一个灰按钮更能推进用户;
 * 未填齐时降为 secondary 做视觉弱化。
 */
function SubmitBar({
  missing,
  error,
  submitting,
  onSubmit,
}: {
  missing: string[];
  error: string | null;
  submitting: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur">
      <div className="min-w-0 flex-1 basis-40">
        {missing.length > 0 ? (
          <p className="text-caption text-warning">
            还差 {missing.length} 项必填：{missing.join("、")}
          </p>
        ) : (
          <p className="text-caption text-faint">{SUBMIT_HINT}</p>
        )}
        {error && (
          <p role="alert" className="mt-0.5 text-caption text-danger">
            {error}
          </p>
        )}
      </div>
      <Button
        variant={missing.length > 0 ? "secondary" : "primary"}
        loading={submitting}
        onClick={onSubmit}
      >
        {submitting ? null : <Upload size={15} />}
        发布到市场
      </Button>
    </div>
  );
}

/** 发布成功后的通用完成态。 */
function DoneScreen({
  onAgain,
  onViewProgress,
  plugin = false,
}: {
  onAgain: () => void;
  onViewProgress: () => void;
  plugin?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <CheckCircle2 size={32} className="text-success" />
      <p className="text-title font-medium text-fg">已提交，等待平台审核</p>
      <p className="max-w-sm text-body text-muted">
        {plugin
          ? "API 连接插件会先由 AI 核对完整技术声明与安全决策；真实凭据在用户绑定时由身份探针验证，不确定、内容过大或高风险项会转人工复核。审核进度会在市场内实时更新。"
          : "AI 审核通常几分钟内完成；通过后将上架并对其他用户可见，需要人工复核的会稍慢。"}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" size="sm" onClick={onViewProgress}>
          查看审核进度
        </Button>
        <Button variant="ghost" size="sm" onClick={onAgain}>
          继续发布
        </Button>
      </div>
    </div>
  );
}

// ── 草稿(状态提到面板层,切换发布类型不再卸载) ──────────────────────────────

type SkillDraft = {
  slug: string;
  /** 用户手动改过 slug 后停止跟随名称联动。 */
  slugTouched: boolean;
  version: string;
  name: string;
  description: string;
  tags: string;
  body: string;
  meta: HumanMetaDraft;
  files: Array<{ path: string; content: string }>;
  benchmark: { withPassRate: number; withoutPassRate: number; cases: number } | null;
};

type AgentDraft = {
  name: string;
  slug: string;
  slugTouched: boolean;
  version: string;
  tags: string;
  description: string;
  avatarEmoji: string;
  model: string;
  toolsets: string[];
  capabilityDeps: MarketplaceCapabilityRef[];
  persona: string;
  meta: HumanMetaDraft;
};

type ConnectorDraft = {
  version: string;
  tags: string;
  specJson: string;
  decisionJson: string;
  meta: HumanMetaDraft;
};

function emptySkillDraft(): SkillDraft {
  return {
    slug: "",
    slugTouched: false,
    version: "1.0.0",
    name: "",
    description: "",
    tags: "",
    body: "",
    meta: emptyHumanMeta(),
    files: [],
    benchmark: null,
  };
}

function emptyAgentDraft(): AgentDraft {
  return {
    name: "",
    slug: "",
    slugTouched: false,
    version: "1.0.0",
    tags: "",
    description: "",
    avatarEmoji: "🤖",
    model: "",
    toolsets: ["core"],
    capabilityDeps: [],
    persona: "",
    meta: emptyHumanMeta(),
  };
}

function emptyConnectorDraft(): ConnectorDraft {
  return {
    version: "1.0.0",
    tags: "API 插件",
    specJson: "",
    decisionJson: "",
    meta: emptyHumanMeta(),
  };
}

// ── 覆盖写前的"草稿是否已被写过" ─────────────────────────────────────────────
//
// 旧实现是**每种草稿各写一份手写字段白名单**(`d.name.trim() || d.description.trim() || …`)。
// 白名单天生漏字段:skill 漏 slug/version/tags/benchmark、agent 漏 slug/version/tags/
// avatarEmoji/model/toolsets、connector 漏 version/tags —— 用户只改过这些字段时,
// 「载入这次提交继续修改」/「从我的技能导入」直接覆盖写,**连确认都不弹**,内容静默消失。
// 更糟的是白名单的缺项没有任何机制能发现:类型系统看不见它,新增字段时也没人被提醒回来补。
//
// 现在把脏判定收进草稿句柄本身:句柄持有**基线**(初始值 + 系统写入的默认值),脏 = 当前值
// 与基线的规范化结构比较。新增字段自动纳入,不再有清单要维护。

/**
 * 内容比较用的规范化:抹掉"用户看不见的差异"——首尾空白、空串、空数组、null。
 * 这样「点了『添加场景』但一个字没打」「把名称打了又删干净」都不算已填写,
 * 而任何**真的留下了内容**的字段一定会被算进来。
 */
function normalizeContent(v: unknown): unknown {
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? undefined : t;
  }
  if (Array.isArray(v)) {
    const items = v.map(normalizeContent).filter((x) => x !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => [k, normalizeContent(val)] as const)
      .filter(([, val]) => val !== undefined)
      // 键序归一:草稿到处 spread,键的插入顺序不该影响"有没有改过"的判定。
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return v === null ? undefined : v;
}

function sameContent(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeContent(a) ?? null) === JSON.stringify(normalizeContent(b) ?? null);
}

/**
 * 不算"用户填写的内容"的内部标记字段:只记录交互状态(如 slug 是否被手动改过)。
 * 用 `as const` + `keyof T` 约束 —— 字段改名时调用处会直接编译不过,不会静默失效。
 */
const INTERACTION_FLAGS = ["slugTouched"] as const;
const NO_INTERACTION_FLAGS = [] as const;

/** 草稿句柄:值 + 局部更新 + 整体重置 + 相对基线的脏判定。表单组件只拿句柄。 */
type DraftApi<T extends object> = {
  value: T;
  /** 用户写入:只动值,基线不动 —— 于是它会被算作"已填写"。 */
  set: (patch: Partial<T> | ((cur: T) => Partial<T>)) => void;
  /**
   * 系统写入的默认值(如模型下拉自动选中首项):同时推进基线。
   * 用 `set` 会让一张**空白表单**也被判成脏,于是每次回填都要用户白点一次确认。
   */
  seed: (patch: Partial<T> | ((cur: T) => Partial<T>)) => void;
  reset: () => void;
  /**
   * 相对基线是否已被写入内容。传 keys 则只看这几个字段 —— 给"只覆盖部分字段"的
   * 写入方(技能导入)用:它不碰商品信息,就不该因为用户填了分类而问一句废话。
   */
  isDirty: (keys?: readonly (keyof T & string)[]) => boolean;
};

function useDraft<T extends object>(
  create: () => T,
  interactionFlags: readonly (keyof T & string)[] = NO_INTERACTION_FLAGS,
): DraftApi<T> {
  const [state, setState] = useState<{ value: T; baseline: T }>(() => {
    const v = create();
    return { value: v, baseline: v };
  });
  const createRef = useRef(create);
  createRef.current = create;

  const set = useCallback((patch: Partial<T> | ((cur: T) => Partial<T>)) => {
    setState((s) => ({
      ...s,
      value: { ...s.value, ...(typeof patch === "function" ? patch(s.value) : patch) },
    }));
  }, []);
  const seed = useCallback((patch: Partial<T> | ((cur: T) => Partial<T>)) => {
    setState((s) => {
      const p = typeof patch === "function" ? patch(s.value) : patch;
      return { value: { ...s.value, ...p }, baseline: { ...s.baseline, ...p } };
    });
  }, []);
  const reset = useCallback(() => {
    setState(() => {
      const v = createRef.current();
      return { value: v, baseline: v };
    });
  }, []);

  const changed = useMemo(() => {
    const skip = new Set<string>(interactionFlags);
    const value = state.value as Record<string, unknown>;
    const baseline = state.baseline as Record<string, unknown>;
    const out = new Set<string>();
    for (const k of new Set([...Object.keys(value), ...Object.keys(baseline)])) {
      if (skip.has(k)) continue;
      if (!sameContent(value[k], baseline[k])) out.add(k);
    }
    return out;
  }, [state, interactionFlags]);

  const isDirty = useCallback(
    (keys?: readonly (keyof T & string)[]) =>
      keys ? keys.some((k) => changed.has(k)) : changed.size > 0,
    [changed],
  );

  return useMemo(
    () => ({ value: state.value, set, seed, reset, isDirty }),
    [state.value, set, seed, reset, isDirty],
  );
}

/** 上一次成功提交的内容快照(每 kind 一条),供「被拒后载入这次提交继续修改」复用。 */
type SubmittedSnapshot =
  | { kind: "skill"; slug: string; draft: SkillDraft }
  | { kind: "agent"; slug: string; draft: AgentDraft }
  | { kind: "connector"; slug: string; draft: ConnectorDraft };

/** 被拒记录回填后的待办提示(钉在表单顶部)。 */
type RefillNotice = {
  kind: PublishKind;
  name: string;
  note: string | null;
  /** true = 完整内容已载回;false = 只回填了名称/标识,正文需重写。 */
  restored: boolean;
};

const KIND_TABS = [
  { value: "skill", label: "发布技能" },
  { value: "agent", label: "发布智能体" },
  { value: "connector", label: "发布插件" },
];

/**
 * 发布：技能 / 智能体 / API 连接插件三条路径,提交进入平台审核队列(pending)。
 * 顶部「我的发布」闭合反馈环:审核状态、拒绝理由、以及被拒后**回到表单继续修改**的入口。
 * 被静态扫描 / manifest 校验拦截时把命中翻译成可操作的中文修正提示。
 */
export function PublishPanel({
  auth,
  onCreateInChat,
  publishes = null,
  publishesLoading = false,
  publishesError = null,
  onRefreshPublishes = () => {},
  onMutePublishTransition = () => {},
}: {
  auth: AuthSession;
  /** 「在对话中创建」:AI 引导式创建(小白路径),表单是手动模式。 */
  onCreateInChat?: (kind: "skill" | "agent" | "connector") => void;
  /** 市场顶层持有，确保切到发现/已安装时仍可继续追踪审核状态。 */
  publishes?: MarketplaceMyPublish[] | null;
  publishesLoading?: boolean;
  publishesError?: string | null;
  onRefreshPublishes?: () => void;
  onMutePublishTransition?: (versionId: string, muted: boolean) => void;
}) {
  const [kind, setKind] = useState<PublishKind>("skill");
  const skill = useDraft(emptySkillDraft, INTERACTION_FLAGS);
  const agent = useDraft(emptyAgentDraft, INTERACTION_FLAGS);
  const connector = useDraft(emptyConnectorDraft);
  // null = 跟随"有待办自动展开";true/false = 用户或完成态显式指定过。
  const [publishesOpen, setPublishesOpen] = useState<boolean | null>(null);
  const [refill, setRefill] = useState<RefillNotice | null>(null);
  const submittedRef = useRef<SubmittedSnapshot[]>([]);
  const publishesRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const [confirmDialog, confirmEl] = useConfirm();

  const rememberSubmitted = useCallback((snap: SubmittedSnapshot) => {
    submittedRef.current = [...submittedRef.current.filter((s) => s.kind !== snap.kind), snap];
  }, []);

  const viewProgress = useCallback(() => {
    setPublishesOpen(true);
    scrollIntoViewSafe(publishesRef.current, "start");
  }, []);

  /**
   * 被拒 / 已撤销记录 →「载入这次提交继续修改」。本会话内提交过的同 slug 记录可整份
   * 载回;否则至少回填名称与标识(版本号 +1),并把拒绝理由钉成待办。
   * 目标表单已有内容时先二次确认 —— 回填是覆盖写,不能静默吃掉正在写的草稿。
   * ⚠️ 已知技术债:草稿只活在本面板生命周期内(关闭市场弹窗即丢),尚未落 localStorage。
   */
  const refillFromPublish = useCallback(
    async (r: MarketplaceMyPublish) => {
      const target = publishKindOf(r);
      // 回填是**整份**覆盖(有快照就整份换,没快照就重置成空表单 + 名称/标识),
      // 所以问的是"这张草稿有没有被写过任何内容",不限定字段。
      const dirty =
        target === "skill"
          ? skill.isDirty()
          : target === "agent"
            ? agent.isDirty()
            : connector.isDirty();
      if (dirty) {
        const go = await confirmDialog({
          title: "用这次提交的内容覆盖当前表单？",
          body: "当前表单里已填写的内容会被替换，不可撤销。",
          confirmText: "覆盖并继续修改",
          danger: true,
        });
        if (!go) return;
      }
      const snap = submittedRef.current.find((s) => s.kind === target && s.slug === r.slug);
      const version = bumpPatch(r.version);
      if (snap && snap.kind === "skill") skill.set({ ...snap.draft, version });
      else if (snap && snap.kind === "agent") agent.set({ ...snap.draft, version });
      else if (snap && snap.kind === "connector") connector.set({ ...snap.draft, version });
      else if (target === "skill")
        skill.set({ ...emptySkillDraft(), name: r.name, slug: r.slug, slugTouched: true, version });
      else if (target === "agent")
        agent.set({ ...emptyAgentDraft(), name: r.name, slug: r.slug, slugTouched: true, version });
      else connector.set({ ...emptyConnectorDraft(), version });
      setKind(target);
      setRefill({
        kind: target,
        name: r.name,
        note: r.reviewNote ?? null,
        restored: Boolean(snap),
      });
    },
    [agent, confirmDialog, connector, skill],
  );

  // 回填后把用户带到表单(否则他还站在「我的发布」那一段,不知道下面已经填好了)。
  useEffect(() => {
    if (refill) scrollIntoViewSafe(formRef.current, "start");
  }, [refill]);

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      {confirmEl}
      <div ref={publishesRef}>
        <MyPublishes
          auth={auth}
          rows={publishes}
          loading={publishesLoading}
          error={publishesError}
          onRefresh={onRefreshPublishes}
          onMuteTransition={onMutePublishTransition}
          open={publishesOpen}
          onOpenChange={setPublishesOpen}
          onRefill={refillFromPublish}
        />
      </div>

      <Tabs
        aria-label="发布类型"
        idBase="publish-kind"
        value={kind}
        onValueChange={(v) => setKind(v as PublishKind)}
        items={KIND_TABS}
      />

      {onCreateInChat && (
        <button
          type="button"
          onClick={() => onCreateInChat(kind)}
          className="group flex w-full items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft/40 px-4 py-3 text-left outline-none transition-colors hover:border-accent/60 hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <Sparkles size={17} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-section font-semibold text-fg">
              在对话中创建
              {kind === "skill" ? "技能" : kind === "agent" ? "智能体" : " API 连接插件"}（推荐）
            </span>
            <span className="mt-0.5 block text-meta leading-snug text-muted">
              回答几个选择题，AI 帮你完成起草、创建
              {kind === "skill" ? "、评测用例" : kind === "agent" ? "和发布" : "技术声明、安全决策和发布"}
              —— 无需了解格式规范。
            </span>
          </span>
          <ChevronRight
            size={16}
            className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5"
          />
        </button>
      )}

      <div
        ref={formRef}
        id={`publish-kind-panel-${kind}`}
        role="tabpanel"
        aria-labelledby={`publish-kind-tab-${kind}`}
        className="flex flex-col gap-4"
      >
        {refill && refill.kind === kind && (
          <Alert
            tone="warning"
            density="compact"
            title={`修正后重新提交「${refill.name}」`}
            onDismiss={() => setRefill(null)}
          >
            {refill.note ? `上次未通过的理由：${refill.note}` : "上次提交未通过。"}
            <span className="mt-1 block text-caption text-muted">
              {refill.restored
                ? "已载入你上次提交的内容，版本号已自动 +1。"
                : "已回填名称与标识、版本号 +1；正文内容需要重新填写（本次会话没有留存上次的正文）。"}
            </span>
          </Alert>
        )}

        {kind === "skill" ? (
          <SkillPublishForm
            auth={auth}
            draft={skill}
            onPublished={onRefreshPublishes}
            onSubmitted={rememberSubmitted}
            onViewProgress={viewProgress}
          />
        ) : kind === "agent" ? (
          <AgentPublishForm
            auth={auth}
            draft={agent}
            onPublished={onRefreshPublishes}
            onSubmitted={rememberSubmitted}
            onViewProgress={viewProgress}
          />
        ) : (
          <ConnectorPublishForm
            auth={auth}
            draft={connector}
            onPublished={onRefreshPublishes}
            onSubmitted={rememberSubmitted}
            onViewProgress={viewProgress}
          />
        )}
      </div>
    </div>
  );
}

// ── 技能发布 ────────────────────────────────────────────────────────────────

const SKILL_ID = {
  name: "publish-skill-name",
  slug: "publish-skill-slug",
  version: "publish-skill-version",
  tags: "publish-skill-tags",
  description: "publish-skill-description",
  body: "publish-skill-body",
  content: "publish-skill-content-section",
  files: "publish-skill-files-section",
  meta: "publish-skill-meta",
} as const;

/**
 * 「从我的技能导入」会写入的全部字段 —— 与下方 importSkill 里的 draft.set 一一对应。
 * 商品信息(meta)与版本号导入**不碰**,故不在此列:只填过分类的用户不该被问一句废话。
 */
const IMPORT_OVERWRITES = [
  "name",
  "slug",
  "description",
  "tags",
  "body",
  "files",
  "benchmark",
] as const satisfies readonly (keyof SkillDraft)[];

function SkillPublishForm({
  auth,
  draft,
  onPublished,
  onSubmitted,
  onViewProgress,
}: {
  auth: AuthSession;
  draft: DraftApi<SkillDraft>;
  onPublished: () => void;
  onSubmitted: (snap: SubmittedSnapshot) => void;
  onViewProgress: () => void;
}) {
  const d = draft.value;
  const [mySkills, setMySkills] = useState<SkillSummary[]>([]);
  const [skillsFailed, setSkillsFailed] = useState(false);
  const [skillsReload, setSkillsReload] = useState(0);
  const [importing, setImporting] = useState<string | null>(null);
  const [importNote, setImportNote] = useState<{ tone: "info" | "warning"; text: string } | null>(
    null,
  );
  const [bundleErrors, setBundleErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<FormError | null>(null);
  const [flags, setFlags] = useState<MarketplaceRiskFlag[]>([]);
  const [ok, setOk] = useState(false);
  const [confirmDialog, confirmEl] = useConfirm();

  // biome-ignore lint/correctness/useExhaustiveDependencies: skillsReload 是「重试」的触发器,不是被读取的值
  useEffect(() => {
    let alive = true;
    setSkillsFailed(false);
    api
      .listSkills(auth)
      .then((s) => alive && setMySkills(s.filter((x) => x.writable !== false)))
      .catch(() => alive && setSkillsFailed(true));
    return () => {
      alive = false;
    };
  }, [auth, skillsReload]);

  const importSkill = async (sk: SkillSummary) => {
    // 导入会覆盖 IMPORT_OVERWRITES 里的每一个字段(不含商品信息)—— 其中任何一个已被
    // 用户写过就必须先确认,一次误点不能吃掉草稿。字段清单直接来自下面的 draft.set,
    // 两处改一处必改:漏一个就是"用户写的内容被静默替换"。
    if (draft.isDirty(IMPORT_OVERWRITES)) {
      const go = await confirmDialog({
        title: `用「${sk.name}」覆盖当前内容？`,
        body: "已填写的名称、标识、描述、标签、正文与附属文件会被这次导入替换，不可撤销。",
        confirmText: "覆盖导入",
        danger: true,
      });
      if (!go) return;
    }
    setImporting(sk.name);
    setImportNote(null);
    setErr(null);
    draft.set({
      name: sk.name,
      slug: suggestSlug(sk.name),
      slugTouched: false,
      description: sk.description ?? "",
      tags: (sk.tags ?? []).join(", "),
      files: [],
      benchmark: null,
    });
    let loadedCount = 0;
    let failedCount = 0;
    try {
      const detail = await api.getSkill(auth, sk.name);
      // 整目录导入:技能是目录,不只是 SKILL.md —— 把 references/assets/evals/scripts
      // 下的全部文件拉进附属文件区(≤20 个;可手动删减)。发布的就是完整技能。
      const auxPaths = (detail.files ?? [])
        .filter(
          (f) =>
            f !== "SKILL.md" &&
            !f.startsWith("history/") &&
            ["references/", "assets/", "evals/", "scripts/"].some((p) => f.startsWith(p)),
        )
        .slice(0, 20);
      const loaded: Array<{ path: string; content: string }> = [];
      for (const path of auxPaths) {
        try {
          const r = await api.getSkillFile(auth, sk.name, path);
          // evals.json 里的 autoRegression 是本地开关,不随发布走。
          if (path === "evals/evals.json") {
            try {
              const parsed = JSON.parse(r.content) as { autoRegression?: boolean };
              delete parsed.autoRegression;
              loaded.push({ path, content: `${JSON.stringify(parsed, null, 2)}\n` });
              continue;
            } catch {
              /* 原样携带 */
            }
          }
          loaded.push({ path, content: r.content });
        } catch {
          failedCount += 1;
        }
      }
      loadedCount = loaded.length;
      draft.set({ body: detail.body ?? "", files: loaded });
    } catch {
      setImportNote({ tone: "warning", text: `「${sk.name}」的正文没能读到，请手动填写技能正文。` });
      setImporting(null);
      return;
    }
    // 自动附带上次 baseline 实测(发布者自报,详情页会标注来源;可手动删)。
    try {
      const ev = await api.getSkillEvals(auth, sk.name);
      const b = ev.lastRun?.benchmark;
      if (b && b.passRate?.with !== undefined && b.passRate?.without !== undefined) {
        draft.set({
          benchmark: {
            withPassRate: b.passRate.with,
            withoutPassRate: b.passRate.without,
            cases: Math.max(1, Math.min(5, ev.evals?.cases?.length ?? 1)),
          },
        });
      }
    } catch {
      /* 无评测数据就不带 */
    }
    setImportNote(
      failedCount > 0
        ? {
            tone: "warning",
            text: `已导入 SKILL.md 与 ${loadedCount} 个附属文件；有 ${failedCount} 个文件读取失败，请确认是否需要手动补上。`,
          }
        : { tone: "info", text: `已导入 SKILL.md 与 ${loadedCount} 个附属文件。` },
    );
    setImporting(null);
  };

  const missing = [
    !d.name.trim() && "显示名称",
    !SLUG_RE.test(d.slug) && "标识 slug",
    !VERSION_RE.test(d.version) && "版本号",
    !d.description.trim() && "一句话描述",
    !d.body.trim() && "技能正文",
    !isMarketplaceCategoryId(d.meta.category) && "分类",
    d.meta.useCases.every((s) => !s.trim()) && "适用场景",
  ].filter((x): x is string => typeof x === "string");

  const validate = (): FormError | null => {
    if (!d.name.trim()) return { field: SKILL_ID.name, message: "请填写显示名称" };
    if (!SLUG_RE.test(d.slug)) return { field: SKILL_ID.slug, message: `标识须为${SLUG_HINT}` };
    if (!VERSION_RE.test(d.version))
      return { field: SKILL_ID.version, message: `版本号须为${VERSION_HINT}` };
    if (!d.description.trim())
      return { field: SKILL_ID.description, message: "请填写一句话描述" };
    if (!d.body.trim()) return { field: SKILL_ID.body, message: "请填写技能正文" };
    return metaFieldError(d.meta, SKILL_ID.meta);
  };

  const resetAll = () => {
    draft.reset();
    setBundleErrors([]);
    setFlags([]);
    setErr(null);
    setImportNote(null);
  };

  const submit = async () => {
    const v = validate();
    if (v) {
      setErr(v);
      setBundleErrors([]);
      setFlags([]);
      if (v.field) focusField(v.field);
      return;
    }
    setSubmitting(true);
    setErr(null);
    setBundleErrors([]);
    setFlags([]);
    const useCases = d.meta.useCases.map((s) => s.trim()).filter(Boolean);
    const outcomeExamples = d.meta.outcomeExamples.map((s) => s.trim()).filter(Boolean);
    const humanMd = d.meta.humanMd.trim();
    try {
      await api.publishMarketplace(auth, {
        slug: d.slug,
        version: d.version,
        name: d.name.trim(),
        description: d.description.trim(),
        body: d.body,
        tags: d.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        category: d.meta.category,
        useCases,
        ...(outcomeExamples.length > 0 ? { outcomeExamples } : {}),
        ...(humanMd ? { humanMd } : {}),
        ...(d.files.length > 0 ? { files: d.files } : {}),
        ...(d.benchmark ? { benchmark: d.benchmark } : {}),
      });
      onSubmitted({ kind: "skill", slug: d.slug, draft: d });
      resetAll();
      setOk(true);
      onPublished();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        const eb = e.body as { riskFlags?: MarketplaceRiskFlag[]; errors?: string[] };
        if (eb?.errors?.length) {
          setBundleErrors(eb.errors);
          setErr({ field: null, message: "附属文件不合法，请按下面的提示修正。" });
          scrollIntoViewSafe(document.getElementById(SKILL_ID.files), "start");
        } else {
          setFlags(eb?.riskFlags ?? []);
          setErr({ field: null, message: "发布被安全扫描拦截，请按提示修正后重试。" });
          scrollIntoViewSafe(document.getElementById(SKILL_ID.content), "start");
        }
      } else {
        setErr({ field: null, message: apiErrorMessage(e, "发布失败") });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const friendly = friendlyRiskFlags(flags);
  const fieldErr = (id: string) => (err?.field === id ? err.message : undefined);
  const metaErrors: MetaErrors = err?.scope ? { [err.scope]: err.message } : {};

  if (ok)
    return (
      <DoneScreen
        onViewProgress={onViewProgress}
        onAgain={() => {
          setOk(false);
          resetAll();
        }}
      />
    );

  return (
    <div className="flex flex-col gap-4">
      {confirmEl}

      <Panel title="基本信息" hint="市场里用来识别与检索它的信息。">
        <div className="flex flex-col gap-4">
          {(mySkills.length > 0 || skillsFailed) && (
            <div className="flex flex-col gap-1.5">
              <span className="text-meta font-medium text-muted">从我的技能导入</span>
              {skillsFailed ? (
                <p className="text-caption text-faint">
                  没能读到你的技能列表。
                  <Button variant="link" size="sm" onClick={() => setSkillsReload((n) => n + 1)}>
                    重试
                  </Button>
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {mySkills.map((sk) => (
                    <Button
                      key={sk.name}
                      variant="secondary"
                      size="sm"
                      shape="pill"
                      loading={importing === sk.name}
                      disabled={importing !== null}
                      onClick={() => void importSkill(sk)}
                    >
                      {sk.name}
                    </Button>
                  ))}
                </div>
              )}
              {importNote && (
                <p
                  className={cn(
                    "text-caption",
                    importNote.tone === "warning" ? "text-warning" : "text-faint",
                  )}
                >
                  {importNote.text}
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="显示名称" required error={fieldErr(SKILL_ID.name)}>
              <Input
                id={SKILL_ID.name}
                value={d.name}
                onChange={(e) =>
                  draft.set((cur) => ({
                    name: e.target.value,
                    ...(cur.slugTouched ? {} : { slug: suggestSlug(e.target.value) }),
                  }))
                }
                placeholder="例：学术翻译"
              />
            </Field>
            <Field label="标识 slug" required hint={SLUG_HINT} error={fieldErr(SKILL_ID.slug)}>
              <Input
                id={SKILL_ID.slug}
                value={d.slug}
                onChange={(e) => draft.set({ slug: e.target.value, slugTouched: true })}
                placeholder="academic-translate"
              />
            </Field>
            <Field label="版本号" required hint={VERSION_HINT} error={fieldErr(SKILL_ID.version)}>
              <Input
                id={SKILL_ID.version}
                value={d.version}
                onChange={(e) => draft.set({ version: e.target.value })}
                placeholder="1.0.0"
              />
            </Field>
            <Field label="标签" hint="选填，逗号分隔。">
              <Input
                id={SKILL_ID.tags}
                value={d.tags}
                onChange={(e) => draft.set({ tags: e.target.value })}
                placeholder="翻译, 学术"
              />
            </Field>
          </div>

          <Field label="一句话描述" required error={fieldErr(SKILL_ID.description)}>
            <Input
              id={SKILL_ID.description}
              value={d.description}
              onChange={(e) => draft.set({ description: e.target.value })}
              placeholder="把中文学术论文翻译成地道英文，保留术语。"
            />
          </Field>
        </div>
      </Panel>

      <HumanMetaFields
        idPrefix={SKILL_ID.meta}
        meta={d.meta}
        onChange={(meta) => draft.set({ meta })}
        errors={metaErrors}
      />

      <div id={SKILL_ID.content}>
        <Panel title="技能内容" hint="SKILL.md 正文：描述它何时触发、如何执行。">
          <div className="flex flex-col gap-3">
            {friendly.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {friendly.map((f) => (
                  <Alert key={f.label} tone={f.tone} density="compact">
                    <span className="font-medium">{f.label}：</span>
                    {f.message}
                    {f.hint && <span className="mt-0.5 block text-muted">{f.hint}</span>}
                    {f.sample && (
                      <code className="mt-1 block break-all rounded bg-code px-1.5 py-0.5 font-mono text-caption">
                        {f.sample}
                      </code>
                    )}
                  </Alert>
                ))}
              </div>
            )}
            <Field label="技能正文（SKILL.md）" required error={fieldErr(SKILL_ID.body)}>
              <Textarea
                id={SKILL_ID.body}
                value={d.body}
                onChange={(e) => draft.set({ body: e.target.value })}
                rows={12}
                placeholder="描述这个技能何时触发、如何执行……"
                className="min-h-52 resize-y font-mono"
              />
            </Field>
          </div>
        </Panel>
      </div>

      <div id={SKILL_ID.files}>
        <Panel
          title="附属文件"
          hint="选填，支持 references/ assets/ evals/ scripts/。脚本会先做危险模式扫描，有风险信号时转人工复核。"
          action={
            <Button
              variant="secondary"
              size="sm"
              disabled={d.files.length >= 20}
              onClick={() =>
                draft.set((cur) => ({ files: [...cur.files, { path: "references/", content: "" }] }))
              }
            >
              <Plus size={13} /> 添加文件
            </Button>
          }
        >
          <div className="flex flex-col gap-3">
            {bundleErrors.length > 0 && (
              <Alert tone="danger" density="compact" title="附属文件校验未通过">
                <ul className="list-disc pl-4">
                  {bundleErrors.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {d.files.length === 0 ? (
              <p className="text-caption text-faint">
                还没有附属文件。参考资料、评测用例、脚本都可以随技能一起发布。
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {d.files.map((f, i) => (
                  <li key={i} className="flex flex-col gap-1.5 rounded-lg border border-border p-2">
                    <div className="flex items-center gap-2">
                      <Input
                        inputSize="sm"
                        aria-label={`附属文件 ${i + 1} 路径`}
                        value={f.path}
                        onChange={(e) => {
                          const v = e.target.value;
                          draft.set((cur) => ({
                            files: cur.files.map((x, j) => (j === i ? { ...x, path: v } : x)),
                            // 用户开始修正文件后,上一次的红色校验提示就不该再挂着。
                          }));
                          setBundleErrors([]);
                        }}
                        placeholder="references/guide.md"
                        className="font-mono"
                      />
                      <IconButton
                        variant="danger"
                        shape="square"
                        aria-label={`删除 ${f.path || `附属文件 ${i + 1}`}`}
                        onClick={() =>
                          draft.set((cur) => ({ files: cur.files.filter((_, j) => j !== i) }))
                        }
                      >
                        <X size={15} />
                      </IconButton>
                    </div>
                    <Textarea
                      aria-label={`附属文件 ${i + 1} 内容`}
                      value={f.content}
                      onChange={(e) => {
                        const v = e.target.value;
                        draft.set((cur) => ({
                          files: cur.files.map((x, j) => (j === i ? { ...x, content: v } : x)),
                        }));
                        setBundleErrors([]);
                      }}
                      rows={4}
                      placeholder="文件内容…"
                      className="resize-y font-mono"
                    />
                  </li>
                ))}
              </ul>
            )}
            {d.benchmark && (
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="info">
                  实测：通过率 {Math.round(d.benchmark.withoutPassRate * 100)}% →{" "}
                  {Math.round(d.benchmark.withPassRate * 100)}%（{d.benchmark.cases}{" "}
                  用例，发布者自报）
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="移除实测数据"
                  onClick={() => draft.set({ benchmark: null })}
                >
                  移除
                </Button>
              </div>
            )}
          </div>
        </Panel>
      </div>

      <SubmitBar
        missing={missing}
        error={err ? (err.field ? "请修正上方标记的字段后重新提交。" : err.message) : null}
        submitting={submitting}
        onSubmit={() => void submit()}
      />
    </div>
  );
}

// ── 智能体发布 ──────────────────────────────────────────────────────────────

const AGENT_ID = {
  name: "publish-agent-name",
  slug: "publish-agent-slug",
  version: "publish-agent-version",
  avatar: "publish-agent-avatar",
  model: "publish-agent-model",
  tags: "publish-agent-tags",
  description: "publish-agent-description",
  toolsets: "publish-agent-toolsets",
  persona: "publish-agent-persona",
  capabilities: "publish-agent-capabilities",
  meta: "publish-agent-meta",
} as const;

type LoadState = "loading" | "ready" | "error";

function AgentPublishForm({
  auth,
  draft,
  onPublished,
  onSubmitted,
  onViewProgress,
}: {
  auth: AuthSession;
  draft: DraftApi<AgentDraft>;
  onPublished: () => void;
  onSubmitted: (snap: SubmittedSnapshot) => void;
  onViewProgress: () => void;
}) {
  const d = draft.value;
  const [models, setModels] = useState<PublicModel[]>([]);
  const [modelsState, setModelsState] = useState<LoadState>("loading");
  const [installedCapabilities, setInstalledCapabilities] = useState<
    Array<{ kind: "skill" | "plugin"; slug: string; name: string }>
  >([]);
  const [capState, setCapState] = useState<LoadState>("loading");
  const [dataReload, setDataReload] = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<FormError | null>(null);
  const [manifestErrors, setManifestErrors] = useState<string[]>([]);
  const [flags, setFlags] = useState<MarketplaceRiskFlag[]>([]);
  const [ok, setOk] = useState(false);

  const seedDraft = draft.seed;
  // biome-ignore lint/correctness/useExhaustiveDependencies: dataReload 是「重试」的触发器,不是被读取的值
  useEffect(() => {
    let alive = true;
    setModelsState("loading");
    setCapState("loading");
    api
      .getPublicModels(auth)
      .then((ms) => {
        if (!alive) return;
        setModels(ms);
        setModelsState("ready");
        // seed 而非 set:这是系统替用户选的默认项,不能让一张空白表单变成"已填写"。
        seedDraft((cur) => (cur.model ? {} : { model: ms[0]?.id ?? "" }));
      })
      .catch(() => alive && setModelsState("error"));
    Promise.all([
      api.listMarketplaceInstalled(auth),
      api.getDeclarativeManagement(auth).catch(() => ({ connectors: [], connections: [] })),
    ])
      .then(([rows, management]) => {
        if (!alive) return;
        const capabilities = new Map<
          string,
          { kind: "skill" | "plugin"; slug: string; name: string }
        >();
        for (const row of rows) {
          if ((row.kind !== "skill" && row.kind !== "connector") || row.listingState !== "active")
            continue;
          const item = {
            kind: row.kind === "connector" ? ("plugin" as const) : ("skill" as const),
            slug: row.slug,
            name: row.name,
          };
          capabilities.set(`${item.kind}:${item.slug}`, item);
        }
        // 官方 Plugin 是平台预装能力，没有 marketplace_install 行；也必须能被 Agent
        // 发布器直接选择，否则用户只能手写 slug，且审核能过、安装却曾失败。
        for (const row of management.connectors) {
          if (row.installation !== "default" || !row.official || !row.available) continue;
          capabilities.set(`plugin:${row.slug}`, {
            kind: "plugin",
            slug: row.slug,
            name: row.label,
          });
        }
        setInstalledCapabilities([...capabilities.values()]);
        setCapState("ready");
      })
      .catch(() => alive && setCapState("error"));
    return () => {
      alive = false;
    };
  }, [auth, dataReload, seedDraft]);

  const toggleToolset = (v: string) =>
    draft.set((cur) => ({
      toolsets: cur.toolsets.includes(v)
        ? cur.toolsets.filter((x) => x !== v)
        : [...cur.toolsets, v],
    }));

  const cycleCapability = (capability: { kind: "skill" | "plugin"; slug: string }) => {
    draft.set((cur) => {
      const found = cur.capabilityDeps.find(
        (item) => item.kind === capability.kind && item.slug === capability.slug,
      );
      if (!found)
        return { capabilityDeps: [...cur.capabilityDeps, { ...capability, optional: false }] };
      if (!found.optional)
        return {
          capabilityDeps: cur.capabilityDeps.map((item) =>
            item.kind === capability.kind && item.slug === capability.slug
              ? { ...item, optional: true }
              : item,
          ),
        };
      return {
        capabilityDeps: cur.capabilityDeps.filter(
          (item) => !(item.kind === capability.kind && item.slug === capability.slug),
        ),
      };
    });
  };

  const missing = [
    !d.name.trim() && "名称",
    !SLUG_RE.test(d.slug) && "标识 slug",
    !VERSION_RE.test(d.version) && "版本号",
    !d.description.trim() && "一句话描述",
    !d.model && "模型",
    d.toolsets.length === 0 && "能力工具集",
    !d.persona.trim() && "人设",
    !isMarketplaceCategoryId(d.meta.category) && "分类",
    d.meta.useCases.every((s) => !s.trim()) && "适用场景",
  ].filter((x): x is string => typeof x === "string");

  const validate = (): FormError | null => {
    if (!d.name.trim()) return { field: AGENT_ID.name, message: "请填写智能体名称" };
    if (!SLUG_RE.test(d.slug)) return { field: AGENT_ID.slug, message: `标识须为${SLUG_HINT}` };
    if (!VERSION_RE.test(d.version))
      return { field: AGENT_ID.version, message: `版本号须为${VERSION_HINT}` };
    if (!d.description.trim())
      return { field: AGENT_ID.description, message: "请填写一句话描述" };
    if (!d.model) return { field: AGENT_ID.model, message: "请选择模型" };
    if (d.toolsets.length === 0)
      return { field: AGENT_ID.toolsets, message: "请至少选择一个能力工具集" };
    if (!d.persona.trim())
      return { field: AGENT_ID.persona, message: "请填写人设（它决定智能体的行为方式）" };
    return metaFieldError(d.meta, AGENT_ID.meta);
  };

  const resetAll = () => {
    draft.reset();
    setManifestErrors([]);
    setFlags([]);
    setErr(null);
  };

  const submit = async () => {
    const v = validate();
    if (v) {
      setErr(v);
      setManifestErrors([]);
      setFlags([]);
      if (v.field) focusField(v.field);
      return;
    }
    setSubmitting(true);
    setErr(null);
    setManifestErrors([]);
    setFlags([]);
    const useCases = d.meta.useCases.map((s) => s.trim()).filter(Boolean);
    const outcomeExamples = d.meta.outcomeExamples.map((s) => s.trim()).filter(Boolean);
    const humanMd = d.meta.humanMd.trim();
    try {
      await api.publishMarketplaceAgent(auth, {
        slug: d.slug,
        version: d.version,
        name: d.name.trim(),
        description: d.description.trim(),
        tags: d.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        model: d.model,
        toolsets: d.toolsets,
        capabilities: d.capabilityDeps,
        skillDeps: d.capabilityDeps
          .filter((item) => item.kind === "skill")
          .map((item) => item.slug),
        persona: d.persona,
        category: d.meta.category,
        useCases,
        ...(outcomeExamples.length > 0 ? { outcomeExamples } : {}),
        ...(humanMd ? { humanMd } : {}),
        ...(d.avatarEmoji.trim() ? { avatarEmoji: d.avatarEmoji.trim() } : {}),
      });
      onSubmitted({ kind: "agent", slug: d.slug, draft: d });
      resetAll();
      setOk(true);
      onPublished();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        const b = e.body as { errors?: string[]; riskFlags?: MarketplaceRiskFlag[] };
        if (b?.errors?.length) {
          setManifestErrors(b.errors);
          setErr({ field: null, message: "智能体配置不合法，请按下面的提示修正。" });
        } else if (b?.riskFlags?.length) {
          setFlags(b.riskFlags);
          setErr({ field: null, message: "人设被安全扫描拦截，请按提示修正后重试。" });
          scrollIntoViewSafe(document.getElementById(AGENT_ID.persona), "center");
        } else {
          setErr({ field: null, message: apiErrorMessage(e, "发布失败") });
        }
      } else {
        setErr({ field: null, message: apiErrorMessage(e, "发布失败") });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const friendly = friendlyRiskFlags(flags);
  const fieldErr = (id: string) => (err?.field === id ? err.message : undefined);
  const metaErrors: MetaErrors = err?.scope ? { [err.scope]: err.message } : {};

  if (ok)
    return (
      <DoneScreen
        onViewProgress={onViewProgress}
        onAgain={() => {
          setOk(false);
          resetAll();
        }}
      />
    );

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info" density="compact">
        智能体 = 模型 + 工具集 + 人设 + 可组合的 Skill / Plugin。安装时必需能力与智能体
        原子落地；插件账号仍由每位用户在管理中心授权。
      </Alert>

      <Panel title="基本信息" hint="市场里用来识别与检索它的信息。">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="名称" required error={fieldErr(AGENT_ID.name)}>
              <Input
                id={AGENT_ID.name}
                value={d.name}
                onChange={(e) =>
                  draft.set((cur) => ({
                    name: e.target.value,
                    ...(cur.slugTouched ? {} : { slug: suggestSlug(e.target.value) }),
                  }))
                }
                placeholder="例：法律顾问"
              />
            </Field>
            <Field label="标识 slug" required hint={SLUG_HINT} error={fieldErr(AGENT_ID.slug)}>
              <Input
                id={AGENT_ID.slug}
                value={d.slug}
                onChange={(e) => draft.set({ slug: e.target.value, slugTouched: true })}
                placeholder="legal-advisor"
              />
            </Field>
            <Field label="版本号" required hint={VERSION_HINT} error={fieldErr(AGENT_ID.version)}>
              <Input
                id={AGENT_ID.version}
                value={d.version}
                onChange={(e) => draft.set({ version: e.target.value })}
                placeholder="1.0.0"
              />
            </Field>
            <Field label="头像 Emoji" hint="选填。">
              <Input
                id={AGENT_ID.avatar}
                value={d.avatarEmoji}
                onChange={(e) => draft.set({ avatarEmoji: e.target.value })}
                placeholder="🤖"
              />
            </Field>
            <Field
              label="模型"
              required
              htmlFor={AGENT_ID.model}
              error={
                modelsState === "error" ? (
                  <>
                    无法加载可用模型。
                    <Button variant="link" size="sm" onClick={() => setDataReload((n) => n + 1)}>
                      重试
                    </Button>
                  </>
                ) : (
                  fieldErr(AGENT_ID.model)
                )
              }
            >
              <Select
                id={AGENT_ID.model}
                value={d.model}
                onValueChange={(v) => draft.set({ model: v })}
                disabled={modelsState !== "ready"}
                placeholder={
                  modelsState === "loading"
                    ? "加载模型中…"
                    : modelsState === "error"
                      ? "加载失败"
                      : undefined
                }
                options={models.map((m) => ({
                  value: m.id,
                  label:
                    typeof m.displayName === "string" && m.displayName ? m.displayName : m.id,
                }))}
              />
            </Field>
            <Field label="标签" hint="选填，逗号分隔。">
              <Input
                id={AGENT_ID.tags}
                value={d.tags}
                onChange={(e) => draft.set({ tags: e.target.value })}
                placeholder="法律, 咨询"
              />
            </Field>
          </div>

          <Field label="一句话描述" required error={fieldErr(AGENT_ID.description)}>
            <Input
              id={AGENT_ID.description}
              value={d.description}
              onChange={(e) => draft.set({ description: e.target.value })}
              placeholder="面向合同审阅与合规问答的法律顾问。"
            />
          </Field>
        </div>
      </Panel>

      <HumanMetaFields
        idPrefix={AGENT_ID.meta}
        meta={d.meta}
        onChange={(meta) => draft.set({ meta })}
        errors={metaErrors}
      />

      <Panel title="能力" hint="工具集决定它能动用哪些系统能力；组合能力决定它自带哪些市场技能与插件。">
        <div className="flex flex-col gap-4">
          <div id={AGENT_ID.toolsets} className="flex flex-col gap-1.5">
            <span className="text-meta font-medium text-muted">
              工具集
              <span aria-hidden="true" className="ml-0.5 text-danger">
                *
              </span>
            </span>
            <div className="flex flex-col gap-1.5 md:flex-row md:flex-wrap">
              {TOOLSET_OPTIONS.map((t) => {
                const checked = d.toolsets.includes(t.value);
                return (
                  <label
                    key={t.value}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border px-3 py-2 text-body transition-colors [@media(hover:none)]:min-h-11",
                      checked ? "border-accent/50 bg-accent-soft text-fg" : "border-border text-muted",
                      t.locked ? "cursor-not-allowed" : "cursor-pointer",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={t.locked}
                      onChange={() => toggleToolset(t.value)}
                      className="accent-accent"
                    />
                    <span className="font-medium">{t.label}</span>
                    <span className="text-caption text-faint">{t.hint}</span>
                    {t.locked && <Badge size="sm">必选</Badge>}
                  </label>
                );
              })}
            </div>
            {fieldErr(AGENT_ID.toolsets) && (
              <p className="text-caption text-danger">{fieldErr(AGENT_ID.toolsets)}</p>
            )}
          </div>

          <div id={AGENT_ID.capabilities} className="flex flex-col gap-1.5">
            <span className="text-meta font-medium text-muted">组合能力</span>
            <p className="text-caption leading-snug text-faint">
              选填。从你已安装的市场 Skill / Plugin 中选择：点击一次设为「必需」，再点设为「可选」，
              第三次移除。必需能力不可用时整包回滚；可选能力不可用时会明确跳过。
            </p>
            {capState === "loading" ? (
              <div className="flex flex-wrap gap-1.5">
                <Skeleton className="h-6 w-24 rounded-full" />
                <Skeleton className="h-6 w-28 rounded-full" />
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
            ) : capState === "error" ? (
              <Alert
                tone="danger"
                density="compact"
                action={
                  <Button size="sm" variant="secondary" onClick={() => setDataReload((n) => n + 1)}>
                    重试
                  </Button>
                }
              >
                没能读到你已安装的能力，暂时无法选择组合能力。
              </Alert>
            ) : installedCapabilities.length === 0 ? (
              <p className="text-caption text-faint">
                你还没有可组合的市场能力 —— 先在「发现」安装 Skill 或
                Plugin；也可以发布不带依赖的智能体。
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {installedCapabilities.map((capability) => {
                  const selected = d.capabilityDeps.find(
                    (item) => item.kind === capability.kind && item.slug === capability.slug,
                  );
                  return (
                    <button
                      type="button"
                      key={`${capability.kind}:${capability.slug}`}
                      onClick={() => cycleCapability(capability)}
                      aria-pressed={Boolean(selected)}
                      title={
                        selected
                          ? selected.optional
                            ? "当前：可选依赖。再点一次移除"
                            : "当前：必需依赖。再点一次改为可选"
                          : "点击设为必需依赖"
                      }
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-meta outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3",
                        selected
                          ? "border-accent/50 bg-accent-soft text-accent"
                          : "border-border text-muted hover:border-accent/40 hover:text-fg",
                      )}
                    >
                      {selected ? (selected.optional ? "可选 · " : "必需 · ") : ""}
                      {capability.kind === "plugin" ? "Plugin" : "Skill"} · {capability.name}
                      <span className="ml-1 font-mono text-micro text-faint">{capability.slug}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </Panel>

      <Panel title="人设" hint="persona 决定智能体的行为方式与工作流。">
        <div className="flex flex-col gap-3">
          {manifestErrors.length > 0 && (
            <Alert tone="danger" density="compact" title="配置校验未通过">
              <ul className="list-disc pl-4">
                {manifestErrors.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </Alert>
          )}
          {friendly.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {friendly.map((f) => (
                <Alert key={f.label} tone={f.tone} density="compact">
                  <span className="font-medium">{f.label}：</span>
                  {f.message}
                  {f.hint && <span className="mt-0.5 block text-muted">{f.hint}</span>}
                </Alert>
              ))}
            </div>
          )}
          <Field label="人设（persona）" required error={fieldErr(AGENT_ID.persona)}>
            <Textarea
              id={AGENT_ID.persona}
              value={d.persona}
              onChange={(e) => draft.set({ persona: e.target.value })}
              rows={12}
              placeholder={"你是……\n\n工作方式：\n1. ……\n2. ……\n\n纪律：\n- ……"}
              className="min-h-52 resize-y font-mono"
            />
          </Field>
        </div>
      </Panel>

      <SubmitBar
        missing={missing}
        error={err ? (err.field ? "请修正上方标记的字段后重新提交。" : err.message) : null}
        submitting={submitting}
        onSubmit={() => void submit()}
      />
    </div>
  );
}

// ── API 连接插件发布 ────────────────────────────────────────────────────────

const CONNECTOR_ID = {
  version: "publish-connector-version",
  tags: "publish-connector-tags",
  spec: "publish-connector-spec",
  decision: "publish-connector-decision",
  meta: "publish-connector-meta",
} as const;

type JsonParse =
  | { state: "empty" }
  | { state: "ok"; value: Record<string, unknown>; actions: number }
  | { state: "error"; message: string };

/** 把 JSON.parse 的 position 换算成行号 —— 15 行 spec 里逐字符肉眼找是最劝退的一段。 */
function jsonErrorHint(message: string, text: string): string {
  const m = /position (\d+)/.exec(message);
  if (!m) return `格式有误：${message}`;
  const line = text.slice(0, Number(m[1])).split("\n").length;
  return `第 ${line} 行附近格式有误：${message}`;
}

function parseJsonObject(raw: string): JsonParse {
  const text = raw.trim();
  if (!text) return { state: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      state: "error",
      message: jsonErrorHint(e instanceof Error ? e.message : String(e), text),
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { state: "error", message: "必须是 JSON 对象（以 { 开头）。" };
  const value = parsed as Record<string, unknown>;
  const actions = value.actions && typeof value.actions === "object" ? Object.keys(value.actions).length : 0;
  return { state: "ok", value, actions };
}

function ConnectorPublishForm({
  auth,
  draft,
  onPublished,
  onSubmitted,
  onViewProgress,
}: {
  auth: AuthSession;
  draft: DraftApi<ConnectorDraft>;
  onPublished: () => void;
  onSubmitted: (snap: SubmittedSnapshot) => void;
  onViewProgress: () => void;
}) {
  const d = draft.value;
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<FormError | null>(null);
  const [ok, setOk] = useState(false);
  // 失焦即校验:JSON 合法与否在提交前就说清楚,不必等点了发布才知道。
  const [touched, setTouched] = useState<{ spec: boolean; decision: boolean }>({
    spec: false,
    decision: false,
  });

  const spec = useMemo(() => parseJsonObject(d.specJson), [d.specJson]);
  const decision = useMemo(() => parseJsonObject(d.decisionJson), [d.decisionJson]);

  const missing = [
    !VERSION_RE.test(d.version) && "版本号",
    spec.state !== "ok" && "ConnectorSpec",
    decision.state !== "ok" && "安全决策",
    !isMarketplaceCategoryId(d.meta.category) && "分类",
    d.meta.useCases.every((s) => !s.trim()) && "适用场景",
  ].filter((x): x is string => typeof x === "string");

  const validate = (): FormError | null => {
    if (!VERSION_RE.test(d.version))
      return { field: CONNECTOR_ID.version, message: `版本号须为${VERSION_HINT}` };
    if (spec.state !== "ok")
      return {
        field: CONNECTOR_ID.spec,
        message: spec.state === "empty" ? "请填写 ConnectorSpec JSON" : spec.message,
      };
    if (decision.state !== "ok")
      return {
        field: CONNECTOR_ID.decision,
        message: decision.state === "empty" ? "请填写安全决策 JSON" : decision.message,
      };
    return metaFieldError(d.meta, CONNECTOR_ID.meta);
  };

  const submit = async () => {
    setTouched({ spec: true, decision: true });
    const v = validate();
    if (v) {
      setErr(v);
      if (v.field) focusField(v.field);
      return;
    }
    if (spec.state !== "ok" || decision.state !== "ok") return;
    setErr(null);
    setSubmitting(true);
    try {
      await api.publishMarketplaceConnector(auth, {
        version: d.version,
        spec: spec.value,
        securityDecision: decision.value,
        tags: d.tags
          .split(/[,，]/)
          .map((x) => x.trim())
          .filter(Boolean),
        category: d.meta.category,
        useCases: d.meta.useCases.map((x) => x.trim()).filter(Boolean),
        outcomeExamples: d.meta.outcomeExamples.map((x) => x.trim()).filter(Boolean),
        humanMd: d.meta.humanMd.trim() || undefined,
      });
      onSubmitted({
        kind: "connector",
        slug: typeof spec.value.id === "string" ? spec.value.id : "",
        draft: d,
      });
      draft.reset();
      setTouched({ spec: false, decision: false });
      setOk(true);
      onPublished();
    } catch (e) {
      setErr({
        field: null,
        message: apiErrorMessage(e, "发布 API 连接插件失败，请检查技术声明与安全决策。"),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const fieldErr = (id: string) => (err?.field === id ? err.message : undefined);
  const metaErrors: MetaErrors = err?.scope ? { [err.scope]: err.message } : {};
  const jsonFieldError = (which: "spec" | "decision"): string | undefined => {
    const parse = which === "spec" ? spec : decision;
    const id = which === "spec" ? CONNECTOR_ID.spec : CONNECTOR_ID.decision;
    if (touched[which] && parse.state === "error") return parse.message;
    return fieldErr(id);
  };

  if (ok)
    return (
      <DoneScreen
        plugin
        onViewProgress={onViewProgress}
        onAgain={() => {
          setOk(false);
          draft.reset();
          setErr(null);
        }}
      />
    );

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info" density="compact" title="API 连接插件 · AI 自动审核">
        当前支持无需运行自定义代码的声明式 API 连接插件。发布者填写的安全决策只是审核建议；AI 会核对完整 ConnectorSpec、固定网络来源、凭据位置与每个动作的读写效果，
        通过后编译并签名上架，用户绑定时再由身份探针验证真实凭据；不确定或高风险项转人工复核。OAuth2 社区插件必须自带 OAuth 应用（BYOA）。
      </Alert>

      <Panel title="基本信息" hint="插件的名称与标识来自下方 ConnectorSpec 的声明。">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="版本号" required hint={VERSION_HINT} error={fieldErr(CONNECTOR_ID.version)}>
            <Input
              id={CONNECTOR_ID.version}
              value={d.version}
              onChange={(e) => draft.set({ version: e.target.value })}
              placeholder="1.0.0"
            />
          </Field>
          <Field label="标签" hint="选填，逗号分隔。">
            <Input
              id={CONNECTOR_ID.tags}
              value={d.tags}
              onChange={(e) => draft.set({ tags: e.target.value })}
              placeholder="API 插件, 文档"
            />
          </Field>
        </div>
      </Panel>

      <Panel
        title="技术声明"
        hint="不确定格式？用上方「在对话中创建 API 连接插件」让 AI 起草，比手写更快也更不容易被拒。"
      >
        <div className="flex flex-col gap-4">
          <Field
            label="插件 ConnectorSpec JSON"
            required
            hint="必须含 id、identity 与 actions。"
            error={jsonFieldError("spec")}
          >
            <Textarea
              id={CONNECTOR_ID.spec}
              value={d.specJson}
              onChange={(e) => draft.set({ specJson: e.target.value })}
              onBlur={() => setTouched((t) => ({ ...t, spec: true }))}
              rows={15}
              className="min-h-52 resize-y font-mono"
              placeholder={'{"id":"my-plugin","label":"我的 API 插件",…}'}
            />
          </Field>
          <div className="-mt-2 flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={spec.state !== "ok"}
              onClick={() => draft.set({ specJson: JSON.stringify(spec.state === "ok" ? spec.value : {}, null, 2) })}
            >
              格式化
            </Button>
            {spec.state === "ok" && (
              <span className="text-caption text-success">
                JSON 格式正确{spec.actions > 0 ? `，含 ${spec.actions} 个 action` : ""}。
              </span>
            )}
          </div>

          <Field
            label="发布者建议的 SecurityDecision JSON"
            required
            hint="只是审核建议，平台会独立核对每个 origin 与动作效果。"
            error={jsonFieldError("decision")}
          >
            <Textarea
              id={CONNECTOR_ID.decision}
              value={d.decisionJson}
              onChange={(e) => draft.set({ decisionJson: e.target.value })}
              onBlur={() => setTouched((t) => ({ ...t, decision: true }))}
              rows={9}
              className="resize-y font-mono"
              placeholder={
                '{"audience":{"apiOrigins":["https://api.example.com:443"],…},"actions":{"list":{"effect":"read"}}}'
              }
            />
          </Field>
          <div className="-mt-2 flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={decision.state !== "ok"}
              onClick={() =>
                draft.set({
                  decisionJson: JSON.stringify(decision.state === "ok" ? decision.value : {}, null, 2),
                })
              }
            >
              格式化
            </Button>
            {decision.state === "ok" && (
              <span className="text-caption text-success">JSON 格式正确。</span>
            )}
          </div>
        </div>
      </Panel>

      <HumanMetaFields
        idPrefix={CONNECTOR_ID.meta}
        meta={d.meta}
        onChange={(meta) => draft.set({ meta })}
        errors={metaErrors}
      />

      <SubmitBar
        missing={missing}
        error={err ? (err.field ? "请修正上方标记的字段后重新提交。" : err.message) : null}
        submitting={submitting}
        onSubmit={() => void submit()}
      />
    </div>
  );
}

// ── 我的发布 ────────────────────────────────────────────────────────────────

const STATUS_META: Record<
  string,
  { label: string; tone: "neutral" | "warning" | "success" | "danger" }
> = {
  pending: { label: "审核中", tone: "warning" },
  approved: { label: "已上架", tone: "success" },
  rejected: { label: "未通过", tone: "danger" },
};

/**
 * 我的发布记录（最近 50 条）。**有待办(审核中/未通过)时默认展开** —— 未通过恰恰是最
 * 需要用户立刻处理的状态,把它藏在折叠条后面等于没给。每条被拒记录都带一条
 * 「载入这次提交继续修改」的回程路径,而不是只丢一句拒绝理由让用户全部重打。
 */
function MyPublishes({
  auth,
  rows,
  loading,
  error,
  onRefresh,
  onMuteTransition,
  open,
  onOpenChange,
  onRefill,
}: {
  auth: AuthSession;
  rows: MarketplaceMyPublish[] | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onMuteTransition: (versionId: string, muted: boolean) => void;
  /** null = 未指定,按"有待办自动展开"。 */
  open: boolean | null;
  onOpenChange: (open: boolean) => void;
  onRefill: (r: MarketplaceMyPublish) => void | Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [confirmDialog, confirmEl] = useConfirm();
  const toast = useToast();

  const withdraw = async (r: MarketplaceMyPublish) => {
    const go = await confirmDialog({
      title: `撤销 ${r.name} v${r.version}？`,
      body: "撤销后该版本不会再进入审核；记录会保留在「我的发布」里。",
      confirmText: "撤销发布",
      danger: true,
    });
    if (!go) return;
    setBusyId(`withdraw:${r.versionId}`);
    setActionErr(null);
    // 用户主动撤销不是审核拒绝，不应弹出“未通过审核”的自动通知。
    onMuteTransition(r.versionId, true);
    try {
      await api.withdrawMarketplacePublish(auth, r.versionId);
      onRefresh();
      toast(`已撤销「${r.name}」v${r.version}`, "success");
    } catch (e) {
      onMuteTransition(r.versionId, false);
      setActionErr(apiErrorMessage(e, "撤销发布失败"));
    } finally {
      setBusyId(null);
    }
  };

  const unlist = async (r: MarketplaceMyPublish) => {
    const go = await confirmDialog({
      title: `下架「${r.name}」？`,
      body: "下架后其他用户不能再搜索或安装；已安装用户的容器下次同步会移除该条目。以后提交新版本并通过审核可重新上架。",
      confirmText: "下架",
      danger: true,
    });
    if (!go) return;
    setBusyId(`unlist:${r.versionId}`);
    setActionErr(null);
    try {
      await api.unlistMarketplaceListing(auth, r.slug);
      onRefresh();
      toast(`已下架「${r.name}」`, "success");
    } catch (e) {
      setActionErr(apiErrorMessage(e, "下架失败"));
    } finally {
      setBusyId(null);
    }
  };

  if (loading && !rows) return <ListSkeleton rows={2} />;
  if ((!rows || rows.length === 0) && !error) return null;
  if (!rows || rows.length === 0)
    return (
      <Alert
        tone="danger"
        density="compact"
        action={
          <Button size="sm" variant="secondary" onClick={onRefresh}>
            重试
          </Button>
        }
      >
        {error}
      </Alert>
    );

  const pending = rows.filter((r) => r.status === "pending").length;
  const rejected = rows.filter((r) => r.status === "rejected").length;
  // 有待办就默认展开:未通过/审核中是用户此刻唯一需要动作的东西。
  const isOpen = open ?? pending + rejected > 0;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-elevated">
      {confirmEl}
      <button
        type="button"
        onClick={() => onOpenChange(!isOpen)}
        aria-expanded={isOpen}
        aria-controls="my-publishes-list"
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRight
          size={15}
          className={cn("shrink-0 text-faint transition-transform", isOpen && "rotate-90")}
        />
        <span className="text-body font-medium text-fg">我的发布（{rows.length}）</span>
        <span className="flex items-center gap-1.5">
          {pending > 0 && <Badge tone="warning">{pending} 审核中</Badge>}
          {rejected > 0 && <Badge tone="danger">{rejected} 未通过</Badge>}
        </span>
      </button>
      {isOpen && (
        <ul id="my-publishes-list" className="flex flex-col border-t border-border">
          {error && (
            <li className="border-b border-border px-3.5 py-2.5">
              <Alert
                tone="danger"
                density="compact"
                action={
                  <Button size="sm" variant="secondary" onClick={onRefresh}>
                    重试
                  </Button>
                }
              >
                {error}
              </Alert>
            </li>
          )}
          {actionErr && (
            <li className="border-b border-border px-3.5 py-2.5">
              <Alert tone="danger" density="compact" onDismiss={() => setActionErr(null)}>
                {actionErr}
              </Alert>
            </li>
          )}
          {rows.map((r) => {
            const withdrawn = r.status === "rejected" && r.reviewNote === "作者撤销发布";
            const unlisted = r.status === "approved" && r.listingState === "unlisted";
            const revoked = r.status === "approved" && r.listingState === "revoked";
            const meta = withdrawn
              ? { label: "已撤销", tone: "neutral" as const }
              : unlisted
                ? { label: "已下架", tone: "warning" as const }
                : revoked
                  ? { label: "平台下架", tone: "danger" as const }
                  : (STATUS_META[r.status] ?? { label: r.status, tone: "warning" as const });
            const canWithdraw = r.status === "pending";
            const canUnlist = r.status === "approved" && r.isCurrent && r.listingState === "active";
            const canRefill = r.status === "rejected";
            return (
              <li key={r.versionId} className="border-b border-border px-3.5 py-3 last:border-b-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-body font-medium text-fg">{r.name}</span>
                  <span className="shrink-0 text-caption text-faint">v{r.version}</span>
                  {r.kind === "agent" && <Badge tone="accent">智能体</Badge>}
                  {marketplaceArtifactKind(r) === "plugin" && <Badge tone="info">API 插件</Badge>}
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  {r.status === "approved" && !r.isCurrent && !revoked && !unlisted && (
                    <Badge tone="neutral">已被新版本取代</Badge>
                  )}
                  <TimeAgo
                    value={r.createdAt}
                    className="ml-auto shrink-0 text-caption text-faint"
                  />
                </div>
                {r.status === "pending" && (
                  <p className="mt-1 text-caption text-faint">
                    AI 审核通常几分钟内完成；需要人工复核的会稍慢。
                  </p>
                )}
                {withdrawn && <p className="mt-1.5 text-meta text-muted">你已撤销此提交。</p>}
                {!withdrawn && r.status === "rejected" && r.reviewNote && (
                  <p className="mt-1.5 text-meta leading-relaxed text-muted">
                    <span className="font-medium text-danger">拒绝理由：</span>
                    {r.reviewNote}
                  </p>
                )}
                {(canWithdraw || canUnlist || canRefill) && (
                  <div className="mt-2 flex flex-wrap justify-end gap-2">
                    {canRefill && (
                      <Button size="sm" variant="secondary" onClick={() => void onRefill(r)}>
                        载入这次提交继续修改
                      </Button>
                    )}
                    {canWithdraw && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void withdraw(r)}
                        loading={busyId === `withdraw:${r.versionId}`}
                        disabled={busyId !== null}
                      >
                        撤销发布
                      </Button>
                    )}
                    {canUnlist && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => void unlist(r)}
                        loading={busyId === `unlist:${r.versionId}`}
                        disabled={busyId !== null}
                      >
                        下架
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
