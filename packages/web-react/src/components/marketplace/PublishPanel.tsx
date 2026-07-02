import { CheckCircle2, ChevronRight, Loader2, Upload } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { suggestSlug } from "../../lib/marketplace";
import type {
  AuthSession,
  MarketplaceMyPublish,
  MarketplaceRiskFlag,
  PublicModel,
  SkillSummary,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import { Alert, Badge, Button, Input, Textarea } from "../ui";
import { friendlyRiskFlags } from "./riskFlags";

/** 标签+控件包裹（input 嵌于 label 内即关联，参照 CronPanel.Field 模式）。 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** 能力工具集(与后端 VETTED_AGENT_TOOLSETS/详情页 TOOLSET_LABEL 对齐)。core 恒选。 */
const TOOLSET_OPTIONS: { value: string; label: string; hint: string; locked?: boolean }[] = [
  { value: "core", label: "核心", hint: "文件/终端/基础工具(必选)", locked: true },
  { value: "browser", label: "浏览器", hint: "操作真实浏览器" },
  { value: "research", label: "研究检索", hint: "文献检索与引用" },
  { value: "web_context", label: "网页提取", hint: "抓取网页/文档" },
];

/** 发布成功后的通用完成态。 */
function DoneScreen({ onAgain }: { onAgain: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <CheckCircle2 size={32} className="text-success" />
      <p className="text-[14px] font-medium text-fg">已提交，等待平台审核</p>
      <p className="max-w-sm text-[12.5px] text-muted">
        审核通过后将上架并对其他用户可见。审核进度可随时回到本页「我的发布」查看。
      </p>
      <Button variant="secondary" size="sm" onClick={onAgain}>
        继续发布
      </Button>
    </div>
  );
}

/**
 * 发布：技能(从「我的技能」导入或手填)/ 智能体(模型+能力+人设+依赖技能)双表单,
 * 提交进入平台审核队列(pending)。顶部「我的发布」闭合反馈环。被静态扫描/manifest
 * 校验拦截时把命中翻译成可操作的中文修正提示。
 */
export function PublishPanel({ auth }: { auth: AuthSession }) {
  const [kind, setKind] = useState<"skill" | "agent">("skill");
  const [publishReload, setPublishReload] = useState(0);
  const bump = () => setPublishReload((n) => n + 1);

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <MyPublishes auth={auth} reload={publishReload} />

      <div className="flex gap-1">
        {(["skill", "agent"] as const).map((k) => (
          <button
            type="button"
            key={k}
            onClick={() => setKind(k)}
            className={cn(
              "rounded-full px-3 py-1 text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              kind === k ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg",
            )}
          >
            {k === "skill" ? "发布技能" : "发布智能体"}
          </button>
        ))}
      </div>

      {kind === "skill" ? (
        <SkillPublishForm auth={auth} onPublished={bump} />
      ) : (
        <AgentPublishForm auth={auth} onPublished={bump} />
      )}
    </div>
  );
}

// ── 技能发布 ────────────────────────────────────────────────────────────────

function SkillPublishForm({ auth, onPublished }: { auth: AuthSession; onPublished: () => void }) {
  const [mySkills, setMySkills] = useState<SkillSummary[]>([]);
  const [slug, setSlug] = useState("");
  // 用户手动改过 slug 后停止跟随名称联动。
  const [slugTouched, setSlugTouched] = useState(false);
  const [version, setVersion] = useState("1.0.0");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [body, setBody] = useState("");
  // 附属文件(references/assets/evals;scripts 暂不支持)。导入技能时自动带上其
  // 评测用例与上次实测结果(可删),让「实测有效」成为市场卖点而不是口说无凭。
  const [files, setFiles] = useState<Array<{ path: string; content: string }>>([]);
  const [benchmark, setBenchmark] = useState<{ withPassRate: number; withoutPassRate: number; cases: number } | null>(null);
  const [bundleErrors, setBundleErrors] = useState<string[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [flags, setFlags] = useState<MarketplaceRiskFlag[]>([]);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .listSkills(auth)
      .then((s) => alive && setMySkills(s.filter((x) => x.writable !== false)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [auth]);

  const importSkill = async (sk: SkillSummary) => {
    setErr(null);
    setName(sk.name);
    setSlug(suggestSlug(sk.name));
    setSlugTouched(false);
    setDescription(sk.description ?? "");
    setTags((sk.tags ?? []).join(", "));
    setFiles([]);
    setBenchmark(null);
    try {
      const d = await api.getSkill(auth, sk.name);
      setBody(d.body ?? "");
    } catch {
      /* 用户可手填正文 */
    }
    // 自动附带评测用例 + 上次 baseline 实测(发布者自报,详情页会标注来源;可手动删)。
    try {
      const ev = await api.getSkillEvals(auth, sk.name);
      if (ev.evals?.cases?.length) {
        const { autoRegression: _drop, ...pub } = ev.evals;
        setFiles([{ path: "evals/evals.json", content: `${JSON.stringify(pub, null, 2)}\n` }]);
      }
      const b = ev.lastRun?.benchmark;
      if (b && b.passRate?.with !== undefined && b.passRate?.without !== undefined) {
        setBenchmark({
          withPassRate: b.passRate.with,
          withoutPassRate: b.passRate.without,
          cases: Math.max(1, Math.min(5, ev.evals?.cases?.length ?? 1)),
        });
      }
    } catch {
      /* 无评测数据就不带 */
    }
  };

  const validate = (): string | null => {
    if (!SLUG_RE.test(slug)) return "标识(slug)须为小写字母/数字/连字符，2–64 位";
    if (!VERSION_RE.test(version)) return "版本号须为 N.N.N，例如 1.0.0";
    if (!name.trim()) return "请填写显示名称";
    if (!description.trim()) return "请填写一句话描述";
    if (!body.trim()) return "请填写技能正文";
    return null;
  };

  const submit = async () => {
    const v = validate();
    if (v) {
      setErr(v);
      return;
    }
    setSubmitting(true);
    setErr(null);
    setFlags([]);
    try {
      await api.publishMarketplace(auth, {
        slug,
        version,
        name: name.trim(),
        description: description.trim(),
        body,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        ...(files.length > 0 ? { files } : {}),
        ...(benchmark ? { benchmark } : {}),
      });
      setOk(true);
      onPublished();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        const eb = e.body as { riskFlags?: MarketplaceRiskFlag[]; errors?: string[] };
        if (eb?.errors?.length) {
          setBundleErrors(eb.errors);
          setErr("附属文件不合法,请按下面的提示修正。");
        } else {
          setFlags(eb?.riskFlags ?? []);
          setErr("发布被安全扫描拦截，请按下面的提示修正后重试。");
        }
      } else {
        setErr(e instanceof ApiError ? e.message : (e as Error).message || "发布失败");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const friendly = friendlyRiskFlags(flags);

  if (ok)
    return (
      <DoneScreen
        onAgain={() => {
          setOk(false);
          setSlug("");
          setSlugTouched(false);
          setName("");
          setDescription("");
          setTags("");
          setBody("");
          setVersion("1.0.0");
        }}
      />
    );

  return (
    <div className="flex flex-col gap-4">
      {mySkills.length > 0 && (
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-muted">从我的技能导入</div>
          <div className="flex flex-wrap gap-1.5">
            {mySkills.map((sk) => (
              <button
                key={sk.name}
                type="button"
                onClick={() => importSkill(sk)}
                className="rounded-full border border-border px-2.5 py-1 text-[12px] text-muted outline-none transition-colors hover:border-accent/40 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
              >
                {sk.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {err && <Alert tone="danger">{err}</Alert>}

      {friendly.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {friendly.map((f) => (
            <Alert key={f.label} tone={f.tone}>
              <span className="font-medium">{f.label}：</span>
              {f.message}
              {f.hint && <span className="mt-0.5 block text-muted">{f.hint}</span>}
              {f.sample && (
                <code className="mt-1 block break-all rounded bg-code px-1.5 py-0.5 text-[11px]">
                  {f.sample}
                </code>
              )}
            </Alert>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="显示名称">
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(suggestSlug(e.target.value));
            }}
            placeholder="例：学术翻译"
          />
        </Field>
        <Field label="标识 slug">
          <Input
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
            placeholder="academic-translate"
          />
        </Field>
        <Field label="版本号">
          <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" />
        </Field>
        <Field label="标签（逗号分隔）">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="翻译, 学术" />
        </Field>
      </div>

      <Field label="一句话描述">
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="把中文学术论文翻译成地道英文，保留术语。"
        />
      </Field>

      <Field label="技能正文（SKILL.md 内容）">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          placeholder="描述这个技能何时触发、如何执行……"
          className="font-mono text-[12.5px]"
        />
      </Field>

      {bundleErrors.length > 0 && (
        <Alert tone="danger" title="附属文件校验未通过">
          <ul className="list-disc pl-4">
            {bundleErrors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </Alert>
      )}

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[12px] font-medium text-muted">
            附属文件（references/ assets/ evals/ scripts/,可选;脚本会被危险模式扫描并逐行人审）
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={files.length >= 20}
            onClick={() => setFiles((fs) => [...fs, { path: "references/", content: "" }])}
          >
            添加文件
          </Button>
        </div>
        {files.length > 0 && (
          <ul className="flex flex-col gap-2">
            {files.map((f, i) => (
              <li key={i} className="rounded-lg border border-border p-2">
                <div className="mb-1 flex items-center gap-2">
                  <Input
                    value={f.path}
                    onChange={(e) => {
                      const v = e.target.value;
                      setFiles((fs) => fs.map((x, j) => (j === i ? { ...x, path: v } : x)));
                    }}
                    placeholder="references/guide.md"
                    className="h-8 font-mono text-[12px]"
                  />
                  <Button variant="ghost" size="sm" onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>
                    删除
                  </Button>
                </div>
                <Textarea
                  value={f.content}
                  onChange={(e) => {
                    const v = e.target.value;
                    setFiles((fs) => fs.map((x, j) => (j === i ? { ...x, content: v } : x)));
                  }}
                  rows={4}
                  placeholder="文件内容…"
                  className="font-mono text-[12px]"
                />
              </li>
            ))}
          </ul>
        )}
        {benchmark && (
          <div className="mt-2 flex items-center gap-2 text-[12px] text-muted">
            <Badge tone="info">
              实测:通过率 {Math.round(benchmark.withoutPassRate * 100)}% → {Math.round(benchmark.withPassRate * 100)}%（{benchmark.cases} 用例,发布者自报）
            </Badge>
            <button type="button" className="text-faint hover:text-fg" onClick={() => setBenchmark(null)}>
              移除
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-[11.5px] text-faint">提交后进入平台审核，通过后才会上架。</p>
        <Button variant="primary" onClick={submit} disabled={submitting}>
          {submitting ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
          发布到市场
        </Button>
      </div>
    </div>
  );
}

// ── 智能体发布 ──────────────────────────────────────────────────────────────

function AgentPublishForm({ auth, onPublished }: { auth: AuthSession; onPublished: () => void }) {
  const [models, setModels] = useState<PublicModel[]>([]);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [version, setVersion] = useState("1.0.0");
  const [tags, setTags] = useState("");
  const [description, setDescription] = useState("");
  const [avatarEmoji, setAvatarEmoji] = useState("🤖");
  const [model, setModel] = useState("");
  const [toolsets, setToolsets] = useState<string[]>(["core"]);
  // 依赖技能 = 多选「我已安装的市场技能」(后端硬校验 skillDeps 必须是已上架技能;
  // 已安装集合必然满足,且是用户真实用过、知道好坏的技能)。
  const [installedSkills, setInstalledSkills] = useState<Array<{ slug: string; name: string }>>([]);
  const [skillDeps, setSkillDeps] = useState<string[]>([]);
  const [persona, setPersona] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [manifestErrors, setManifestErrors] = useState<string[]>([]);
  const [flags, setFlags] = useState<MarketplaceRiskFlag[]>([]);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getPublicModels(auth)
      .then((ms) => {
        if (!alive) return;
        setModels(ms);
        setModel((cur) => cur || ms[0]?.id || "");
      })
      .catch(() => {});
    api
      .listMarketplaceInstalled(auth)
      .then((rows) => {
        if (!alive) return;
        setInstalledSkills(
          rows
            .filter((r) => r.kind === "skill" && r.listingState === "active")
            .map((r) => ({ slug: r.slug, name: r.name })),
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [auth]);

  const toggleToolset = (v: string) =>
    setToolsets((ts) => (ts.includes(v) ? ts.filter((x) => x !== v) : [...ts, v]));

  const validate = (): string | null => {
    if (!name.trim()) return "请填写智能体名称";
    if (!SLUG_RE.test(slug)) return "标识(slug)须为小写字母/数字/连字符，2–64 位";
    if (!VERSION_RE.test(version)) return "版本号须为 N.N.N，例如 1.0.0";
    if (!description.trim()) return "请填写一句话描述";
    if (!model) return "请选择模型";
    if (toolsets.length === 0) return "请至少选择一个能力工具集";
    if (!persona.trim()) return "请填写人设(它决定智能体的行为方式)";
    return null;
  };

  const submit = async () => {
    const v = validate();
    if (v) {
      setErr(v);
      return;
    }
    setSubmitting(true);
    setErr(null);
    setManifestErrors([]);
    setFlags([]);
    try {
      await api.publishMarketplaceAgent(auth, {
        slug,
        version,
        name: name.trim(),
        description: description.trim(),
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        model,
        toolsets,
        skillDeps,
        persona,
        ...(avatarEmoji.trim() ? { avatarEmoji: avatarEmoji.trim() } : {}),
      });
      setOk(true);
      onPublished();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        const b = e.body as { errors?: string[]; riskFlags?: MarketplaceRiskFlag[] };
        if (b?.errors?.length) {
          setManifestErrors(b.errors);
          setErr("智能体配置不合法，请按下面的提示修正。");
        } else if (b?.riskFlags?.length) {
          setFlags(b.riskFlags);
          setErr("人设被安全扫描拦截，请修正后重试。");
        } else {
          setErr(e.message);
        }
      } else {
        setErr(e instanceof ApiError ? e.message : (e as Error).message || "发布失败");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const friendly = friendlyRiskFlags(flags);

  if (ok)
    return (
      <DoneScreen
        onAgain={() => {
          setOk(false);
          setName("");
          setSlug("");
          setSlugTouched(false);
          setVersion("1.0.0");
          setTags("");
          setDescription("");
          setPersona("");
          setSkillDeps([]);
        }}
      />
    );

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info">
        智能体 = 模型 + 能力工具集 + 人设(+ 可选依赖技能)。发布后经平台审核上架，其他用户
        安装即可在智能体选择器中使用。
      </Alert>

      {err && <Alert tone="danger">{err}</Alert>}
      {manifestErrors.length > 0 && (
        <Alert tone="danger" title="配置校验未通过">
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
            <Alert key={f.label} tone={f.tone}>
              <span className="font-medium">{f.label}：</span>
              {f.message}
              {f.hint && <span className="mt-0.5 block text-muted">{f.hint}</span>}
            </Alert>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="名称">
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(suggestSlug(e.target.value));
            }}
            placeholder="例：法律顾问"
          />
        </Field>
        <Field label="标识 slug">
          <Input
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
            placeholder="legal-advisor"
          />
        </Field>
        <Field label="版本号">
          <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" />
        </Field>
        <Field label="头像 Emoji">
          <Input
            value={avatarEmoji}
            onChange={(e) => setAvatarEmoji(e.target.value)}
            placeholder="🤖"
          />
        </Field>
        <Field label="模型">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-ring"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {typeof m.displayName === "string" && m.displayName ? m.displayName : m.id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="标签（逗号分隔）">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="法律, 咨询" />
        </Field>
      </div>

      <Field label="一句话描述">
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="面向合同审阅与合规问答的法律顾问。"
        />
      </Field>

      <div>
        <div className="mb-1.5 text-[12px] font-medium text-muted">能力（工具集）</div>
        <div className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap">
          {TOOLSET_OPTIONS.map((t) => {
            const checked = toolsets.includes(t.value);
            return (
              <label
                key={t.value}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px] transition-colors",
                  checked ? "border-accent/50 bg-accent-soft text-fg" : "border-border text-muted",
                  t.locked && "cursor-not-allowed opacity-90",
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={t.locked}
                  onChange={() => toggleToolset(t.value)}
                  className="accent-[var(--accent,#6d5efc)]"
                />
                <span className="font-medium">{t.label}</span>
                <span className="text-[11px] text-faint">{t.hint}</span>
              </label>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[12px] font-medium text-muted">
          依赖技能（从你已安装的市场技能中多选，安装该智能体时会一并安装）
        </div>
        {installedSkills.length === 0 ? (
          <p className="text-[12px] text-faint">
            你还没有安装任何市场技能 —— 先在「发现」里安装,或不选(智能体也可以不带依赖技能)。
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {installedSkills.map((sk) => {
              const checked = skillDeps.includes(sk.slug);
              return (
                <button
                  type="button"
                  key={sk.slug}
                  onClick={() =>
                    setSkillDeps((ds) =>
                      checked ? ds.filter((d) => d !== sk.slug) : [...ds, sk.slug],
                    )
                  }
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    checked
                      ? "border-accent/50 bg-accent-soft text-accent"
                      : "border-border text-muted hover:border-accent/40 hover:text-fg",
                  )}
                >
                  {checked ? "✓ " : ""}
                  {sk.name}
                  <span className="ml-1 font-mono text-[10.5px] text-faint">{sk.slug}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <Field label="人设（persona，决定智能体的行为方式与工作流）">
        <Textarea
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          rows={10}
          placeholder={"你是……\n\n工作方式:\n1. ……\n2. ……\n\n纪律:\n- ……"}
          className="font-mono text-[12.5px]"
        />
      </Field>

      <div className="flex items-center justify-between">
        <p className="text-[11.5px] text-faint">提交后进入平台审核，通过后才会上架。</p>
        <Button variant="primary" onClick={submit} disabled={submitting}>
          {submitting ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
          发布到市场
        </Button>
      </div>
    </div>
  );
}

// ── 我的发布 ────────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; tone: "warning" | "success" | "danger" }> = {
  pending: { label: "审核中", tone: "warning" },
  approved: { label: "已上架", tone: "success" },
  rejected: { label: "未通过", tone: "danger" },
};

/**
 * 我的发布记录（最近 50 条）。默认折叠成一行摘要,点开看每次提交的状态与
 * 审核理由(rejected 的 review_note 按纯文本渲染)。无记录时整段隐藏。
 */
function MyPublishes({ auth, reload }: { auth: AuthSession; reload: number }) {
  const [rows, setRows] = useState<MarketplaceMyPublish[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .listMarketplaceMyPublishes(auth)
      .then((r) => alive && setRows(r))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [auth, reload]);

  if (!rows || rows.length === 0) return null;
  const pending = rows.filter((r) => r.status === "pending").length;
  const rejected = rows.filter((r) => r.status === "rejected").length;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-elevated">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          size={15}
          className={cn("shrink-0 text-faint transition-transform", open && "rotate-90")}
        />
        <span className="text-[13px] font-medium text-fg">我的发布（{rows.length}）</span>
        <span className="flex items-center gap-1.5 text-[11.5px] text-faint">
          {pending > 0 && <Badge tone="warning">{pending} 审核中</Badge>}
          {rejected > 0 && <Badge tone="danger">{rejected} 未通过</Badge>}
        </span>
      </button>
      {open && (
        <ul className="flex flex-col border-t border-border">
          {rows.map((r) => {
            const meta = STATUS_META[r.status] ?? { label: r.status, tone: "warning" as const };
            const revoked = r.status === "approved" && r.listingState === "revoked";
            return (
              <li key={r.versionId} className="border-b border-border px-3.5 py-2.5 last:border-b-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px] font-medium text-fg">{r.name}</span>
                  <Badge tone="neutral">v{r.version}</Badge>
                  {r.kind === "agent" && <Badge tone="accent">智能体</Badge>}
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  {revoked && <Badge tone="warning">已被下架</Badge>}
                  {r.status === "approved" && !r.isCurrent && !revoked && (
                    <Badge tone="neutral">已被新版本取代</Badge>
                  )}
                  <span className="ml-auto text-[11px] text-faint">{fmtDate(r.createdAt)}</span>
                </div>
                {r.status === "rejected" && r.reviewNote && (
                  <p className="mt-1 text-[12px] leading-relaxed text-muted">
                    <span className="text-danger">拒绝理由：</span>
                    {r.reviewNote}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function fmtDate(t: string): string {
  try {
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return t;
    return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  } catch {
    return t;
  }
}
