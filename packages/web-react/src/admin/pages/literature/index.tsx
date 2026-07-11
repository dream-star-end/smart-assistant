import { FlaskConical, Save } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Badge, Button, Input, Skeleton, Spinner, Switch, useToast } from "../../../components/ui";
import { PageHeader, SectionCard, TimeAgo } from "../../components";
import { adminGet, adminSend, apiErrorMessage } from "../../lib/adminApi";
import { useAdminPoll } from "../../lib/useAdminPoll";
import { getAdminPage } from "../../registry";

// ─── 端点形状（后端 packages/commercial/src/admin/literatureConfig.ts 权威）──────
interface LiteratureConfig {
  enabled: boolean;
  base_url: string;
  token_set: boolean;
  token_hint?: string | null;
  daily_cap: number;
  default_size: number;
  timeout_sec: number;
  updated_at?: string;
  updated_by?: string | null;
}

interface TestResult {
  ok: boolean;
  status?: number | null;
  result_count?: number | null;
  elapsed_ms?: number;
  error?: string;
}

type TokenAction = "keep" | "set" | "clear";

// 数值字段以字符串持有：允许「空串」状态，保存时先 trim 再 Number（对齐 vanilla saveLiterature，
// 避免 Number('')===0 绕过前端守门）。范围/整数校验交给 server normalize，避免双源漂移。
interface FormState {
  enabled: boolean;
  baseUrl: string;
  dailyCap: string;
  defaultSize: string;
  timeoutSec: string;
}

function seedForm(c: LiteratureConfig): FormState {
  return {
    enabled: c.enabled,
    baseUrl: c.base_url ?? "",
    dailyCap: String(c.daily_cap ?? 10000),
    defaultSize: String(c.default_size ?? 10),
    timeoutSec: String(c.timeout_sec ?? 20),
  };
}

// 配置页（非监控页）：首载拉一次即可。useAdminPoll 无「纯 once」档，用超大间隔逼近
// 「首载 + 手动重拉」；保存后经返回体就地重播种 + refresh() 刷新掩码/更新时间。
const NO_POLL_MS = 6 * 60 * 60 * 1000;

export default function LiteraturePage() {
  const meta = getAdminPage("literature");
  const toast = useToast();

  const config = useAdminPoll(() => adminGet<{ config: LiteratureConfig }>("/literature"), {
    intervalMs: NO_POLL_MS,
  });
  const c = config.data?.config ?? null;

  const [form, setForm] = useState<FormState | null>(null);
  const [tokenAction, setTokenAction] = useState<TokenAction>("keep");
  const [tokenValue, setTokenValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | { exception: string } | "probing" | null>(
    null,
  );
  const tokenInputRef = useRef<HTMLInputElement>(null);

  // 仅在首次拉到配置时播种表单（prev ?? …）；后续后台重拉不覆盖编辑中的值。
  // 保存后的重播种由 handleSave 用 PATCH 返回体显式完成（server 归一化后的权威值）。
  useEffect(() => {
    if (!c) return;
    setForm((prev) => prev ?? seedForm(c));
  }, [c]);

  const selectTokenAction = (action: TokenAction) => {
    setTokenAction(action);
    if (action === "set") {
      // 选「写入新值」→ 聚焦 password 输入。
      requestAnimationFrame(() => tokenInputRef.current?.focus());
    } else {
      // 切走时清空，避免误传 stale 值（对齐 vanilla token radio 行为）。
      setTokenValue("");
    }
  };

  const handleSave = async () => {
    if (!form) return;

    // token patch：选 set 但为空 → 拦截（客户端只做非空检查，字符集/长度交给 server）。
    let tokenPatch: { action: TokenAction; value?: string };
    if (tokenAction === "set") {
      if (tokenValue === "") {
        toast('已选「写入新值」但 token 为空', "error");
        return;
      }
      tokenPatch = { action: "set", value: tokenValue };
    } else {
      tokenPatch = { action: tokenAction };
    }

    // 数值字段：先 trim 再判空 —— Number('')===0 且 isFinite(0)===true，空串必须先挡掉。
    const capRaw = form.dailyCap.trim();
    const sizeRaw = form.defaultSize.trim();
    const timeoutRaw = form.timeoutSec.trim();
    if (capRaw === "" || sizeRaw === "" || timeoutRaw === "") {
      toast("每日上限 / 缺省条数 / 超时秒数不能为空", "error");
      return;
    }
    const cap = Number(capRaw);
    const size = Number(sizeRaw);
    const timeout = Number(timeoutRaw);
    // 客户端只做 finite 检查；整数 + 范围校验交给 server（越界 → RangeError → message toast）。
    if (!Number.isFinite(cap) || !Number.isFinite(size) || !Number.isFinite(timeout)) {
      toast("数值字段必须是有效数字", "error");
      return;
    }

    setSaving(true);
    try {
      const res = await adminSend<{ config: LiteratureConfig }>("PATCH", "/literature", {
        enabled: form.enabled,
        base_url: form.baseUrl.trim(),
        token: tokenPatch,
        daily_cap: cap,
        default_size: size,
        timeout_sec: timeout,
      });
      // 用返回的归一化配置就地重播种表单 + 复位 token 动作。
      setForm(seedForm(res.config));
      setTokenAction("keep");
      setTokenValue("");
      setTestResult(null);
      toast("文献检索配置已保存", "success");
      // 刷新 poll 数据（更新掩码 token_hint / 最后更新时间），不覆盖已重播种的表单。
      config.refresh();
    } catch (err) {
      toast(apiErrorMessage(err, "保存失败"), "error");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult("probing");
    try {
      const data = await adminSend<{ result: TestResult }>("POST", "/literature/test", {});
      setTestResult(data.result ?? { ok: false, error: "unknown" });
    } catch (err) {
      const msg = apiErrorMessage(err, "请求失败");
      setTestResult({ exception: msg });
      toast(`测试失败：${msg}`, "error");
    } finally {
      setTesting(false);
    }
  };

  const ready = c && form;
  const updatedTs = c?.updated_at ? new Date(c.updated_at).getTime() : 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={meta.title} desc={meta.desc} />

      <SectionCard title="DeepXiv 文献检索" hint="平台级单例配置 · 改完点保存立即生效">
        {!ready && config.error ? (
          <p className="py-8 text-center text-[13px] text-danger">
            加载失败：
            {apiErrorMessage(config.error, "加载失败")}
          </p>
        ) : !ready ? (
          <LoadingSkeleton />
        ) : (
          <div className="flex max-w-2xl flex-col gap-6">
            <p className="text-[12px] leading-relaxed text-muted">
              启用后，容器 LLM 系统 prompt 会注入文献检索技能段，引导其调用检索接口；关闭时检索端点
              直接 503。token 在 DB 端 AEAD 加密，本页永远只显示 <code className="font-mono">****last4</code>{" "}
              掩码，不回显明文。
            </p>

            {/* 启用开关 */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-fg">启用文献检索</div>
                <p className="mt-0.5 text-[12px] text-faint">
                  关闭时检索端点直接 503，容器侧 prompt 不注入文献检索技能段。
                </p>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm({ ...form, enabled: v })}
                aria-label="启用文献检索"
              />
            </div>

            {/* base_url */}
            <Field
              label="base_url"
              htmlFor="lit-base"
              desc="纯 origin（scheme + host + 可选 port），不含 path / query / fragment。proxy 拼路径时自动补全。"
            >
              <Input
                id="lit-base"
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                placeholder="https://data.rag.ac.cn"
                className="max-w-md"
              />
            </Field>

            {/* Token 区 */}
            <div className="flex flex-col gap-2.5">
              <div className="text-[13px] font-medium text-fg">
                Token <span className="font-normal text-faint">（AEAD 加密存储，永不明文回显）</span>
              </div>
              <div className="flex items-center gap-2 text-[13px]">
                <span className="text-faint">当前：</span>
                {c.token_set ? (
                  <span className="inline-flex items-center gap-2">
                    <Badge tone="success">已配置</Badge>
                    <code className="font-mono text-[12px] text-muted">{c.token_hint ?? "****????"}</code>
                  </span>
                ) : (
                  <Badge tone="neutral">未设置</Badge>
                )}
              </div>
              <div className="flex flex-col gap-2 pt-0.5">
                <RadioRow label="保持不变" value="keep" current={tokenAction} onSelect={selectTokenAction} />
                <RadioRow label="写入新值" value="set" current={tokenAction} onSelect={selectTokenAction}>
                  <Input
                    ref={tokenInputRef}
                    type="password"
                    value={tokenValue}
                    disabled={tokenAction !== "set"}
                    onChange={(e) => setTokenValue(e.target.value)}
                    placeholder="新 token（8..256 可见 ASCII）"
                    className="max-w-xs flex-1"
                    aria-label="新 token"
                  />
                </RadioRow>
                <RadioRow
                  label="清空 token（等同关闭检索能力）"
                  value="clear"
                  current={tokenAction}
                  onSelect={selectTokenAction}
                />
              </div>
            </div>

            {/* 数值字段 */}
            <div className="flex flex-wrap gap-6">
              <Field label="每日上限 (daily_cap)" htmlFor="lit-cap" desc="UTC 日上限，1..1000000">
                <Input
                  id="lit-cap"
                  type="number"
                  min={1}
                  max={1000000}
                  step={1}
                  value={form.dailyCap}
                  onChange={(e) => setForm({ ...form, dailyCap: e.target.value })}
                  className="w-40"
                />
              </Field>
              <Field label="缺省条数 (default_size)" htmlFor="lit-size" desc="LLM 缺省条数，1..100">
                <Input
                  id="lit-size"
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={form.defaultSize}
                  onChange={(e) => setForm({ ...form, defaultSize: e.target.value })}
                  className="w-40"
                />
              </Field>
              <Field label="超时秒数 (timeout_sec)" htmlFor="lit-timeout" desc="upstream 超时，3..120">
                <Input
                  id="lit-timeout"
                  type="number"
                  min={3}
                  max={120}
                  step={1}
                  value={form.timeoutSec}
                  onChange={(e) => setForm({ ...form, timeoutSec: e.target.value })}
                  className="w-40"
                />
              </Field>
            </div>

            {/* 操作区 + 测试结果 + 最后更新 */}
            <div className="flex flex-col gap-3 border-t border-border pt-5">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" onClick={handleSave} disabled={saving}>
                  {saving ? <Spinner size={14} /> : <Save size={14} />}
                  保存
                </Button>
                <Button variant="secondary" onClick={handleTest} disabled={testing}>
                  {testing ? <Spinner size={14} /> : <FlaskConical size={14} />}
                  测试连接
                </Button>
              </div>

              <div className="min-h-[20px]">
                <TestResultSummary result={testResult} />
              </div>

              <div className="text-[12px] text-faint">
                最后更新：
                {updatedTs > 0 && c.updated_at ? <TimeAgo value={c.updated_at} /> : <span>—</span>}
                {c.updated_by ? (
                  <>
                    {" "}
                    by <span className="font-mono">{c.updated_by}</span>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ─── 局部组件 ───────────────────────────────────────────────────────────────

function Field({
  label,
  desc,
  htmlFor,
  children,
}: {
  label: string;
  desc?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-fg">
        {label}
      </label>
      {children}
      {desc && <p className="text-[12px] text-faint">{desc}</p>}
    </div>
  );
}

function RadioRow({
  label,
  value,
  current,
  onSelect,
  children,
}: {
  label: string;
  value: TokenAction;
  current: TokenAction;
  onSelect: (a: TokenAction) => void;
  children?: ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-[13px] text-fg">
      <input
        type="radio"
        name="lit-token-action"
        value={value}
        checked={current === value}
        onChange={() => onSelect(value)}
        className="size-4 shrink-0 accent-accent"
      />
      <span className="shrink-0">{label}</span>
      {children}
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <span className="text-muted">
      {label}=<code className="font-mono text-fg">{value}</code>
    </span>
  );
}

function TestResultSummary({
  result,
}: {
  result: TestResult | { exception: string } | "probing" | null;
}) {
  if (result === null) return null;
  if (result === "probing") return <p className="text-[13px] text-faint">探测中…</p>;

  if ("exception" in result) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <Badge tone="danger">异常</Badge>
        <span className="break-all text-muted">{result.exception}</span>
      </div>
    );
  }

  if (result.ok) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <Badge tone="success">连接正常</Badge>
        <Metric label="status" value={result.status} />
        <Metric label="result_count" value={result.result_count} />
        <Metric
          label="elapsed"
          value={result.elapsed_ms != null ? `${result.elapsed_ms}ms` : undefined}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
      <Badge tone="neutral">失败</Badge>
      <Metric label="error" value={result.error ?? "unknown"} />
      {result.status != null && <Metric label="status" value={result.status} />}
      <Metric
        label="elapsed"
        value={result.elapsed_ms != null ? `${result.elapsed_ms}ms` : undefined}
      />
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-10 w-full max-w-md" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-10 w-64" />
    </div>
  );
}
