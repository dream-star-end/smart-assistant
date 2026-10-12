/**
 * 技能工作台 —— 单个技能的完整工作面(管理中心 → 技能 → 打开工作台)。
 *
 * 页签:正文 / 文件 / 评测 / 训练优化 / 历史。
 *  · 正文  :SKILL.md 的描述 + 适用智能体 + 正文(保存自动入版本历史);
 *  · 文件  :references/ scripts/ assets/ evals/ 辅助文件的新建 / 编辑 / 删除;
 *  · 评测  :评测用例编辑与对照评测(SkillEvalSection);
 *  · 训练  :AI 复盘起草改进 + 草稿审阅合并(SkillTrainSection);
 *  · 历史  :SKILL.md 版本快照,可一键回滚(恢复以新版本号写回,永远可再回滚)。
 * 只读技能(市场安装/agent-seed)全程只读,但仍可评测。
 *
 * ── 2026-07-26 结构与数据安全改造 ─────────────────────────────────────────
 * 1. **信息架构**:评测 / 训练优化两条重量级流程原先被压在技能列表行的手风琴里
 *    (弹窗 → 页签 → 行手风琴 → 行内二级 pill → 草稿区 → 现版对照,六层三重嵌套滚动,
 *    评测工具条在 390px 上直接撑破整个管理中心)。现在迁进本工作台:4xl 宽 / 88vh 高,
 *    嵌套滚动降到一层,技能列表回归"扫读 + 筛选"。
 * 2. **P0 改动丢失**:原先切换辅助文件会无条件 `setDirty(false)` 并重拉内容 ——
 *    在 SKILL.md 改到一半点别的文件,回来时内容是改过的、保存按钮却是灰的,
 *    用户以为已保存,关掉即全丢。现在改为 **per-path 草稿模型**:
 *    `fileDrafts`(路径 → 内容)+ `dirtyPaths`(有未保存改动的路径集合),
 *    切文件只切视图、不清草稿、已有草稿不重拉;左侧文件名带未保存圆点;
 *    保存按钮文案「保存（N）」;四条关闭路径(footer 关闭 / 标题 X / Escape / 点遮罩)
 *    统一被 `requestClose()` 拦截确认 —— Radix 的 open 由本组件受控,
 *    不调 onClose 弹窗就不会关。
 * 3. 高度不再靠 `calc(100% - 2.5rem)` 魔法数(报错 Alert 一出现就撑破),改纯 flex 分配。
 */
import {
  ChevronRight,
  Clock,
  FilePlus,
  FileText,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import type { ModelRates } from "../../lib/skillRunCost";
import type { AuthSession, MarketplaceMyAgent, SkillDetail } from "../../lib/types";
import { cn } from "../../lib/utils";
import { AgentScopePicker, AgentScopeSummary, normalizeAgentScope } from "../AgentScopePicker";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  ListGroup,
  ListRow,
  ListSkeleton,
  Modal,
  Skeleton,
  Tabs,
  Textarea,
  TimeAgo,
  useConfirm,
  useToast,
} from "../ui";
import { SkillEvalSection, SkillTrainSection } from "./SkillOptPanel";
import { skillHeading } from "./skillDisplay";

const AUX_PREFIXES = ["references/", "assets/", "evals/", "scripts/"];
const SKILL_MD = "SKILL.md";
const ID_BASE = "skill-workbench";

/** 适用范围快照比对(顺序有意义:normalizeAgentScope 已经定序去重)。 */
function sameScope(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export type WorkbenchTab = "body" | "files" | "evals" | "train" | "history";

const DEFAULT_AGENT: MarketplaceMyAgent = {
  id: "main",
  slug: "main",
  name: "全能助手",
  description: "",
  installed: true,
  isDefault: true,
};

export function SkillEditor({
  auth,
  skillName,
  displayTitle,
  open,
  onClose,
  onChanged,
  rates = null,
  initialTab = "body",
  onDelete,
}: {
  auth: AuthSession;
  skillName: string;
  /** 列表里展示的标题（描述首行）。缺省回退 skillName —— 同一个技能在列表 / 工作台 / 确认框里只叫一个名字。 */
  displayTitle?: string;
  open: boolean;
  onClose: () => void;
  /** 保存/恢复/删文件/合并训练草稿后通知外层刷新列表与正文缓存。 */
  onChanged: () => void;
  /** 训练/评测锁定模型的公开费率(成本估算与实报),拿不到就不给估算数字。 */
  rates?: ModelRates | null;
  /** 打开时落在哪个页签(列表行的「未配评测」入口直接落在评测)。 */
  initialTab?: WorkbenchTab;
  /**
   * 删除这个技能(OCV5-360:删除从列表行挪进工作台,危险操作放在「正文」页签最底部)。
   * 由外层负责确认 + 请求;返回 true = 已删除,工作台随即关闭(不再拦截未保存改动 —— 技能已经没了)。
   * 缺省或只读技能不渲染删除入口。
   */
  onDelete?: () => Promise<boolean>;
}) {
  const [tab, setTab] = useState<WorkbenchTab>(initialTab);
  const [deleting, setDeleting] = useState(false);
  // 保存与删除互斥(Codex r1):按钮态之外再用 ref 守住处理函数 —— 状态落地前的连点也挡得住。
  const deletingRef = useRef(false);
  const savingRef = useRef(false);
  // 已访问过的页签保持挂载(hidden),这样切走再切回时评测用例的编辑草稿与
  // 进行中的轮询都不会丢 —— 这两条流程都是分钟级且会扣费,重来一次代价真实。
  const [visited, setVisited] = useState<ReadonlySet<WorkbenchTab>>(() => new Set([initialTab]));
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [historyErr, setHistoryErr] = useState<string | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [newPathErr, setNewPathErr] = useState<string | null>(null);

  // SKILL.md 编辑态(描述 + 正文 + 适用范围)。
  // 三者都配 ref:保存请求在途时输入框仍然可编,响应回来后要拿"此刻的值"跟提交快照比对,
  // 走 state 只能读到发起保存那一次渲染的闭包旧值(见 save() 的提交快照一节)。
  const [desc, setDescState] = useState("");
  const descRef = useRef("");
  const [body, setBodyState] = useState("");
  const bodyRef = useRef("");
  const [agents, setAgents] = useState<MarketplaceMyAgent[]>([]);
  const [scopeIds, setScopeIdsState] = useState<string[]>(["main"]);
  const scopeIdsRef = useRef<string[]>(["main"]);
  const [scopeDirty, setScopeDirtyState] = useState(false);
  const setDesc = useCallback((v: string) => {
    descRef.current = v;
    setDescState(v);
  }, []);
  const setBody = useCallback((v: string) => {
    bodyRef.current = v;
    setBodyState(v);
  }, []);
  const setScopeIds = useCallback((v: string[]) => {
    scopeIdsRef.current = v;
    setScopeIdsState(v);
  }, []);

  // ── per-path 草稿模型 ────────────────────────────────────────────────────
  // fileDrafts:辅助文件的当前编辑内容(首次读取即入,之后**不再重拉**);
  // dirtyPaths:有未保存改动的路径("SKILL.md" 代表描述+正文)。
  // 两者都配 ref:effect / 异步回调要读"此刻的值",走 state 会读到闭包里的旧快照。
  const [fileDrafts, setFileDraftsState] = useState<Record<string, string>>({});
  const fileDraftsRef = useRef<Record<string, string>>({});
  const [dirtyPaths, setDirtyPathsState] = useState<ReadonlySet<string>>(() => new Set());
  const dirtyRef = useRef<ReadonlySet<string>>(new Set());
  const scopeDirtyRef = useRef(false);

  const setDirtyPaths = useCallback((next: ReadonlySet<string>) => {
    dirtyRef.current = next;
    setDirtyPathsState(next);
  }, []);
  const markDirty = useCallback(
    (path: string) => {
      if (dirtyRef.current.has(path)) return;
      const next = new Set(dirtyRef.current);
      next.add(path);
      setDirtyPaths(next);
    },
    [setDirtyPaths],
  );
  const clearDirty = useCallback(
    (paths: string[]) => {
      if (!paths.some((p) => dirtyRef.current.has(p))) return;
      const next = new Set(dirtyRef.current);
      for (const p of paths) next.delete(p);
      setDirtyPaths(next);
    },
    [setDirtyPaths],
  );
  const putDraft = useCallback((path: string, content: string) => {
    fileDraftsRef.current = { ...fileDraftsRef.current, [path]: content };
    setFileDraftsState(fileDraftsRef.current);
  }, []);
  const dropDraft = useCallback((path: string) => {
    const next = { ...fileDraftsRef.current };
    delete next[path];
    fileDraftsRef.current = next;
    setFileDraftsState(next);
  }, []);
  const setScopeDirty = useCallback((v: boolean) => {
    scopeDirtyRef.current = v;
    setScopeDirtyState(v);
  }, []);

  const [selected, setSelected] = useState<string>("");
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [history, setHistory] = useState<Array<{ version: string; timestamp: string }>>([]);
  const [confirmDialog, confirmDialogEl] = useConfirm();
  const toast = useToast();
  // 目录树开合:移动端默认收起(右侧编辑区太窄),桌面默认展开;选完文件在窄屏自动收起。
  const [treeOpen, setTreeOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 640,
  );
  const pickFile = useCallback((path: string) => {
    setFileErr(null);
    setSelected(path);
    if (typeof window !== "undefined" && window.innerWidth < 640) setTreeOpen(false);
  }, []);

  const writable = detail?.writable === true;
  // 同一个技能在列表 / 工作台 / 确认框里尽量只叫一个名字:正文有 H1 就用它(随编辑实时更新)。
  const heading = skillHeading(body) ?? (displayTitle?.trim() || skillName);
  const scopeEditable = writable && detail?.layer === "shared";

  // load 的代际号:refresh 可能被保存/删文件/训练合并/重试同时触发,响应乱序回来时
  // 只认最后一次发起的那一份 —— 否则更早发出的旧快照会盖掉更新的服务端内容。
  const loadSeqRef = useRef(0);

  /**
   * mode="reset"  :打开工作台 —— 服务端值是唯一权威,清空全部本地草稿。
   * mode="refresh":保存/删文件/恢复之后的对齐 —— **只覆盖没有本地草稿的部分**,
   *                绝不静默吃掉用户尚未保存的输入。dirty 判定读 ref,是"响应到达那一刻"
   *                的真实状态(请求在途时用户完全可能又敲了新内容)。
   */
  const load = useCallback(
    (mode: "reset" | "refresh") => {
      const seq = ++loadSeqRef.current;
      setLoading(true);
      setErr(null);
      Promise.all([
        api.getSkill(auth, skillName),
        api.listMyAgents(auth).catch(() => [] as MarketplaceMyAgent[]),
        // 历史版本数随打开就带上:改造前只在切到「历史」页签时才拉,标签「历史（N）」的 N
        // 会在会话中途凭空出现。失败静默(历史页签自己再拉一次并报错)。
        api.getSkillHistory(auth, skillName).catch(() => null),
      ])
        .then(([d, a, h]) => {
          if (seq !== loadSeqRef.current) return;
          setDetail(d);
          setAgents(a.length ? a : [DEFAULT_AGENT]);
          if (h) setHistory(h.history);
          if (mode === "reset" || !dirtyRef.current.has(SKILL_MD)) {
            setDesc(d.description ?? "");
            setBody(d.body ?? "");
          }
          if (mode === "reset" || !scopeDirtyRef.current) {
            setScopeIds(normalizeAgentScope(d.agentIds));
          }
        })
        .catch((e) => {
          if (seq !== loadSeqRef.current) return;
          setErr(apiErrorMessage(e, "加载技能失败"));
        })
        .finally(() => {
          if (seq === loadSeqRef.current) setLoading(false);
        });
    },
    [auth, skillName, setBody, setDesc, setScopeIds],
  );

  // 打开:全量重置(包括草稿)。关闭后再开永远从服务端权威态起步。
  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setVisited(new Set([initialTab]));
    setSelected("");
    setNewPath("");
    setNewPathErr(null);
    setFileErr(null);
    setHistoryErr(null);
    setSaveErr(null);
    setHistory([]);
    fileDraftsRef.current = {};
    setFileDraftsState({});
    setDirtyPaths(new Set());
    setScopeDirty(false);
    load("reset");
  }, [open, initialTab, load, setDirtyPaths, setScopeDirty]);

  useEffect(() => {
    setVisited((cur) => {
      if (cur.has(tab)) return cur;
      const next = new Set(cur);
      next.add(tab);
      return next;
    });
  }, [tab]);

  // 选中辅助文件时按需拉取一次。**已有草稿的路径不重拉** —— 这正是原先"切回去内容被
  // 覆盖、改动无声消失"的根因。
  useEffect(() => {
    if (!open || !selected) return;
    if (selected in fileDraftsRef.current) return;
    let alive = true;
    setFileLoading(true);
    setFileErr(null);
    api
      .getSkillFile(auth, skillName, selected)
      .then((r) => {
        if (alive) putDraft(selected, r.content);
      })
      .catch((e) => {
        if (alive) setFileErr(apiErrorMessage(e, "读取文件失败"));
      })
      .finally(() => {
        if (alive) setFileLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, selected, auth, skillName, putDraft]);

  useEffect(() => {
    if (!open || tab !== "history") return;
    setHistoryErr(null);
    api
      .getSkillHistory(auth, skillName)
      .then((r) => setHistory(r.history))
      .catch((e) => {
        setHistory([]);
        setHistoryErr(apiErrorMessage(e, "加载历史版本失败"));
      });
  }, [open, tab, auth, skillName]);

  // 辅助文件树:SKILL.md 与 history/ 不在这里(正文走「正文」页签,恢复走「历史」页签)。
  const tree = useMemo(() => {
    const files = (detail?.files ?? []).filter((f) => f !== SKILL_MD && !f.startsWith("history/"));
    const groups = new Map<string, string[]>();
    for (const f of files.sort()) {
      const dir = f.includes("/") ? f.split("/")[0] : "";
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir)?.push(f);
    }
    return groups;
  }, [detail]);
  const auxCount = useMemo(
    () => [...tree.values()].reduce((n, fs) => n + fs.length, 0),
    [tree],
  );

  const pendingCount = dirtyPaths.size + (scopeDirty && !dirtyPaths.has(SKILL_MD) ? 1 : 0);

  /**
   * 保存。**保存期间编辑器刻意不冻结**(网络慢时锁住输入框比丢改动更劝退),所以
   * "提交了什么"必须在发请求之前定格,响应回来后只有 **当前内容仍等于提交快照**
   * 才允许清 dirty。否则:点保存 → 继续敲 → 旧请求 200 → 新内容被标成"已保存",
   * 关窗/刷新时静默蒸发(用户视角:明明存过,内容却回退了)。
   *
   * 一并守住的两条:
   *  · 提交体一律取自快照(descRef/bodyRef/scopeIdsRef 在点保存那一刻的值),
   *    不会出现"半截旧半截新"的混合正文;
   *  · 保存 SKILL.md 后的 `load("refresh")` 只在对应字段已经不脏时才回填(load 内的
   *    ref 判定),所以请求期间敲进去的新输入不会被服务端旧内容盖掉。
   */
  const save = async () => {
    // dirty 集合读 ref 而不是 state:重试保存按钮可能在 state 落地前触发。
    const paths = [...dirtyRef.current];
    const scopeWasDirty = scopeDirtyRef.current;
    if (paths.length === 0 && !scopeWasDirty) return;
    // 删除进行中不再保存:后端保存会重建缺失的技能目录,保存晚于删除落地 = 技能「复活」。
    if (deletingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveErr(null);

    // ── 提交快照 ──────────────────────────────────────────────────────────
    const submittedFiles = new Map<string, string>();
    for (const p of paths) {
      if (p !== SKILL_MD) submittedFiles.set(p, fileDraftsRef.current[p] ?? "");
    }
    const submittedDesc = descRef.current;
    const submittedBody = bodyRef.current;
    const submittedScope = scopeIdsRef.current;
    const scopeUnchanged = () => sameScope(scopeIdsRef.current, submittedScope);

    // cleanPaths:落库 **且** 此后没再改动 → 可以清 dirty;
    // 落库但内容又变了的路径不进这个数组,继续保持脏(用户再点一次保存即可)。
    const cleanPaths: string[] = [];
    const failedPaths: string[] = [];
    let savedSkillMd = false;
    let scopeSaved = false;
    let firstErr: string | null = null;
    // 适用范围能否搭 SKILL.md 的车一起提交(不可编辑时不带 agentIds,得单独走一次)。
    const scopeRidesWithBody = paths.includes(SKILL_MD) && scopeEditable;

    for (const p of paths) {
      try {
        if (p === SKILL_MD) {
          await api.updateSkill(auth, skillName, {
            description: submittedDesc.trim(),
            body: submittedBody,
            tags: detail?.tags,
            ...(scopeEditable ? { agentIds: submittedScope } : {}),
          });
          savedSkillMd = true;
          if (descRef.current === submittedDesc && bodyRef.current === submittedBody) {
            cleanPaths.push(p);
          }
        } else {
          const content = submittedFiles.get(p) ?? "";
          await api.putSkillFile(auth, skillName, p, content);
          // 草稿本来就等于提交内容(或已被用户改得更新),这里绝不回写 ——
          // 回写会把"请求期间敲进去的新内容"覆盖成快照,是第二条丢改动的路径。
          if ((fileDraftsRef.current[p] ?? "") === content) cleanPaths.push(p);
        }
      } catch (e) {
        failedPaths.push(p);
        firstErr = firstErr ?? apiErrorMessage(e, `保存 ${p === SKILL_MD ? "正文" : p} 失败`);
      }
    }

    if (scopeWasDirty && !scopeRidesWithBody) {
      // 只改了适用范围(或正文脏但该技能不允许改归属)时单独提交一次。
      try {
        await api.updateSkill(auth, skillName, { agentIds: submittedScope });
        scopeSaved = true;
      } catch (e) {
        firstErr = firstErr ?? apiErrorMessage(e, "保存适用智能体失败");
      }
    } else if (scopeWasDirty && savedSkillMd) {
      scopeSaved = true;
    }
    if (scopeSaved && scopeUnchanged()) setScopeDirty(false);

    clearDirty(cleanPaths);
    savingRef.current = false;
    setSaving(false);
    if (firstErr) {
      setSaveErr(
        failedPaths.length > 0 ? `${firstErr}（${failedPaths.join("、")} 仍未保存）` : firstErr,
      );
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
    onChanged();
    // 版本号/文件列表要跟上;正文与适用范围的回填由 load("refresh") 自己按 dirty 兜。
    if (savedSkillMd) load("refresh");
  };

  const createFile = async () => {
    const path = newPath.trim();
    setNewPathErr(null);
    if (!path) return;
    if (!AUX_PREFIXES.some((p) => path.startsWith(p))) {
      setNewPathErr(`路径须以 ${AUX_PREFIXES.join(" / ")} 开头`);
      return;
    }
    if ((detail?.files ?? []).includes(path)) {
      setNewPathErr("同名文件已存在");
      return;
    }
    setCreating(true);
    try {
      await api.putSkillFile(auth, skillName, path, "");
      setNewPath("");
      putDraft(path, "");
      setSelected(path);
      load("refresh");
      onChanged();
    } catch (e) {
      setNewPathErr(apiErrorMessage(e, "创建失败"));
    } finally {
      setCreating(false);
    }
  };

  const removeFile = async (path: string) => {
    const ok = await confirmDialog({
      title: `删除文件「${path}」？`,
      body: dirtyRef.current.has(path) ? "该文件有未保存的修改，删除后一并丢失。" : undefined,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteSkillFile(auth, skillName, path);
      dropDraft(path);
      clearDirty([path]);
      if (selected === path) setSelected("");
      load("refresh");
      onChanged();
      // 目标行消失 = 离开了发起操作的上下文 → 走 Toast。
      toast(`已删除 ${path}`, "success");
    } catch (e) {
      setFileErr(apiErrorMessage(e, "删除失败"));
    }
  };

  const restore = async (version: string) => {
    const ok = await confirmDialog({
      title: `恢复到 v${version}？`,
      body: dirtyRef.current.has(SKILL_MD)
        ? "以新版本号写回该版本正文（现有内容会先存入历史，可再次回滚）。注意：你在「正文」页签未保存的修改会被丢弃。"
        : "以新版本号写回该版本正文（现有内容会先存入历史，可再次回滚）。",
      confirmText: "恢复",
    });
    if (!ok) return;
    try {
      await api.restoreSkillVersion(auth, skillName, version);
      clearDirty([SKILL_MD]);
      load("refresh");
      setTab("body");
      onChanged();
      toast(`已恢复到 v${version}`, "success");
    } catch (e) {
      setHistoryErr(apiErrorMessage(e, "恢复失败"));
    }
  };

  /** 四条关闭路径的唯一出口:有未保存改动先确认。 */
  const requestClose = useCallback(async () => {
    if (dirtyRef.current.size === 0 && !scopeDirtyRef.current) {
      onClose();
      return;
    }
    const list = [...dirtyRef.current].map((p) => (p === SKILL_MD ? "正文" : p));
    const ok = await confirmDialog({
      title: "放弃未保存的修改？",
      body: `${list.length > 0 ? `${list.join("、")} ` : "适用智能体 "}的改动尚未保存，关闭后将丢失。`,
      confirmText: "放弃",
      danger: true,
    });
    if (ok) onClose();
  }, [confirmDialog, onClose]);

  const tabItems = [
    { value: "body", label: "正文" },
    { value: "files", label: auxCount > 0 ? `文件（${auxCount}）` : "文件" },
    { value: "evals", label: "评测" },
    ...(writable ? [{ value: "train", label: "训练优化" }] : []),
    { value: "history", label: history.length ? `历史（${history.length}）` : "历史" },
  ];

  const panelClass = "min-h-0 flex-1 overflow-y-auto px-5 py-4";

  // 新建辅助文件的小表单:有文件时放在左侧目录底部,没有文件时直接放在空态里(OCV5-362)。
  const newFileForm = (
    <>
      <Field
        label="新建文件"
        hint="路径需以 references/ · assets/ · evals/ · scripts/ 开头"
        error={newPathErr}
      >
        <Input
          value={newPath}
          inputSize="sm"
          onChange={(e) => {
            setNewPath(e.target.value);
            if (newPathErr) setNewPathErr(null);
          }}
          placeholder="scripts/gen.sh"
          className="font-mono"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void createFile();
            }
          }}
        />
      </Field>
      <Button
        variant="secondary"
        size="sm"
        loading={creating}
        disabled={!newPath.trim()}
        onClick={createFile}
        className="mt-1.5 w-full"
      >
        {creating ? null : <FilePlus size={13} />} 创建
      </Button>
    </>
  );


  return (
    <Modal
      open={open}
      // Radix 的 open 由这里受控:X / Escape / 点遮罩都会走到这个回调,
      // 不调用 onClose 弹窗就不会关 —— 四条关闭路径由此收敛到 requestClose 一处。
      onOpenChange={(o) => {
        if (!o) void requestClose();
      }}
      // 头部只放人话名字(正文 H1 > 描述首行 > slug),一行截断;slug 与版本号是下面那一行灰字。
      // 原先「技能工作台 · <整句触发描述>」在手机上占四行粗体(运营 10-09 19:53 截图)。
      title={<span className="line-clamp-1 break-all text-title font-semibold text-fg">{heading}</span>}
      description={
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-meta text-faint">
          <span className="select-all break-all">{skillName}</span>
          {detail?.version && <span aria-hidden="true">·</span>}
          {detail?.version && <span className="tabular-nums">v{detail.version}</span>}
          {detail && !writable && <span aria-hidden="true">·</span>}
          {detail && !writable && <span>只读</span>}
        </span>
      }
      size="xl"
      mobile="fullscreen"
      className="md:h-[min(88vh,52rem)] md:max-w-5xl"
      bodyClassName="flex min-h-0 flex-col overflow-y-hidden p-0"
      toolbar={
        <Tabs
          aria-label="技能工作台分区"
          layout="grid"
          idBase={ID_BASE}
          value={tab}
          onValueChange={(v) => setTab(v as WorkbenchTab)}
          items={tabItems}
        />
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => void requestClose()}>
            关闭
          </Button>
          {writable && (
            <Button variant="primary" loading={saving} disabled={pendingCount === 0 || deleting} onClick={save}>
              {saved && pendingCount === 0 ? "已保存" : pendingCount > 0 ? `保存（${pendingCount}）` : "保存"}
            </Button>
          )}
        </>
      }
    >
      {confirmDialogEl}

      {/* 局部刷新失败(已有内容在手):顶层 Alert 提示,不遮挡正在编辑的内容。 */}
      {err && detail && (
        <div className="shrink-0 px-5 pt-4">
          <Alert
            tone="danger"
            density="compact"
            onDismiss={() => setErr(null)}
            action={
              <Button size="sm" variant="secondary" onClick={() => load("refresh")}>
                重试
              </Button>
            }
          >
            {err}
          </Alert>
        </div>
      )}

      {loading && !detail ? (
        <div className={panelClass}>
          <ListSkeleton rows={3} />
        </div>
      ) : err && !detail ? (
        // 首次加载失败:不渲染一个空壳编辑器(那是「看起来像真内容的假象」),只给失败态与出口。
        <div className={panelClass}>
          <EmptyState
            icon={TriangleAlert}
            title="打不开这个技能"
            hint={err}
            action={
              <Button variant="secondary" size="sm" onClick={() => load("reset")}>
                重试
              </Button>
            }
          />
        </div>
      ) : (
        <>
          {/* ── 正文 ─────────────────────────────────────────────────────── */}
          {/* OCV5-362 第 6 轮(运营「技能点进去显示 ui/ux 还是很烂」):桌面两栏 —— 左边是撑满高度的
              正文编辑器,右边 18rem 的信息栏放描述 / 适用智能体 / 标识与版本 / 删除。改前五块竖排在
              一列里:描述被截成一行、删除行压在正文框底边上。窄屏单列:正文在前,信息栏接在下面。 */}
          <div
            id={`${ID_BASE}-panel-body`}
            role="tabpanel"
            aria-labelledby={`${ID_BASE}-tab-body`}
            // 两栏只在当前页签挂:`md:grid` 在层叠上排在 `hidden` 之后,一起写会让桌面上其它页签
            // 底下仍铺着正文两栏。
            className={
              tab === "body"
                ? "min-h-0 flex-1 overflow-y-auto md:grid md:grid-cols-[minmax(0,1fr)_18rem] md:overflow-hidden"
                : "hidden"
            }
          >
            <div className="flex flex-col gap-2 px-5 py-4 md:min-h-0">
              {!writable && (
                <Alert tone="info" density="compact">
                  这是市场安装 / 平台内置的技能，内容由作者维护，不可编辑。需要按自己的用法改动，
                  可在市场详情页「另存为自建技能」后再来这里编辑。
                </Alert>
              )}
              {/* 只读技能不用 disabled 控件呈现内容:disabled 是 50% 透明、不可聚焦、不可选中复制、
                  触屏内不可滚动 —— "只读但可读"变成"基本读不了"。改为可聚焦的只读文本块。 */}
              {writable ? (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <label htmlFor={`${ID_BASE}-body`} className="text-meta font-medium text-muted">
                      正文
                    </label>
                    <span className="truncate text-caption text-faint">保存后旧版自动进入历史</span>
                  </div>
                  <Textarea
                    id={`${ID_BASE}-body`}
                    value={body}
                    onChange={(e) => {
                      setBody(e.target.value);
                      markDirty(SKILL_MD);
                    }}
                    spellCheck={false}
                    className="min-h-[18rem] font-mono md:min-h-0 md:flex-1"
                  />
                </>
              ) : (
                <ReadOnlyText label="正文" text={body} className="min-h-[18rem] md:min-h-0 md:flex-1" />
              )}
            </div>

            <aside
              aria-label="技能信息"
              className="flex flex-col gap-6 border-border px-5 py-4 max-md:border-t md:min-h-0 md:overflow-y-auto md:border-l"
            >
              {writable ? (
                <Field label="描述" hint="触发的唯一依据：做什么 + 什么时候用。">
                  <Textarea
                    value={desc}
                    onChange={(e) => {
                      setDesc(e.target.value);
                      markDirty(SKILL_MD);
                    }}
                    rows={5}
                  />
                </Field>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <span className="text-meta font-medium text-muted">描述</span>
                  <p className="text-body leading-relaxed text-fg">{desc || "（无描述）"}</p>
                </div>
              )}

              {agents.length > 0 &&
                (scopeEditable ? (
                  <AgentScopePicker
                    bare
                    agents={agents}
                    selectedIds={scopeIds}
                    onChange={(ids) => {
                      setScopeIds(ids);
                      setScopeDirty(true);
                    }}
                    title="适用智能体"
                    hint="哪些智能体会用到这个技能。"
                  />
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-meta font-medium text-muted">适用智能体</span>
                    <p className="text-body text-fg">
                      <AgentScopeSummary agentIds={detail?.agentIds} agents={agents} />
                    </p>
                  </div>
                ))}

              {/* 标识与版本已在头部那一行灰字里,这里只补头部没有的事实。 */}
              <dl data-skill-facts="" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-meta">
                <dt className="text-faint">来源</dt>
                <dd className="text-muted">{detail?.layer === "hub" ? "市场安装" : "自建"}</dd>
                <dt className="text-faint">辅助文件</dt>
                <dd className="tabular-nums text-muted">{auxCount > 0 ? `${auxCount} 个` : "无"}</dd>
                <dt className="text-faint">历史版本</dt>
                <dd className="tabular-nums text-muted">{history.length > 0 ? `${history.length} 个` : "无"}</dd>
              </dl>

              {writable && onDelete && (
                <div data-danger-zone="" className="mt-auto flex flex-col items-start gap-1 border-t border-border pt-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={deleting}
                    disabled={saving}
                    onClick={async () => {
                      if (savingRef.current || deletingRef.current) return;
                      deletingRef.current = true;
                      setDeleting(true);
                      try {
                        if (await onDelete()) onClose();
                      } finally {
                        deletingRef.current = false;
                        setDeleting(false);
                      }
                    }}
                    className="-ml-3 text-danger hover:bg-danger-soft"
                  >
                    <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                    删除技能
                  </Button>
                  <p className="text-caption text-faint">删除后智能体将不再使用它，且无法恢复。</p>
                </div>
              )}
            </aside>
          </div>

          {/* ── 文件 ─────────────────────────────────────────────────────── */}
          <div
            id={`${ID_BASE}-panel-files`}
            role="tabpanel"
            aria-labelledby={`${ID_BASE}-tab-files`}
            // 文件页签自己不滚:左树与右编辑区各自滚动,故这里用 overflow-hidden
            // 而不是 panelClass 的 overflow-y-auto(两者同时写会靠 CSS 生成顺序决胜)。
            className={cn(
              "flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-5 py-4",
              tab !== "files" && "hidden",
            )}
          >
            {auxCount === 0 && !selected ? (
              // 没有任何辅助文件:不再一左一右两个空栏(左边「还没有辅助文件」+ 表单,右边又一个空态),
              // 合成一个空态 + 就地新建(OCV5-362)。
              <div className="flex flex-col gap-2 overflow-y-auto">
                {fileErr && (
                  <Alert tone="danger" density="compact" onDismiss={() => setFileErr(null)}>
                    {fileErr}
                  </Alert>
                )}
                <EmptyState
                  icon={FolderOpen}
                  title="还没有辅助文件"
                  hint="辅助文件放参考资料、脚本与素材，技能运行时按需读取；技能正文在「正文」页签。"
                />
                {writable && <div data-new-file-form="" className="w-full max-w-sm px-4">{newFileForm}</div>}
              </div>
            ) : (
            <>
            <div className="flex items-center gap-2">
              <IconButton
                variant="muted"
                size="sm"
                shape="square"
                aria-expanded={treeOpen}
                aria-label={treeOpen ? "收起文件列表" : "展开文件列表"}
                onClick={() => setTreeOpen((o) => !o)}
              >
                {treeOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
              </IconButton>
              <span className="min-w-0 text-meta text-muted">
                辅助文件：参考资料 / 脚本 / 素材。技能正文在「正文」页签。
              </span>
            </div>
            {fileErr && (
              <Alert tone="danger" density="compact" onDismiss={() => setFileErr(null)}>
                {fileErr}
              </Alert>
            )}
            <div className="flex min-h-0 flex-1 gap-3">
              {treeOpen && (
                <Card
                  tone="sunken"
                  className="flex w-56 max-w-[45vw] shrink-0 flex-col gap-0.5 overflow-y-auto p-2"
                >
                  {auxCount === 0 && (
                    <p className="px-1 py-2 text-meta text-muted">还没有辅助文件。</p>
                  )}
                  {[...tree.entries()].map(([dir, files]) =>
                    dir === "" ? (
                      files.map((f) => (
                        <FileNode
                          key={f}
                          label={f}
                          active={selected === f}
                          dirty={dirtyPaths.has(f)}
                          onClick={() => pickFile(f)}
                          onDelete={writable ? () => removeFile(f) : undefined}
                        />
                      ))
                    ) : (
                      <div key={dir} className="mt-1">
                        <div className="flex items-center gap-1 px-1.5 py-0.5 text-caption font-medium text-muted">
                          <ChevronRight size={11} className="rotate-90" /> {dir}/
                        </div>
                        {files.map((f) => (
                          <FileNode
                            key={f}
                            label={f.slice(dir.length + 1)}
                            indent
                            active={selected === f}
                            dirty={dirtyPaths.has(f)}
                            onClick={() => pickFile(f)}
                            onDelete={writable ? () => removeFile(f) : undefined}
                          />
                        ))}
                      </div>
                    ),
                  )}
                  {writable && (
                    <div className="mt-2 border-t border-border pt-2">
                      {newFileForm}
                    </div>
                  )}
                </Card>
              )}

              <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
                {!selected ? (
                  <EmptyState
                    icon={FolderOpen}
                    title={auxCount > 0 ? "选一个文件开始" : "还没有辅助文件"}
                    hint={
                      auxCount > 0
                        ? writable
                          ? "左侧列表里点任意文件即可编辑；未保存的文件会带一个圆点。"
                          : "左侧列表里点任意文件即可查看。"
                        : writable
                          ? "辅助文件放参考资料、脚本与素材，技能运行时按需读取。可在左侧新建。"
                          : "辅助文件放参考资料、脚本与素材，技能运行时按需读取。"
                    }
                    action={
                      !treeOpen ? (
                        <Button size="sm" variant="secondary" onClick={() => setTreeOpen(true)}>
                          展开文件列表
                        </Button>
                      ) : undefined
                    }
                  />
                ) : fileLoading ? (
                  <div className="flex flex-col gap-2">
                    <Skeleton className="h-3.5 w-40" />
                    <Skeleton className="h-64 rounded-lg" />
                  </div>
                ) : writable ? (
                  <Field
                    label={
                      <span className="flex items-center gap-1.5">
                        <span className="font-mono">{selected}</span>
                        {dirtyPaths.has(selected) && (
                          <Badge tone="accent" size="sm">
                            未保存
                          </Badge>
                        )}
                      </span>
                    }
                    className="min-h-0 flex-1"
                  >
                    <Textarea
                      value={fileDrafts[selected] ?? ""}
                      onChange={(e) => {
                        putDraft(selected, e.target.value);
                        markDirty(selected);
                      }}
                      className="min-h-[16rem] flex-1 font-mono"
                    />
                  </Field>
                ) : (
                  <ReadOnlyText label={selected} text={fileDrafts[selected] ?? ""} className="min-h-0 flex-1" mono />
                )}
              </div>
            </div>
            </>
            )}
          </div>

          {/* ── 评测 ─────────────────────────────────────────────────────── */}
          {visited.has("evals") && (
            <div
              id={`${ID_BASE}-panel-evals`}
              role="tabpanel"
              aria-labelledby={`${ID_BASE}-tab-evals`}
              className={cn(panelClass, tab !== "evals" && "hidden")}
            >
              <SkillEvalSection auth={auth} skillName={skillName} rates={rates} />
            </div>
          )}

          {/* ── 训练优化 ─────────────────────────────────────────────────── */}
          {writable && visited.has("train") && (
            <div
              id={`${ID_BASE}-panel-train`}
              role="tabpanel"
              aria-labelledby={`${ID_BASE}-tab-train`}
              className={cn(panelClass, tab !== "train" && "hidden")}
            >
              <SkillTrainSection
                auth={auth}
                skillName={skillName}
                rates={rates}
                onSkillChanged={() => {
                  // 合并已改写技能库:本地正文与外层列表缓存都必须失效,
                  // 否则用户切到「正文」看到的还是旧版 —— 坐实"花了积分没生效"。
                  load("refresh");
                  onChanged();
                }}
              />
            </div>
          )}

          {/* ── 历史 ─────────────────────────────────────────────────────── */}
          <div
            id={`${ID_BASE}-panel-history`}
            role="tabpanel"
            aria-labelledby={`${ID_BASE}-tab-history`}
            className={cn("flex flex-col gap-1.5", panelClass, tab !== "history" && "hidden")}
          >
            {historyErr && (
              <Alert tone="danger" density="compact" onDismiss={() => setHistoryErr(null)}>
                {historyErr}
              </Alert>
            )}
            {history.length === 0 && !historyErr ? (
              <EmptyState
                icon={Clock}
                title="还没有历史版本"
                hint="每次保存正文，旧版都会自动留在这里，可以一键恢复。辅助文件不进历史。"
                action={
                  writable ? (
                    <Button size="sm" variant="secondary" onClick={() => setTab("body")}>
                      去编辑正文
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              // 与管理中心其它列表同一种分组容器(OCV5-362):改前每个版本一张下沉卡片 + 强调色时钟图标。
              <>
                <ListGroup data-skill-history="">
                  {history.map((h) => (
                    <ListRow key={h.version} className="flex items-center gap-3">
                      <span className="text-body font-medium tabular-nums text-fg">v{h.version}</span>
                      <TimeAgo value={h.timestamp} className="text-meta text-faint" />
                      {writable && (
                        <Button variant="ghost" size="sm" className="ms-auto" onClick={() => restore(h.version)}>
                          恢复此版本
                        </Button>
                      )}
                    </ListRow>
                  ))}
                </ListGroup>
                <p className="mt-1 text-caption text-faint">历史覆盖正文（SKILL.md）；辅助文件不进历史。</p>
              </>
            )}
          </div>
        </>
      )}

      {/* 保存失败贴 footer 报 —— 发起保存的按钮就在这条下面一行,不会再被滚动埋掉。 */}
      {saveErr && (
        <div className="shrink-0 border-t border-border px-5 py-2.5">
          <Alert
            tone="danger"
            density="compact"
            onDismiss={() => setSaveErr(null)}
            action={
              <Button size="sm" variant="secondary" loading={saving} disabled={deleting} onClick={save}>
                重试保存
              </Button>
            }
          >
            {saveErr}
          </Alert>
        </div>
      )}
    </Modal>
  );
}

/**
 * 只读技能的正文 / 辅助文件呈现:可聚焦的滚动区（WCAG 2.1.1）+ 正常对比度 + 可选中复制。
 * 不用 disabled Textarea:那是 50% 透明、不可聚焦、不可选中、触屏内不可滚的"死"控件。
 */
function ReadOnlyText({
  label,
  text,
  className,
  mono,
}: {
  label: string;
  text: string;
  className?: string;
  mono?: boolean;
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className={cn("text-meta font-medium text-muted", mono && "font-mono")}>{label}</span>
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动的只读区必须能被键盘聚焦
        tabIndex={0}
        aria-label={label}
        className="min-h-0 flex-1 overflow-auto rounded-lg bg-code outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <pre className="whitespace-pre-wrap break-words px-3.5 py-2.5 font-mono text-body leading-relaxed text-fg">
          {text || "（空）"}
        </pre>
      </section>
    </div>
  );
}

function FileNode({
  label,
  active,
  indent,
  dirty,
  onClick,
  onDelete,
}: {
  label: string;
  active: boolean;
  indent?: boolean;
  /** 有未保存改动 → 文件名后一个 accent 圆点。 */
  dirty?: boolean;
  onClick: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-1.5 rounded-md px-1.5 py-1",
        indent && "ml-3.5",
        active ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "true" : undefined}
        // 未保存状态必须进可访问名:圆点对读屏用户等于不存在。
        aria-label={dirty ? `${label} 有未保存的修改` : undefined}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left font-mono text-caption outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
      >
        <FileText size={12} className="shrink-0" />
        <span className="truncate">{label}</span>
        {dirty && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent" />}
      </button>
      {onDelete && (
        // 触屏没有 hover 态:原先 `hidden … group-hover:flex` 让删除按钮在手机上
        // **永远不可达**(功能性缺失)。改为常驻低强度,触屏与键盘聚焦时全量显示。
        <IconButton
          variant="danger"
          size="xs"
          shape="square"
          aria-label={`删除 ${label}`}
          onClick={onDelete}
          className="opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Trash2 size={11} />
        </IconButton>
      )}
    </div>
  );
}
