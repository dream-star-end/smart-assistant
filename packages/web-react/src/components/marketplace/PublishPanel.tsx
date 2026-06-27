import { CheckCircle2, Loader2, Upload } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import type { AuthSession, MarketplaceRiskFlag, SkillSummary } from "../../lib/types";
import { Alert, Button, Input, Textarea } from "../ui";
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

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * 发布：从「我的技能」一键导入或手填,提交进入平台审核队列(pending)。
 * 被静态扫描拦截时把命中翻译成可操作的中文修正提示。
 */
export function PublishPanel({ auth }: { auth: AuthSession }) {
  const [mySkills, setMySkills] = useState<SkillSummary[]>([]);
  const [slug, setSlug] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [body, setBody] = useState("");

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
    setSlug(toSlug(sk.name));
    setDescription(sk.description ?? "");
    setTags((sk.tags ?? []).join(", "));
    try {
      const d = await api.getSkill(auth, sk.name);
      setBody(d.body ?? "");
    } catch {
      /* 用户可手填正文 */
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
    setOk(false);
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
      });
      setOk(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        const rf = (e.body as { riskFlags?: MarketplaceRiskFlag[] })?.riskFlags ?? [];
        setFlags(rf);
        setErr("发布被安全扫描拦截，请按下面的提示修正后重试。");
      } else {
        setErr(e instanceof ApiError ? e.message : (e as Error).message || "发布失败");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const friendly = friendlyRiskFlags(flags);

  if (ok) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <CheckCircle2 size={32} className="text-success" />
        <p className="text-[14px] font-medium text-fg">已提交，等待平台审核</p>
        <p className="max-w-sm text-[12.5px] text-muted">
          审核通过后将上架并对其他用户可见。你可以继续发布其它技能。
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setOk(false);
            setSlug("");
            setName("");
            setDescription("");
            setTags("");
            setBody("");
            setVersion("1.0.0");
          }}
        >
          再发布一个
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
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
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例：学术翻译" />
        </Field>
        <Field label="标识 slug">
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
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
