import type { IdentityCompatProjection } from "@openclaude/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { AuthEpochStaleError, apiErrorMessage } from "../../lib/api";
import { identityCompatApi, type PersonaDocument } from "../../lib/identityCompat";
import type { AuthSession } from "../../lib/types";
import { Alert, Button, Textarea, useToast } from "../ui";

type Registration = IdentityCompatProjection["profiles"][number];

/** Shared by this management-only resource selector and the editor: one API snapshot. */
export function useIdentityManualAuthority(auth: AuthSession) {
  const [projection, setProjection] = useState<IdentityCompatProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const epoch = auth.snapshot().epoch;
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setProjection(null); setError("");
    void identityCompatApi.getProjection(auth).then((value) => {
      if (!cancelled) setProjection(value);
    }).catch((e) => {
      if (!cancelled && !(e instanceof AuthEpochStaleError)) setError(apiErrorMessage(e, "无法读取本实例手册的注册信息"));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [auth, epoch, retry]);
  return { projection, loading, error, retry: () => setRetry(n => n + 1) };
}

/** One execution identity, with its explicitly registered local edit resource. */
export function IdentityManual({ auth, agentId, authority }: {
  auth: AuthSession; agentId: string; authority: ReturnType<typeof useIdentityManualAuthority>;
}) {
  const [open, setOpen] = useState(false);
  const sectionId = useId();
  const { projection, loading, error, retry } = authority;
  const registration = projection?.profiles.find(({ profile }) => profile.canonicalAgentId === agentId);
  if (loading) return <span className="sr-only" data-testid="identity-manual-loading">读取手册入口</span>;
  if (error) return <div className="px-4 py-3"><Alert tone="warning" action={<Button size="sm" onClick={retry}>重试手册入口</Button>}>{error}</Alert></div>;
  if (!registration) return null;
  return <section className="border-t border-border px-4 py-3" aria-label="本实例运行手册管理">
    <Button variant="link" size="sm" className="px-0" aria-expanded={open} aria-controls={sectionId} onClick={() => setOpen(v => !v)}>本实例运行手册</Button>
    <p className="text-caption text-muted">市场底线只读；本地手册是此智能体的补充规则，不是另一个可执行智能体。</p>
    {registration.readiness === "unavailable" && <Alert tone="warning" className="mt-2">智能体当前不可执行；仍可编辑本实例手册，保存不会恢复执行权限。</Alert>}
    {open && <div id={sectionId}><ManualEditor auth={auth} registration={registration} /></div>}
  </section>;
}

function ManualEditor({ auth, registration }: { auth: AuthSession; registration: Registration }) {
  const { profile } = registration;
  const toast = useToast();
  const [local, setLocal] = useState<PersonaDocument | null>(null);
  const [market, setMarket] = useState<PersonaDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [marketError, setMarketError] = useState("");
  const [retry, setRetry] = useState(0);
  const mounted = useRef(false);
  // A form cannot be saved under a new identity even if its AuthSession object is reused.
  const formEpoch = useRef(auth.snapshot().epoch);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    setLoading(true); setLocal(null); setMarket(null); setDraft(""); setError(""); setMarketError("");
    void Promise.all([
      identityCompatApi.getPersona(auth, profile.legacyAgentId).then(doc => {
        if (!cancelled) { setLocal(doc); setDraft(doc.text); }
      }).catch(e => { if (!cancelled && !(e instanceof AuthEpochStaleError)) setError(apiErrorMessage(e, "加载本地手册失败，请重试")); }),
      identityCompatApi.getPersona(auth, profile.canonicalAgentId).then(doc => { if (!cancelled) setMarket(doc); })
        .catch(e => { if (!cancelled && !(e instanceof AuthEpochStaleError)) setMarketError(apiErrorMessage(e, "市场底线暂不可读；不会改写市场人格")); }),
    ]).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; mounted.current = false; };
  }, [auth, profile.legacyAgentId, profile.canonicalAgentId, retry]);
  async function save() {
    if (!local || saving || loading) return;
    if (auth.snapshot().epoch !== formEpoch.current) { setLocal(null); return; }
    const submitted = draft;
    setSaving(true); setError("");
    try {
      await identityCompatApi.savePersona(auth, profile.legacyAgentId, submitted);
      if (!mounted.current || auth.snapshot().epoch !== formEpoch.current) return;
      const verified = await identityCompatApi.getPersona(auth, profile.legacyAgentId);
      if (!mounted.current || auth.snapshot().epoch !== formEpoch.current) return;
      if (verified.text !== submitted) throw new Error("saved text did not match readback");
      setLocal(verified); setDraft(verified.text);
      toast("本地手册已保存并核对", "success");
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof AuthEpochStaleError || auth.snapshot().epoch !== formEpoch.current) { setLocal(null); setDraft(""); return; }
      setError(apiErrorMessage(e, "保存未能确认，请重新读取本地手册后再试"));
    } finally { if (mounted.current) setSaving(false); }
  }
  return <div className="mt-3 flex flex-col gap-3">
    <div><h3 className="text-body font-medium">市场底线（只读）</h3>
      {market && <><p className="break-all text-caption text-muted">来源：{market.path}</p><pre aria-label="市场底线（只读）" tabIndex={0} className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-hover p-3 text-body">{market.text}</pre></>}
      {marketError && <p className="text-caption text-muted">{marketError}</p>}
    </div>
    <div><h3 className="text-body font-medium">本地运行手册（可编辑）</h3>
      <p className="break-all text-caption text-muted">登记来源：{profile.localPersonaPath}</p>
      <p className="text-caption text-muted">仅保存本地手册；不修改市场人格、模型或权限。规则冲突时遵守市场底线及平台审批要求。</p>
    </div>
    {loading ? <p role="status" className="text-caption text-muted">正在读取手册…</p> : local && <>
      <p className="break-all text-caption text-muted">实际文件：{local.path}</p>
      <Textarea aria-label="本地运行手册正文" rows={10} value={draft} disabled={saving} onChange={e => setDraft(e.target.value)} />
      <div><Button size="sm" variant="primary" loading={saving} disabled={draft === local.text} onClick={() => void save()}>保存本地手册</Button></div>
    </>}
    {error && <Alert tone="danger" action={<Button size="sm" disabled={saving} onClick={() => setRetry(n => n + 1)}>重新读取</Button>}>{error}</Alert>}
  </div>;
}
