import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { apiErrorMessage } from "../lib/api";
import { PROJECT_COLORS } from "../lib/projectColors";
import { isVersionConflict, taskboardApi, type Project as BoardProject } from "../lib/taskboard";
import type { AuthSession, ChatProject, Session } from "../lib/types";
import { cn } from "../lib/utils";
import { ProjectAssetsPanel } from "./ProjectAssetsPanel";
import { Alert, Button, Field, Input, Modal, Select, Tabs, Textarea, useConfirm } from "./ui";

// 色板定义已下沉到 lib/projectColors(侧栏首屏同步渲染要用,不能反向把本对话框拖进入口闭包);
// 此处 re-export 供既有引用(测试等)继续使用。
export { PROJECT_COLORS } from "../lib/projectColors";

const NAME_MAX = 60;
const INSTRUCTIONS_MAX = 4000;

const SETTINGS_TABS = [
  { value: "settings", label: "设置" },
  { value: "assets", label: "资产" },
] as const;

type DialogTab = (typeof SETTINGS_TABS)[number]["value"];

export function ProjectSettingsDialog(props: {
  open: boolean;
  project: ChatProject | null;
  /** default 组：只显示资产面板，projectId 传 null。 */
  assetsOnly?: boolean;
  onClose: () => void;
  onSave: (patch: {
    name?: string;
    color?: string | null;
    instructions?: string | null;
    boardProjectId?: string | null;
  }) => Promise<void>;
  demo?: boolean;
  auth?: AuthSession | null;
  authSession?: AuthSession;
  sessions?: Pick<Session, "id" | "title">[];
  onOpenSession?: (sessionId: string) => void;
}): ReactElement | null {
  const {
    open,
    project,
    assetsOnly = false,
    onClose,
    onSave,
    demo = false,
    auth = null,
    authSession,
    sessions,
    onOpenSession,
  } = props;
  const titleId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<DialogTab>("settings");
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [boardProjectId, setBoardProjectId] = useState<string>("");
  const [boardProjects, setBoardProjects] = useState<BoardProject[]>([]);
  const [boardListErr, setBoardListErr] = useState<string | null>(null);
  const [contextVersion, setContextVersion] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  /**
   * 看板项目自带的指令与文本域里用户已写的内容不同：不再直接覆盖（PS-01 数据丢失），
   * 先挂起等用户选「覆盖 / 保留」。null = 无待决。
   */
  const [pendingBoardInstructions, setPendingBoardInstructions] = useState<string | null>(null);
  /** 本次打开期间用户是否手动改过看板绑定：首次打开（项目已绑看板）沿用看板指令回填的旧行为。 */
  const boardTouchedRef = useRef(false);
  /** 文本域当前值的镜像：异步回调里读快照，不把 instructions 放进拉取 effect 的依赖。 */
  const instructionsRef = useRef(instructions);
  instructionsRef.current = instructions;
  /**
   * 脏检查基线（PS-03）：打开时取自 project；首次打开自动回填看板指令时同步更新，
   * 这样「什么都没改」的用户关闭时不会被误拦。
   */
  const baselineRef = useRef({ name: "", color: null as string | null, instructions: "", boardProjectId: "" });
  const [confirmDiscard, confirmDiscardEl] = useConfirm();

  useEffect(() => {
    if (!open) return;
    setTab(assetsOnly ? "assets" : "settings");
    setError("");
    setSaving(false);
    setPendingBoardInstructions(null);
    boardTouchedRef.current = false;
    if (project) {
      setName(project.name);
      setColor(project.color ?? null);
      setInstructions(project.instructions ?? "");
      setBoardProjectId(project.boardProjectId ?? "");
      setContextVersion(null);
      baselineRef.current = {
        name: project.name,
        color: project.color ?? null,
        instructions: project.instructions ?? "",
        boardProjectId: project.boardProjectId ?? "",
      };
    }
  }, [open, project, assetsOnly]);

  const loadBoardList = () => {
    if (!authSession) return;
    setBoardListErr(null);
    return taskboardApi
      .listProjects(authSession)
      .then((items) => {
        setBoardProjects(items);
        setBoardListErr(null);
      })
      .catch((e) => {
        setBoardProjects([]);
        setBoardListErr(apiErrorMessage(e, "看板列表加载失败"));
      });
  };

  useEffect(() => {
    if (!open || assetsOnly || !authSession) return;
    let cancelled = false;
    setBoardListErr(null);
    void taskboardApi
      .listProjects(authSession)
      .then((items) => {
        if (!cancelled) {
          setBoardProjects(items);
          setBoardListErr(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setBoardProjects([]);
          setBoardListErr(apiErrorMessage(e, "看板列表加载失败"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, assetsOnly, authSession]);

  useEffect(() => {
    setPendingBoardInstructions(null);
    if (!open || assetsOnly || !authSession || !boardProjectId.trim()) return;
    let cancelled = false;
    void taskboardApi
      .getProjectContext(authSession, boardProjectId.trim())
      .then((ctx) => {
        if (cancelled) return;
        setContextVersion(typeof ctx.version === "number" ? ctx.version : 0);
        const incoming =
          typeof ctx.instructions === "string"
            ? ctx.instructions
            : ctx.instructions === null
              ? ""
              : undefined;
        if (incoming === undefined) return;
        // 首次打开（项目已绑看板）：看板指令是权威，直接回填（旧行为）。
        // 用户在本次打开中手动切换看板：文本域为空或内容一致时直接回填；
        // 已有不同内容则挂起，交给用户决定覆盖还是保留（PS-01）。
        const cur = instructionsRef.current;
        if (!boardTouchedRef.current || cur.trim() === "" || cur === incoming) {
          setInstructions(incoming);
          // 程序回填不算用户改动：把基线一起挪过去，关闭时不误报「有未保存修改」（PS-03）。
          if (!boardTouchedRef.current) baselineRef.current.instructions = incoming;
        } else {
          setPendingBoardInstructions(incoming);
        }
      })
      .catch(() => {
        if (!cancelled) setContextVersion(0);
      });
    return () => {
      cancelled = true;
    };
  }, [open, assetsOnly, authSession, boardProjectId]);

  if (!assetsOnly && !project) return null;

  const activeTab: DialogTab = assetsOnly ? "assets" : tab;
  const nameTrim = name.trim();
  const nameInvalid = nameTrim.length < 1 || nameTrim.length > NAME_MAX;
  const instructionsOver = instructions.length > INSTRUCTIONS_MAX;
  const canSave = !nameInvalid && !instructionsOver && !saving;
  const showSettings = !assetsOnly && activeTab === "settings";
  const base = baselineRef.current;
  const dirty =
    !assetsOnly &&
    (name !== base.name ||
      color !== base.color ||
      instructions !== base.instructions ||
      boardProjectId !== base.boardProjectId);

  /** 关闭（Esc / 遮罩 / 取消）此前没有脏检查，编辑中的名称 / 指令误触即丢（PS-03）。 */
  const requestClose = () => {
    if (saving) return;
    if (!dirty) {
      onClose();
      return;
    }
    void confirmDiscard({
      title: "放弃未保存的修改？",
      body: "名称、颜色、指令或看板绑定有改动尚未保存，关闭后这些改动会丢失。",
      confirmText: "放弃修改",
      cancelText: "继续编辑",
      danger: true,
    }).then((ok) => {
      if (ok === true) onClose();
    });
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) requestClose();
  };

  const handleSave = async () => {
    if (!canSave || assetsOnly) return;
    setSaving(true);
    setError("");
    try {
      const boundId = boardProjectId.trim() === "" ? null : boardProjectId.trim();
      if (boundId && authSession) {
        const expected = contextVersion ?? 0;
        const saved = await taskboardApi.putProjectContext(authSession, boundId, {
          expectedVersion: expected,
          instructions: instructions.trim() === "" ? null : instructions,
        });
        // 两阶段保存(审计 CFG-23):看板指令已落盘、版本号已前进。先把新版本记下来并把指令基线
        // 挪到已保存内容,这样第二步 onSave 失败后用户重试时不会再拿旧 expectedVersion 撞 409,
        // 也不会被误报「刚被他处修改」。
        if (typeof saved?.context?.version === "number") setContextVersion(saved.context.version);
        baselineRef.current.instructions = instructions;
        try {
          await onSave({
            name: nameTrim,
            color,
            boardProjectId: boundId,
          });
        } catch (e) {
          setError(
            `看板项目指令已保存，但项目名称 / 颜色 / 绑定未能保存：${apiErrorMessage(e, "保存项目设置失败")}。请重试「保存」。`,
          );
          setSaving(false);
          return;
        }
      } else {
        await onSave({
          name: nameTrim,
          color,
          instructions: instructions.trim() === "" ? null : instructions,
          boardProjectId: boundId,
        });
      }
      onClose();
    } catch (e) {
      // 看板指令 expectedVersion 冲突（他处刚改过）与普通失败此前同报一句话（PS-07）：
      // 冲突要告诉用户「重新打开再保存」，否则只会反复撞同一个版本号。
      setError(
        isVersionConflict(e)
          ? "看板项目的指令刚被他处修改，请关闭后重新打开本对话框再保存。"
          : apiErrorMessage(e, "保存项目设置失败"),
      );
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={handleOpenChange}
      title={<span id={titleId}>{assetsOnly ? "项目资产" : "项目设置"}</span>}
      description={
        assetsOnly
          ? "未分组会话的上传资料与产出物。"
          : activeTab === "assets"
            ? "聚合本项目下的上传资料与会话产出。"
            : "项目指令会在该项目下的会话里作为额外偏好生效，不会覆盖平台规则。"
      }
      size="lg"
      fixedHeight
      mobile="sheet"
      onOpenAutoFocus={(e) => {
        if (assetsOnly || activeTab === "assets") return;
        e.preventDefault();
        nameRef.current?.focus();
      }}
      toolbar={
        assetsOnly ? undefined : (
          <Tabs
            value={activeTab}
            onValueChange={(v) => setTab(v as DialogTab)}
            items={[...SETTINGS_TABS]}
            idBase="project-settings"
            aria-label="项目设置分区"
          />
        )
      }
      footer={
        showSettings ? (
          <>
            <Button variant="secondary" onClick={requestClose} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void handleSave()} disabled={!canSave} loading={saving}>
              保存
            </Button>
          </>
        ) : undefined
      }
    >
      {showSettings ? (
        <div id="project-settings-panel-settings" role="tabpanel" className="flex flex-col gap-4">
          <Field
            label="名称"
            required
            error={
              name.length > 0 && nameInvalid
                ? `名称需为 1–${NAME_MAX} 个字`
                : undefined
            }
          >
            <Input
              ref={nameRef}
              value={name}
              maxLength={NAME_MAX + 8}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
            />
          </Field>

          <Field label="颜色" hint="可选。无颜色时侧栏只显示名称。">
            {/* 色块桌面 32px；触屏升到 44px 触控靶（PS-04）。 */}
            <div role="radiogroup" aria-label="项目颜色" className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                role="radio"
                aria-checked={color === null}
                aria-label="无颜色"
                title="无颜色"
                onClick={() => setColor(null)}
                className={cn(
                  "flex size-8 items-center justify-center rounded-full border outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:size-11",
                  color === null ? "border-accent ring-2 ring-ring" : "border-border-control hover:border-border-strong",
                )}
              >
                {/* 虚线圈用 muted 描边：深色下 border-strong 几乎不可见（PS-05）。 */}
                <span className="size-4 rounded-full border border-dashed border-muted bg-surface" />
              </button>
              {PROJECT_COLORS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  role="radio"
                  aria-checked={color === c.key}
                  aria-label={c.label}
                  title={c.label}
                  onClick={() => setColor(c.key)}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-full border outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:size-11",
                    color === c.key ? "border-accent ring-2 ring-ring" : "border-transparent hover:border-border-strong",
                  )}
                >
                  <span className={cn("size-5 rounded-full", c.dotClass)} />
                </button>
              ))}
            </div>
          </Field>

          <Field
            label="绑定任务面板项目"
            hint="绑定后，聊天与看板 stage 共用项目指令、资产、技能和正式记忆。未绑定 GitHub 仓库的会话使用项目工作区；仓库 clone 就绪时会话会切到仓库快照（允许覆盖）。"
          >
            {boardListErr ? (
              <Alert
                tone="danger"
                density="compact"
                className="mb-2"
                action={
                  <Button size="sm" variant="secondary" onClick={() => void loadBoardList()}>
                    重试
                  </Button>
                }
              >
                看板列表加载失败
              </Alert>
            ) : null}
            {/* 与设计系统其它下拉同构（ui/Select），不再手写裸 <select> 类名（PS-02）。 */}
            <Select
              inputSize="sm"
              value={boardProjectId}
              onValueChange={(v) => {
                boardTouchedRef.current = true;
                setBoardProjectId(v);
              }}
              options={[
                { value: "", label: "不绑定" },
                ...boardProjects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` })),
              ]}
              aria-label="绑定任务面板项目"
              disabled={!!boardListErr}
            />
          </Field>

          <Field
            label={
              // 字数计数并入标签行：原来落在文本域下方，默认高度下被 footer 遮住要滚动才见（PS-06）。
              <span className="flex items-center justify-between gap-2">
                <span>自定义指令</span>
                <span
                  aria-live="polite"
                  className={cn(
                    "text-caption font-normal tabular-nums",
                    instructionsOver ? "text-danger" : "text-faint",
                  )}
                >
                  {instructions.length} / {INSTRUCTIONS_MAX}
                </span>
              </span>
            }
            hint="写入后，该项目下新建与已有会话都会带上这段偏好；平台安全与产品规则始终优先。"
            error={instructionsOver ? `最多 ${INSTRUCTIONS_MAX} 字` : undefined}
          >
            <Textarea
              value={instructions}
              rows={6}
              onChange={(e) => setInstructions(e.target.value)}
              aria-label="自定义指令"
            />
          </Field>
          {pendingBoardInstructions !== null ? (
            <Alert
              tone="warning"
              density="compact"
              aria-live="polite"
              action={
                <span className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setInstructions(pendingBoardInstructions);
                      setPendingBoardInstructions(null);
                    }}
                  >
                    用看板指令覆盖
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPendingBoardInstructions(null)}>
                    保留当前内容
                  </Button>
                </span>
              }
            >
              所选看板项目自带的指令与当前内容不同。保存时以文本域内容为准。
            </Alert>
          ) : null}

          {error ? (
            <Alert tone="danger" density="compact">
              {error}
            </Alert>
          ) : null}
        </div>
      ) : authSession ? (
        <div id="project-settings-panel-assets" role="tabpanel">
          <ProjectAssetsPanel
            projectId={assetsOnly ? null : (project?.id ?? null)}
            demo={demo}
            auth={auth}
            authSession={authSession}
            sessions={sessions}
            onOpenSession={onOpenSession}
          />
        </div>
      ) : (
        <Alert tone="warning" density="compact">
          登录后才能管理项目资产。
        </Alert>
      )}
      {/* 放在分区条件之外：切到「资产」Tab 再按 Esc，脏检查确认框也得挂着（PS-03）。 */}
      {confirmDiscardEl}
    </Modal>
  );
}
