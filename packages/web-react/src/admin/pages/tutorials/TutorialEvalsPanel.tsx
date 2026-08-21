import { Compass, ListTodo, Plus } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Field, Input, Textarea } from "../../../components/ui";
import { api, apiErrorMessage } from "../../../lib/api";
import type {
  TutorialEvalCompassItem,
  TutorialEvalJob,
  TutorialEvalSpec,
} from "../../../lib/types";
import {
  DEFAULT_TUTORIAL_EVAL_MATERIALS_JSON,
  DEFAULT_TUTORIAL_EVAL_RUBRIC_JSON,
  parseTutorialEvalMaterialsJson,
  parseTutorialEvalRubricJson,
} from "../../../lib/tutorialStudio";
import { adminSession } from "../../auth";

const JOB_STATUS: Record<string, { label: string; tone: "neutral" | "warning" | "info" | "success" | "danger" }> = {
  queued: { label: "已排队", tone: "warning" },
  running: { label: "执行中", tone: "info" },
  failed: { label: "失败", tone: "danger" },
  passed: { label: "评测通过", tone: "success" },
  compass_pending: { label: "罗盘待生成", tone: "warning" },
  compass_running: { label: "Grok 分析中", tone: "info" },
  compass_ready: { label: "罗盘已就绪", tone: "info" },
  completed: { label: "已完成", tone: "success" },
};

export function TutorialEvalsPanel() {
  const [specs, setSpecs] = useState<TutorialEvalSpec[]>([]);
  const [jobs, setJobs] = useState<TutorialEvalJob[]>([]);
  const [compass, setCompass] = useState<TutorialEvalCompassItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [publicId, setPublicId] = useState("");
  const [title, setTitle] = useState("");
  const [sourcePlatform, setSourcePlatform] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [collectedAt, setCollectedAt] = useState("");
  const [frozenPrompt, setFrozenPrompt] = useState("");
  const [materialsJson, setMaterialsJson] = useState(DEFAULT_TUTORIAL_EVAL_MATERIALS_JSON);
  const [rubricJson, setRubricJson] = useState(DEFAULT_TUTORIAL_EVAL_RUBRIC_JSON);
  const [evalUserId, setEvalUserId] = useState('247');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [specPage, jobPage, compassPage] = await Promise.all([
        api.listTutorialEvalSpecs(adminSession),
        api.listTutorialEvalJobs(adminSession),
        api.listTutorialEvalCompass(adminSession),
      ]);
      setSpecs(specPage.specs);
      setJobs(jobPage.jobs);
      setCompass(compassPage.items);
    } catch (cause) {
      setError(apiErrorMessage(cause, "加载案例评测数据失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createSpec = async (event: FormEvent) => {
    event.preventDefault();
    let frozenMaterials: { items: unknown[] };
    let rubric: { checks: Array<Record<string, unknown>> };
    try {
      frozenMaterials = parseTutorialEvalMaterialsJson(materialsJson);
      rubric = parseTutorialEvalRubricJson(rubricJson);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "评测 JSON 校验失败");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createTutorialEvalSpec(adminSession, {
        publicId: publicId.trim(),
        title: title.trim(),
        sourcePlatform: sourcePlatform.trim(),
        sourceUrl: sourceUrl.trim(),
        collectedAt: collectedAt.trim(),
        frozenPrompt,
        frozenMaterials,
        rubric,
      });
      setPublicId("");
      setTitle("");
      setSourcePlatform("");
      setSourceUrl("");
      setCollectedAt("");
      setFrozenPrompt("");
      setMaterialsJson(DEFAULT_TUTORIAL_EVAL_MATERIALS_JSON);
      setRubricJson(DEFAULT_TUTORIAL_EVAL_RUBRIC_JSON);
      await refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, "登记评测案例失败"));
    } finally {
      setBusy(false);
    }
  };

  const enqueue = async (specId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.enqueueTutorialEvalJob(adminSession, specId, { evalUserId: evalUserId.trim() });
      await refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, "排队评测失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-title font-semibold text-fg">
            <Compass size={18} /> 案例评测 / 改进罗盘
          </h2>
          <p className="mt-1 text-meta text-muted">
            仅管理员可见。这里登记外部案例并排队评测；没有完成记录时不会声称自动评测已完成。
          </p>
        </div>
        <Button variant="secondary" size="sm" loading={loading} onClick={() => void refresh()}>
          刷新
        </Button>
      </div>
      {error && (
        <Alert tone="danger" className="mt-4">
          {error}
        </Alert>
      )}

      <form onSubmit={(event) => void createSpec(event)} className="mt-5 grid gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="公开 ID" required>
            <Input value={publicId} onChange={(event) => setPublicId(event.target.value)} placeholder="ext-case-01" />
          </Field>
          <Field label="标题" required>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="外部案例标题" />
          </Field>
          <Field label="来源平台" required>
            <Input
              value={sourcePlatform}
              onChange={(event) => setSourcePlatform(event.target.value)}
              placeholder="例如 Claude / Cursor / 公开博客"
            />
          </Field>
          <Field label="来源 URL" required>
            <Input
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder="https://"
            />
          </Field>
          <Field label="采集时间" required>
            <Input
              value={collectedAt}
              onChange={(event) => setCollectedAt(event.target.value)}
              placeholder="2026-08-20T12:00:00Z"
            />
          </Field>
        </div>
        <Field label="冻结 prompt" required>
          <Textarea
            rows={4}
            className="font-mono"
            value={frozenPrompt}
            onChange={(event) => setFrozenPrompt(event.target.value)}
          />
        </Field>
        <Field label="冻结材料 JSON" hint='必须是 { "items": [] } 对象，提交前会校验' required>
          <Textarea
            rows={6}
            className="font-mono"
            value={materialsJson}
            onChange={(event) => setMaterialsJson(event.target.value)}
          />
        </Field>
        <Field
          label="Rubric JSON"
          hint="checks 必须非空，每项含 id / method / passCriterion"
          required
        >
          <Textarea
            rows={8}
            className="font-mono"
            value={rubricJson}
            onChange={(event) => setRubricJson(event.target.value)}
          />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={busy}>
            <Plus size={14} /> 登记案例
          </Button>
        </div>
      </form>

      <div className="mt-5 max-w-xs">
        <Field label="隔离测试账号 UID" hint="只允许 synthetic_canary / e2e 账号" required>
          <Input
            value={evalUserId}
            inputMode="numeric"
            onChange={(event) => setEvalUserId(event.target.value)}
          />
        </Field>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="flex items-center gap-2 text-section font-semibold text-fg">
            <ListTodo size={16} /> 已登记案例
          </h3>
          {specs.length === 0 && !loading ? (
            <p className="mt-3 text-meta text-faint">还没有登记外部案例。</p>
          ) : (
            <ul className="mt-3 grid gap-3">
              {specs.map((spec) => (
                <li key={spec.id} className="rounded-xl border border-border p-4">
                  <p className="text-body font-semibold text-fg">{spec.title || spec.sourcePlatform}</p>
                  <p className="mt-1 text-caption text-muted">{spec.sourcePlatform}</p>
                  <p className="mt-1 break-all text-caption text-faint">{spec.sourceUrl}</p>
                  <p className="mt-1 text-caption text-muted">采集 {spec.collectedAt}</p>
                  <p className="mt-2 text-meta text-muted">授权：{spec.authScope}</p>
                  <Button
                    className="mt-3"
                    size="sm"
                    variant="secondary"
                    loading={busy}
                    onClick={() => void enqueue(spec.id)}
                  >
                    排队评测
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="text-section font-semibold text-fg">评测任务</h3>
          {jobs.length === 0 && !loading ? (
            <p className="mt-3 text-meta text-faint">尚未排队评测，不会显示已完成结果。</p>
          ) : (
            <ul className="mt-3 grid gap-3">
              {jobs.map((job) => {
                const meta = JOB_STATUS[job.status] ?? { label: job.status, tone: "neutral" as const };
                return (
                  <li key={job.id} className="rounded-xl border border-border p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-meta text-muted">{job.specId}</span>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </div>
                    {job.error && <p className="mt-2 text-meta text-danger">{job.error}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="mt-8">
        <h3 className="text-section font-semibold text-fg">改进罗盘</h3>
        {compass.length === 0 && !loading ? (
          <p className="mt-3 text-meta text-faint">还没有罗盘聚类。完成评测并 record 后才会出现。</p>
        ) : (
          <ul className="mt-3 grid gap-3">
            {compass.map((item) => (
              <li key={item.id} className="rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="accent">{item.clusterKey || item.cluster}</Badge>
                  <Badge tone="warning">{item.severity}</Badge>
                </div>
                <p className="mt-2 text-body text-fg">{item.summary}</p>
                <p className="mt-1 text-meta text-muted">修复方向：{item.reusableFix || item.fix || "未记录"}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
