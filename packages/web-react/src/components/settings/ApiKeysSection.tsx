import { publicCursorFamilyModelId } from "@openclaude/protocol";
import {
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  PlugZap,
  ShieldCheck,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { ApiError, api, apiErrorMessage } from "../../lib/api";
import { BRAND } from "../../lib/brand";
import type { ApiKeyPatch, ApiKeySummary, AuthSession, CreatedApiKey } from "../../lib/types";
import { cn, formatCredits } from "../../lib/utils";
import {
  Alert,
  Button,
  Input,
  Progress,
  Spinner,
  Switch,
  Tabs,
  buttonVariants,
  useConfirm,
} from "../ui";
import { shortTime } from "./labels";
import { TablePager, useTablePage } from "./TablePager";

/** 外接端点(相对当前 origin)。CC Switch / Claude Code 的 base URL 都填到这一层,`/v1/*` 由客户端拼。 */
export const API_ACCESS_BASE_PATH = "/api/anthropic";
/**
 * 默认主模型 / 轻量模型的**公开家族 id**(无引擎前缀、无思考档位后缀,2026-09-08)。
 * 思考深度不写进模型名:用户在 Claude Code 里自己用 /effort、--effort、CLAUDE_CODE_EFFORT_LEVEL
 * 或 /model 滑杆设置,服务端按请求携带的 output_config.effort 选档。若用户实际可用列表里没有,退到列表首项。
 */
const DEFAULT_MAIN_MODEL = "fable-5.1";
const DEFAULT_OPUS_MODEL = "opus-5";
const DEFAULT_SONNET_MODEL = "sonnet-5";
const DEFAULT_HAIKU_MODEL = "haiku-4.5";
/**
 * 默认接入的模型集合(管理员裁定 2026-09-08):fable 5.1 / opus 5 / opus 4.8 / sonnet 5 /
 * haiku 4.5。也是模型列表拉取失败时的静态说明;真值以 /v1/models 为准,并且教程只展示
 * 这个集合与实际可用列表的交集(其它可用家族仍可通过 /v1/models 发现、直接填写使用)。
 */
const DEFAULT_MODEL_SET: readonly string[] = [
  "fable-5.1",
  "opus-5",
  "opus-4.8",
  "sonnet-5",
  "haiku-4.5",
];

/**
 * 教程里"当前可用"要展示的家族清单。
 *   - 列表未加载 / 加载失败 / 为空 → 静态 `DEFAULT_MODEL_SET`(说明性质,真值以 /v1/models 为准);
 *   - 拉到了 → `DEFAULT_MODEL_SET` 与实际可用列表的**交集**,顺序按 DEFAULT_MODEL_SET;
 *   - 交集为空(目录整体换代)→ 退回实际列表,不给用户一份全是不可用 id 的清单。
 * 其它可用家族仍可通过 `/v1/models` 自行发现并直接填写,这里只是"推荐默认集"。
 */
export function familyGuideList(available: string[] | null): string[] {
  if (!available || available.length === 0) return [...DEFAULT_MODEL_SET];
  const intersection = DEFAULT_MODEL_SET.filter((id) => available.includes(id));
  return intersection.length > 0 ? intersection : available;
}
/**
 * 随配置一并写给 Claude Code 的额外环境变量。
 * `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1`:官方文档 —— 对 Claude Code 不认识的模型 id(经网关 / 自定义
 * 标识)也照常发送 effort 参数。本站模型 id 不在它的内置名单里,不带这一项时部分版本会把用户设的
 * 思考深度丢掉、服务端只能落到家族默认档。CC Switch ≥3.16 深链的 `config` 参数会把它保留进 settings。
 */
const CLAUDE_CODE_EXTRA_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1",
};
const CC_SWITCH_RELEASES = "https://github.com/farion1231/cc-switch/releases";
/** 稳定的空数组引用(列表未加载时喂给 useTablePage,避免每次渲染换引用)。 */
const EMPTY_KEYS: ApiKeySummary[] = [];

/** 在可用列表中挑默认模型:首选项在列表里就用它;列表为空/未加载也用它(静态兜底);否则用列表里第一个匹配项。 */
export function pickDefaultModel(
  available: string[] | null,
  preferred: string,
  fallbackPattern?: RegExp,
): string {
  if (!available || available.length === 0 || available.includes(preferred)) return preferred;
  if (fallbackPattern) {
    const hit = available.find((id) => fallbackPattern.test(id));
    if (hit) return hit;
  }
  return available[0]!;
}

/** 本站密钥格式与服务端生成契约一致;前缀/掩码不能充当完整密钥。 */
export function isCompleteApiKey(value: string): boolean {
  return /^oc-cc\.[a-z0-9]{8}\.[a-f0-9]{48}$/.test(value.trim());
}

/**
 * CC Switch「用量查询」脚本(它的 JS-script 路径:`({ request, extractor })`,QuickJS 内跑,
 * `{{baseUrl}}` / `{{apiKey}}` 由 CC Switch 用该供应商的 ANTHROPIC_BASE_URL / AUTH_TOKEN 替换)。
 * 打本站 `GET /v1/usage`,把积分余额与单 key 消耗映射到它 footer 的 remaining / used / total。
 * 深链里以 base64 携带(`usageScript` 参数),手动配置时也可整段贴进它的「自定义」模板。
 */
export function buildCcSwitchUsageScript(): string {
  return [
    "({",
    "  request: {",
    '    url: "{{baseUrl}}/v1/usage",',
    '    method: "GET",',
    "    headers: {",
    '      "Authorization": "Bearer {{apiKey}}",',
    '      "User-Agent": "cc-switch/usage"',
    "    }",
    "  },",
    "  extractor: function (response) {",
    "    if (!response || response.object !== \"usage\") {",
    '      return { isValid: false, invalidMessage: (response && response.error && response.error.message) || "查询失败" };',
    "    }",
    "    var key = response.key || {};",
    "    var spendable = Number(response.balance && response.balance.spendable) || 0;",
    "    var spent = Number(key.spent_credits) || 0;",
    "    var limit = key.credit_limit === null || key.credit_limit === undefined ? null : Number(key.credit_limit);",
    "    var remaining = limit === null ? spendable : Math.min(spendable, Math.max(limit - spent, 0));",
    "    return {",
    "      isValid: key.is_valid !== false,",
    '      invalidMessage: key.is_valid === false ? "余额不足或已达该密钥上限" : undefined,',
    '      planName: key.label || "API Key",',
    "      remaining: remaining,",
    "      used: spent,",
    "      total: limit === null ? -1 : limit,",
    '      unit: "积分",',
    '      extra: "近 30 天 " + (Number(response.window && response.window.requests) || 0) + " 次请求"',
    "    };",
    "  }",
    "})",
  ].join("\n");
}

/** UTF-8 安全的 base64(CC Switch 接收端 `decode_base64_param` 同时接受标准/URL-safe、带/不带 padding)。 */
function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * CC Switch 深链(`ccswitch://v1/import`,V1 协议)。必须包含完整 apiKey,否则接收端确认导入时拒绝。
 * 明文只来自本次创建或用户粘贴,绝不从 keyPrefix/掩码构造。
 *
 * `enabled=true`:导入后立即切换为 Claude Code 当前供应商(CC Switch `ProviderService::switch`)。
 * 不带它,CC Switch 只是把供应商加进列表,`~/.claude/settings.json` 仍指向之前激活的那一个 ——
 * 用户撤销旧 key 再一键导入新 key,本地 Claude Code 仍在用旧 key,表现就是 401。
 * `usageEnabled=true` + `usageScript`:一并带上用量查询脚本并开启(CC Switch 确认框会展示脚本正文)。
 * `config`(base64 JSON `{"env":{…}}`):CC Switch 以它的 env 为底、再叠加 URL 参数写 settings,
 * 用来带上 URL 参数表达不了的额外环境变量(`CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1`,见 CLAUDE_CODE_EXTRA_ENV)。
 * 旧版 CC Switch(<3.16)会忽略额外 env,只剩标准字段,仍能正常导入。
 */
export function buildCcSwitchDeepLink(input: {
  origin: string;
  name: string;
  apiKey?: string | null;
  model: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
}): string | null {
  const apiKey = input.apiKey?.trim() ?? "";
  if (!isCompleteApiKey(apiKey)) return null;
  const params = new URLSearchParams({
    resource: "provider",
    app: "claude",
    name: input.name,
    endpoint: `${input.origin}${API_ACCESS_BASE_PATH}`,
    model: input.model,
    opusModel: input.opusModel,
    sonnetModel: input.sonnetModel,
    haikuModel: input.haikuModel,
    enabled: "true",
    usageEnabled: "true",
    usageScript: base64Utf8(buildCcSwitchUsageScript()),
    usageAutoInterval: "30",
    configFormat: "json",
    config: base64Utf8(JSON.stringify({ env: CLAUDE_CODE_EXTRA_ENV })),
  });
  params.set("apiKey", apiKey);
  return `ccswitch://v1/import?${params.toString()}`;
}

/** 深链 `config` 里附带的 env(测试与文案共用一处真值)。 */
export function claudeCodeExtraEnv(): Readonly<Record<string, string>> {
  return CLAUDE_CODE_EXTRA_ENV;
}

/**
 * API Key 自管:list / create(一次性明文展示)/ rename / 临时禁用 / 单 key 上限 / 撤销。
 *
 * commercial-only:admin 角色由父组件先验控制挂载;403 隐藏仍作为角色变更竞态兜底。
 * `onKeysChange` 让父级(消耗统计的 key 下拉)与列表保持同步。
 */
export function ApiKeysSection({
  auth,
  onKeysChange,
}: {
  auth: AuthSession;
  onKeysChange?: (keys: ApiKeySummary[]) => void;
}) {
  const [hidden, setHidden] = useState(false);
  const [keys, setKeysState] = useState<ApiKeySummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [keySource, setKeySource] = useState("new");
  const [existingKey, setExistingKey] = useState("");
  const [endpointCopied, setEndpointCopied] = useState(false);
  const keyInputId = useId();
  const keyHintId = useId();
  const [copiedBlock, setCopiedBlock] = useState<"env" | "ccswitch" | "usage" | null>(null);
  const [confirmDialog, confirmDialogEl] = useConfirm();
  /** 正在被 PATCH 的 key id(禁用按钮防双击)。 */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 当前用户经外接端点可用的模型公开 id(null = 未加载/加载失败 → 用静态兜底)。 */
  const [externalModels, setExternalModels] = useState<string[] | null>(null);

  const setKeys = setKeysState;
  useEffect(() => {
    if (keys) onKeysChange?.(keys);
  }, [keys, onKeysChange]);

  // 外接可用模型 = 站内公开模型列表里外接引擎那一部分,按公开**家族** id(无引擎前缀、无档位
  // 后缀)展示,同家族多个档位折叠成一项 —— 与 GET /api/anthropic/v1/models 同一投影。
  // 拉取失败不报错,教程退到静态默认值。
  useEffect(() => {
    let alive = true;
    api
      .getPublicModels(auth)
      .then(({ models }) => {
        if (!alive) return;
        const ids: string[] = [];
        for (const m of models) {
          if (m.engine !== "cursor") continue;
          const id = publicCursorFamilyModelId(m.id);
          if (!ids.includes(id)) ids.push(id);
        }
        setExternalModels(ids);
      })
      .catch(() => {
        if (alive) setExternalModels(null);
      });
    return () => {
      alive = false;
    };
  }, [auth]);

  // base URL 取当前页面 origin(quick tunnel 域名会变,不能写死)。模型 id 用公开 id;
  // 服务端不做 claude-* → 站内模型的别名,ANTHROPIC_MODEL 必须显式指定。
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const endpoint = `${origin}${API_ACCESS_BASE_PATH}`;
  const modelsUrl = `${endpoint}/v1/models`;
  const usageUrl = `${endpoint}/v1/usage`;
  const usageScript = useMemo(() => buildCcSwitchUsageScript(), []);
  const mainModel = pickDefaultModel(externalModels, DEFAULT_MAIN_MODEL, /^(fable|opus)-/);
  const opusModel = pickDefaultModel(externalModels, DEFAULT_OPUS_MODEL, /^(opus|fable)-/);
  const sonnetModel = pickDefaultModel(externalModels, DEFAULT_SONNET_MODEL, /^sonnet-/);
  // 轻量位:haiku 优先;没有就退到 gemini flash,再退到 sonnet。
  const haikuModel = pickDefaultModel(externalModels, DEFAULT_HAIKU_MODEL, /^haiku-|^gemini-|-flash(-|$)|^sonnet-/);
  const candidateKey = keySource === "new" ? (justCreated?.plaintext ?? "") : existingKey.trim();
  const knownKey = keys?.find(
    (key) => candidateKey.split(".")[1] === key.keyPrefix.replace(/^oc-cc\./, ""),
  );
  const keyReady = isCompleteApiKey(candidateKey) && !knownKey?.disabledAt;
  const keyPlaceholder = keyReady ? candidateKey : "oc-cc.<你的密钥>";
  const keyHint = knownKey?.disabledAt
    ? "该密钥已停用,请先在密钥管理中启用。"
    : candidateKey && !isCompleteApiKey(candidateKey)
      ? "请粘贴完整密钥,不是列表中显示的前缀或掩码。"
      : keyReady
        ? keySource === "new"
          ? "已包含刚创建的密钥,可直接导入。"
          : "已填入完整密钥。有效性以实际请求为准。"
        : "请先创建新密钥或粘贴已有的完整密钥,再导入。";
  const extraEnvLines = Object.entries(CLAUDE_CODE_EXTRA_ENV).map(([k, v]) => `export ${k}=${v}`);
  const claudeCodeSnippet = [
    `export ANTHROPIC_BASE_URL=${endpoint}`,
    `export ANTHROPIC_AUTH_TOKEN='${keyPlaceholder}'`,
    `export ANTHROPIC_MODEL=${mainModel}`,
    `export ANTHROPIC_DEFAULT_OPUS_MODEL=${opusModel}`,
    `export ANTHROPIC_DEFAULT_SONNET_MODEL=${sonnetModel}`,
    `export ANTHROPIC_DEFAULT_HAIKU_MODEL=${haikuModel}`,
    ...extraEnvLines,
    "claude",
  ].join("\n");
  // CC Switch「自定义」供应商的 JSON 配置(它编辑器里贴的就是这一段)。
  const ccSwitchConfig = JSON.stringify(
    {
      env: {
        ANTHROPIC_BASE_URL: endpoint,
        ANTHROPIC_AUTH_TOKEN: keyPlaceholder,
        ANTHROPIC_MODEL: mainModel,
        ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
        ...CLAUDE_CODE_EXTRA_ENV,
      },
    },
    null,
    2,
  );
  const ccSwitchDeepLink = useMemo(
    () =>
      buildCcSwitchDeepLink({
        origin,
        // 必须是 ASCII:CC Switch 用 name 派生供应商 id(`is_alphanumeric` 保留汉字),再把
        // `%TEMP%\claude_<id>_<pid>.json` 写进 UTF-8 无 BOM 的 .bat 交给 cmd.exe ——含中文时
        // cmd 会把后续行错位切分(「'g' / '--settings' 不是内部或外部命令」),「打开终端」直接失败。
        name: BRAND.nameEn,
        apiKey: keyReady ? candidateKey : null,
        model: mainModel,
        opusModel,
        sonnetModel,
        haikuModel,
      }),
    [origin, candidateKey, keyReady, mainModel, opusModel, sonnetModel, haikuModel],
  );
  // 教程展示的家族清单:默认集 ∩ 实际可用(见 familyGuideList)。
  const familyList = useMemo(() => familyGuideList(externalModels), [externalModels]);
  // 密钥列表每页 10 条(与用量表同一 TablePager);≤10 条时不渲染翻页控件。
  const keyPage = useTablePage<ApiKeySummary>(keys ?? EMPTY_KEYS);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .listApiKeys(auth)
      .then((ks) => {
        if (alive) setKeys(ks);
      })
      .catch((e) => {
        if (!alive) return;
        // 403 = admin-only rollout:整段隐藏,普通用户无感。
        if (e instanceof ApiError && e.status === 403) {
          setHidden(true);
          return;
        }
        setErr(apiErrorMessage(e, "加载 API Key 失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth]);

  async function create() {
    const l = label.trim();
    if (!l || creating) return;
    setCreating(true);
    setErr(null);
    try {
      const created = await api.createApiKey(auth, l);
      setJustCreated(created);
      setKeySource("new");
      setCopied(false);
      setLabel("");
      setKeys((prev) => [
        {
          id: created.id,
          label: created.label,
          keyPrefix: created.keyPrefix,
          createdAt: created.createdAt,
          lastUsedAt: null,
          disabledAt: null,
          creditLimit: null,
          spentCredits: "0",
        },
        ...(prev ?? []),
      ]);
    } catch (e) {
      setErr(apiErrorMessage(e, "创建失败"));
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: string) {
    const ok = await confirmDialog({
      title: "撤销该 API Key?",
      body: "使用它的集成将立即失效,不可恢复。如需暂停,请改用「禁用」。",
      confirmText: "撤销",
      danger: true,
    });
    if (!ok) return;
    setErr(null);
    try {
      await api.deleteApiKey(auth, id);
      setKeys((prev) => (prev ?? []).filter((k) => k.id !== id));
      if (justCreated?.id === id) setJustCreated(null);
      const removed = keys?.find((key) => key.id === id);
      if (removed && existingKey.trim().split(".")[1] === removed.keyPrefix.replace(/^oc-cc\./, ""))
        setExistingKey("");
    } catch (e) {
      setErr(apiErrorMessage(e, "撤销失败"));
    }
  }

  async function patch(id: string, p: ApiKeyPatch): Promise<boolean> {
    if (busyId) return false;
    setBusyId(id);
    setErr(null);
    try {
      const updated = await api.updateApiKey(auth, id, p);
      setKeys((prev) => (prev ?? []).map((k) => (k.id === id ? updated : k)));
      return true;
    } catch (e) {
      setErr(apiErrorMessage(e, "更新失败"));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function copyPlaintext() {
    if (!justCreated) return;
    try {
      await navigator.clipboard.writeText(justCreated.plaintext);
      setCopied(true);
    } catch {
      setCopied(false);
      setErr("复制失败,请手动选择并复制密钥。");
    }
  }

  async function copyBlock(kind: "env" | "ccswitch" | "usage") {
    try {
      await navigator.clipboard.writeText(
        kind === "env" ? claudeCodeSnippet : kind === "ccswitch" ? ccSwitchConfig : usageScript,
      );
      setCopiedBlock(kind);
    } catch {
      setCopiedBlock(null);
      setErr("复制失败,请手动选择并复制配置。");
    }
  }

  if (hidden) return null;

  return (
    <div className="px-5 py-4">
      {confirmDialogEl}
      {err && (
        <Alert tone="danger" className="mb-2 text-meta">
          {err}
        </Alert>
      )}

      <section
        className="rounded-2xl border border-accent/20 bg-accent-soft/30 p-4 sm:p-5"
        data-testid="guide-ccswitch"
      >
        <div className="mb-4 flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-white">
            <PlugZap size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-section font-semibold text-fg">用 CC Switch 一键接入</h3>
            <p className="mt-1 text-meta text-muted">准备密钥 → 导入配置 → 在本机开始使用</p>
          </div>
          <span className="rounded-full bg-surface px-2 py-1 text-caption text-accent">推荐</span>
        </div>
        <Tabs
          aria-label="密钥来源"
          value={keySource}
          onValueChange={(value) => {
            setKeySource(value);
            setCopiedBlock(null);
          }}
          items={[
            { value: "new", label: "创建新密钥" },
            { value: "existing", label: "使用已有密钥" },
          ]}
        />
        <div className="mt-3">
          {keySource === "new" ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Input
                  aria-label="新密钥名称"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="新密钥名称(如 my-cli)"
                  maxLength={64}
                  className="h-auto bg-bg px-3 py-2 text-section"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") create();
                  }}
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={create}
                  disabled={creating || !label.trim()}
                  className="shrink-0"
                >
                  {creating ? "创建中…" : "创建"}
                </Button>
              </div>

              {keySource === "new" && justCreated && (
                <Alert tone="warning" className="mb-3 flex flex-col gap-2 text-meta">
                  <span>请立即复制并妥善保存,关闭后将无法再次查看完整密钥。</span>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-md bg-bg px-2 py-1 font-mono text-meta text-fg">
                      {justCreated.plaintext}
                    </code>
                    <Button variant="secondary" size="sm" onClick={copyPlaintext}>
                      <Copy size={13} /> {copied ? "已复制" : "复制"}
                    </Button>
                  </div>
                </Alert>
              )}

              {!justCreated && (
                <p className="text-caption text-muted">
                  建议按设备命名,例如 MacBook。完整密钥仅在创建时显示。
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <label htmlFor={keyInputId} className="block text-meta font-medium text-fg">
                完整 API Key
              </label>
              <Input
                id={keyInputId}
                type="password"
                value={existingKey}
                onChange={(e) => {
                  setExistingKey(e.target.value);
                  setCopiedBlock(null);
                }}
                placeholder="粘贴 oc-cc. 开头的完整密钥"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={keyHintId}
                aria-invalid={!!candidateKey && !keyReady}
              />
              <p className="text-caption text-muted">
                密钥仅在本页临时使用,刷新即清除。找不到完整密钥?请切换到「创建新密钥」。
              </p>
            </div>
          )}
        </div>
        <div className="mt-4 flex flex-col items-start gap-2">
          {ccSwitchDeepLink ? (
            <a
              href={ccSwitchDeepLink}
              className={cn(
                buttonVariants({ variant: "primary", size: "sm" }),
                "min-h-10 w-full sm:w-auto",
              )}
              data-testid="ccswitch-deeplink"
            >
              <ExternalLink size={15} /> 一键导入到 CC Switch
            </a>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled
              className="min-h-10 w-full sm:w-auto"
              data-testid="ccswitch-deeplink"
            >
              <ExternalLink size={15} /> 一键导入到 CC Switch
            </Button>
          )}
          <p
            id={keyHintId}
            role="status"
            className={cn(
              "text-caption",
              candidateKey && !keyReady ? "text-warning" : "text-muted",
            )}
          >
            {keyHint}
          </p>
        </div>
        <div className="mt-4 border-t border-accent/15 pt-3 text-caption text-muted">
          <p>
            导入会将密钥交给本机 CC Switch,并直接切换为 Claude Code 当前供应商、开启用量查询,请勿分享导入链接。
          </p>
          <p className="mt-1">
            导入后请<b>重新打开终端</b>再运行 <code className="font-mono">claude</code>
            ;若之前手动设置过 <code className="font-mono">ANTHROPIC_API_KEY</code> /{" "}
            <code className="font-mono">ANTHROPIC_AUTH_TOKEN</code> 环境变量,请先清掉,避免旧密钥与新密钥同时发送。
          </p>
          <p className="mt-1">
            还未安装?{" "}
            <a
              href={CC_SWITCH_RELEASES}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent hover:underline"
            >
              下载 CC Switch <ExternalLink size={11} className="inline" />
            </a>{" "}
            · 安装后重新点击导入。
          </p>
        </div>
      </section>

      <div className="mt-4 rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-caption font-medium text-muted">API 端点 · Anthropic 兼容</span>
          <Button
            variant="ghost"
            size="sm"
            aria-label="复制 API 端点"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(endpoint);
                setEndpointCopied(true);
              } catch {
                setErr("复制失败,请手动复制端点地址。");
              }
            }}
          >
            <Copy size={13} /> {endpointCopied ? "已复制" : "复制"}
          </Button>
        </div>
        <code className="mt-1 block select-all break-all font-mono text-meta text-fg">
          {endpoint}
        </code>
      </div>

      <section className="mt-6" aria-label="密钥管理">
        <div className="mb-3 flex items-center gap-2">
          <KeyRound size={16} className="text-muted" />
          <h3 className="text-section font-semibold text-fg">密钥管理</h3>
          {keys && (
            <span className="rounded-full bg-hover px-2 py-0.5 text-caption text-muted">
              {keys.length}
            </span>
          )}
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-4 text-body text-faint">
            <Spinner /> 加载中…
          </div>
        ) : !keys || keys.length === 0 ? (
          <p className="py-3 text-center text-meta text-faint">
            还没有 API Key。在上方「创建新密钥」里起个名(如 MacBook)即可创建第一把。
          </p>
        ) : (
          <>
            <ul className="flex flex-col gap-2" data-testid="api-keys-list">
              {keyPage.pageRows.map((k) => (
                <ApiKeyRow
                  key={k.id}
                  k={k}
                  busy={busyId === k.id}
                  onPatch={(p) => patch(k.id, p)}
                  onRemove={() => remove(k.id)}
                />
              ))}
            </ul>
            <TablePager
              label="密钥列表"
              page={keyPage.page}
              pageCount={keyPage.pageCount}
              onPageChange={keyPage.setPage}
            />
          </>
        )}

        <p className="mt-3 flex items-start gap-1.5 text-caption text-faint">
          <ShieldCheck size={14} className="shrink-0" />
          可随时停用、设置积分上限或撤销,不影响网页对话。
        </p>
      </section>

      <details
        className="mt-5 rounded-xl border border-border p-3 text-caption"
        data-testid="guide-manual-ccswitch"
      >
        <summary className="cursor-pointer font-medium text-muted">
          手动配置 CC Switch · JSON
        </summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-faint">
          <li>
            或手动添加:打开 CC Switch → <b>Claude Code</b> 标签 → 右上角 <b>+</b> 添加供应商 →
            预设选「<b>自定义</b>」。
          </li>
          <li>
            名称请用<b>英文</b>(如 <code className="font-mono">{BRAND.nameEn}</code>
            ,中文名会让 Windows 上的「打开终端」失败);端点地址填{" "}
            <code className="select-all font-mono">{endpoint}</code>;API Key 填{" "}
            <code className="font-mono">oc-cc.…</code> 密钥。
          </li>
          <li>
            点模型输入框旁的「<b>获取模型</b>」(下载图标)即可拉到你可用的模型列表(CC Switch 会请求{" "}
            <code className="select-all font-mono">{modelsUrl}</code>),选一个作为默认模型;
            或直接把下面这段 JSON 贴进它的配置编辑器。
          </li>
          <li>
            点「添加」并<b>启用</b>该供应商(卡片处于选中态),重新打开终端运行{" "}
            <code className="font-mono">claude</code>。
          </li>
        </ol>
        <p className="mt-2 text-caption text-muted">
          {keyReady
            ? "复制将包含完整密钥,请勿分享配置。已有密钥在预览中已隐藏。"
            : "以下是配置模板,请先在上方准备密钥。"}
        </p>
        <div className="mt-2 flex items-start gap-2">
          <pre
            className="min-w-0 flex-1 overflow-x-auto rounded-md bg-bg px-2 py-1.5 font-mono text-caption text-fg"
            data-testid="ccswitch-config"
          >
            {keySource === "existing" && keyReady
              ? ccSwitchConfig.replace(candidateKey, "oc-cc.••••••••.••••••••")
              : ccSwitchConfig}
          </pre>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => copyBlock("ccswitch")}
            className="shrink-0"
          >
            <Copy size={13} /> {copiedBlock === "ccswitch" ? "已复制" : "复制"}
          </Button>
        </div>
      </details>

      <details
        className="mt-2 rounded-xl border border-border p-3 text-caption"
        data-testid="guide-usage"
      >
        <summary className="cursor-pointer font-medium text-muted">
          在 CC Switch 里查看余额与用量
        </summary>
        <p className="mt-2 text-faint">
          一键导入已自动开启。手动添加的供应商:卡片菜单 →「<b>用量查询</b>」→ 模板选「<b>自定义</b>
          」→ 把下面脚本整段贴进去 → 开启并「测试」。脚本用该供应商已填的端点与密钥请求{" "}
          <code className="select-all font-mono">GET {usageUrl}</code>
          ,显示当前可用积分、该密钥累计消耗与上限(无上限时显示 ∞)。
        </p>
        <div className="mt-2 flex items-start gap-2">
          <pre
            className="min-w-0 flex-1 overflow-x-auto rounded-md bg-bg px-2 py-1.5 font-mono text-caption text-fg"
            data-testid="usage-script"
          >
            {usageScript}
          </pre>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => copyBlock("usage")}
            className="shrink-0"
          >
            <Copy size={13} /> {copiedBlock === "usage" ? "已复制" : "复制"}
          </Button>
        </div>
      </details>

      <details
        className="mt-2 rounded-xl border border-border p-3 text-caption"
        data-testid="guide-troubleshoot"
      >
        <summary className="cursor-pointer font-medium text-muted">
          Claude Code 报 401 / Auth conflict 怎么办
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-faint">
          <li>
            <b>401 container identity verification failed</b>:密钥已撤销、已停用,或本机 Claude Code
            用的不是这把密钥。到 CC Switch 确认<b>当前选中</b>的供应商就是本站、密钥是密钥管理里仍有效的那一把;
            撤销旧密钥后必须重新导入或改填新密钥。
          </li>
          <li>
            <b>Auth conflict: Both a token and an API key are set</b>:系统环境变量里残留了{" "}
            <code className="font-mono">ANTHROPIC_API_KEY</code>(或{" "}
            <code className="font-mono">ANTHROPIC_AUTH_TOKEN</code>)。Claude Code 会把两把凭据一起发送,
            请在系统环境变量 / shell 配置里删掉,只保留 CC Switch 写入的{" "}
            <code className="font-mono">ANTHROPIC_AUTH_TOKEN</code>,然后重开终端。
          </li>
          <li>
            公司代理:本站端点是普通 HTTPS,与浏览器同路;若浏览器能打开本站但 Claude Code 报连接错误,
            为终端设置 <code className="font-mono">HTTPS_PROXY</code>。401 与代理无关。
          </li>
          <li>
            CC Switch 的「检测连通」只探测地址可达,不校验密钥;真正的验证以运行{" "}
            <code className="font-mono">claude</code> 后能回话、或「用量查询」能显示余额为准。
          </li>
          <li>
            <b>「打开终端」报 'g' / '--settings' 不是内部或外部命令</b>(Windows):CC Switch
            按供应商名生成临时配置路径并写进 .bat,名称含中文时 cmd.exe 会把命令行切错。把该供应商<b>重命名为英文</b>
            (或删掉后重新一键导入,新链接已改用英文名)即可;
            也可以不用它的「打开终端」,直接在自己的终端里运行 <code className="font-mono">claude</code>
            (CC Switch 已把配置写进 <code className="font-mono">~/.claude/settings.json</code>)。
          </li>
          <li>
            <b>启动时提示 "… isn't described by this version's model catalog"</b>:这是 Claude Code
            对非官方模型名的提示,不影响使用 —— 它只是不知道本站模型的上下文窗口,会按保守值触发自动压缩。
            想消除可在 <code className="font-mono">~/.claude/settings.json</code> 加{" "}
            <code className="font-mono">
              {`"modelPicker":{"options":[{"model":"${mainModel}","behavesAs":"claude-opus-5"}]}`}
            </code>
            (需 Claude Code ≥ 2.1.242),让它按 Opus 5 的客户端行为处理本站主模型。
          </li>
        </ul>
      </details>

      <details
        className="mt-2 rounded-xl border border-border p-3 text-caption"
        data-testid="guide-env"
      >
        <summary className="cursor-pointer text-muted">手动接入本地 Claude Code(环境变量)</summary>
        <p className="mt-2 text-faint">
          在本机终端设置以下环境变量后启动 <code className="font-mono">claude</code>
          。请求经本站 API Key 端点转发,按站内积分计费(余额为 0 或触达单 key 上限时返回 402)。
        </p>
        <p className="mt-2 text-caption text-muted">
          {keyReady
            ? "复制将包含完整密钥,请勿分享配置。已有密钥在预览中已隐藏。"
            : "以下是配置模板,请先在上方准备密钥。"}
        </p>
        <div className="mt-2 flex items-start gap-2">
          <pre
            className="min-w-0 flex-1 overflow-x-auto rounded-md bg-bg px-2 py-1.5 font-mono text-caption text-fg"
            data-testid="env-snippet"
          >
            {keySource === "existing" && keyReady
              ? claudeCodeSnippet.replace(candidateKey, "oc-cc.••••••••.••••••••")
              : claudeCodeSnippet}
          </pre>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => copyBlock("env")}
            className="shrink-0"
          >
            <Copy size={13} /> {copiedBlock === "env" ? "已复制" : "复制"}
          </Button>
        </div>
        <p className="mt-2 text-faint">
          可用模型请求 <code className="select-all font-mono">GET {modelsUrl}</code>
          (带同一个 API Key)查询,返回 Anthropic / OpenAI 兼容的{" "}
          <code className="font-mono">data[].id</code>
          。当前可用:
          {familyList.map((f, i) => (
            <span key={f}>
              {i > 0 ? " / " : " "}
              <code className="font-mono" data-testid="guide-family">
                {f}
              </code>
            </span>
          ))}
          (带 <code className="font-mono">-fast</code> 的为加速版、双倍计费)。以列表接口返回的为准。
        </p>
        <p className="mt-2 text-faint" data-testid="guide-effort">
          模型名<b>不含思考深度</b>。思考深度由你在 Claude Code 里自己设置:会话内{" "}
          <code className="font-mono">/effort</code>(或 <code className="font-mono">/model</code>{" "}
          里的滑杆)、启动参数 <code className="font-mono">--effort low|medium|high|xhigh|max</code>
          、或环境变量 <code className="font-mono">CLAUDE_CODE_EFFORT_LEVEL</code>
          ;未设置时按 <code className="font-mono">high</code> 运行。服务端按每次请求携带的档位选择对应算力,
          某家族不提供你选的档位时,自动落到不高于它的最近档位。配置里的{" "}
          <code className="font-mono">CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1</code>{" "}
          让 Claude Code 对本站模型名也发送思考深度,请保留。如需把某个供应商钉死在一个档位,
          模型名可写成 <code className="font-mono">fable-5.1-high</code> 这种带档位后缀的形式,此时忽略会话内设置。
        </p>
      </details>
    </div>
  );
}

/** 上限进度百分比(0..100,字符串大数用 BigInt 精确算,非法项当 0)。 */
export function limitPercent(spent: string, limit: string | null): number | null {
  if (limit === null || !/^\d+$/.test(limit) || !/^\d+$/.test(spent)) return null;
  const l = BigInt(limit);
  if (l <= 0n) return null;
  const pct = (BigInt(spent) * 100n) / l;
  return pct > 100n ? 100 : Number(pct);
}

function ApiKeyRow({
  k,
  busy,
  onPatch,
  onRemove,
}: {
  k: ApiKeySummary;
  busy: boolean;
  onPatch: (p: ApiKeyPatch) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState<"label" | "limit" | null>(null);
  const [draft, setDraft] = useState("");
  const disabled = k.disabledAt !== null;
  const pct = limitPercent(k.spentCredits, k.creditLimit);
  const tone = pct === null ? "neutral" : pct >= 100 ? "danger" : pct >= 80 ? "warning" : "brand";

  function startEdit(kind: "label" | "limit") {
    setDraft(kind === "label" ? k.label : (k.creditLimit ?? ""));
    setEditing(kind);
  }

  async function commit() {
    if (editing === "label") {
      const v = draft.trim();
      if (!v || v === k.label) return setEditing(null);
      if (await onPatch({ label: v })) setEditing(null);
      return;
    }
    if (editing === "limit") {
      const v = draft.trim();
      if (v === (k.creditLimit ?? "")) return setEditing(null);
      if (v !== "" && !/^[1-9][0-9]{0,18}$/.test(v)) return;
      if (await onPatch({ creditLimit: v === "" ? null : v })) setEditing(null);
    }
  }

  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-border bg-surface p-3 transition-colors hover:border-accent/30",
        disabled && "opacity-60",
      )}
      data-api-key-id={k.id}
    >
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          {editing === "label" ? (
            <span className="flex items-center gap-1">
              <Input
                autoFocus
                value={draft}
                maxLength={80}
                aria-label="密钥名称"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
                  if (e.key === "Escape") setEditing(null);
                }}
                className="h-7 bg-bg px-2 py-0.5 text-section"
              />
              <IconBtn label="保存" onClick={commit} disabled={busy}>
                <Check size={14} />
              </IconBtn>
              <IconBtn label="取消" onClick={() => setEditing(null)}>
                <X size={14} />
              </IconBtn>
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <span className="truncate text-section text-fg">{k.label}</span>
              <IconBtn label="重命名" onClick={() => startEdit("label")} disabled={busy}>
                <Pencil size={12} />
              </IconBtn>
              {disabled && (
                <span className="rounded bg-warning-soft px-1.5 py-0.5 text-caption text-warning">
                  已禁用
                </span>
              )}
            </span>
          )}
          <span className="block truncate font-mono text-caption text-faint">
            {k.keyPrefix}··· · {shortTime(k.createdAt)}
            {k.lastUsedAt ? ` · 最近使用 ${shortTime(k.lastUsedAt)}` : " · 从未使用"}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-caption text-faint">
          <span>{disabled ? "已停用" : "启用"}</span>
          <Switch
            aria-label={disabled ? "启用该密钥" : "禁用该密钥"}
            checked={!disabled}
            disabled={busy}
            onCheckedChange={(on) => void onPatch({ disabled: !on })}
          />
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label="撤销"
          className="flex size-9 shrink-0 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-danger-soft hover:text-danger focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-caption text-faint">
        <span className="shrink-0 tabular-nums">已用 {formatCredits(k.spentCredits)} 积分</span>
        {editing === "limit" ? (
          <span className="flex items-center gap-1">
            <span>/ 上限</span>
            <Input
              autoFocus
              inputMode="numeric"
              value={draft}
              aria-label="积分上限(留空为不限)"
              placeholder="不限"
              onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(null);
              }}
              className="h-6 w-28 bg-bg px-2 py-0 text-caption"
            />
            <IconBtn label="保存上限" onClick={commit} disabled={busy}>
              <Check size={13} />
            </IconBtn>
            <IconBtn label="取消" onClick={() => setEditing(null)}>
              <X size={13} />
            </IconBtn>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => startEdit("limit")}
            disabled={busy}
            className="rounded px-1 text-caption text-muted underline-offset-2 hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {k.creditLimit === null ? "设置上限" : `/ 上限 ${formatCredits(k.creditLimit)}`}
          </button>
        )}
        {pct !== null && (
          <Progress
            value={pct}
            tone={tone}
            aria-label={`已用 ${pct}%`}
            className="ml-auto h-1.5 w-24"
          />
        )}
      </div>
    </li>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-active hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      {children}
    </button>
  );
}
