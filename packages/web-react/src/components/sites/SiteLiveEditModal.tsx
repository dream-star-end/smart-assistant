import {
  CONTAINER_PREVIEW_DESKTOP_VIEWPORT,
  CONTAINER_PREVIEW_MOBILE_VIEWPORT,
  type ContainerPreviewElementTarget,
  type ContainerPreviewViewport,
  normalizeContainerPreviewViewport,
} from "@openclaude/protocol/containerPreview";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  ExternalLink,
  Globe2,
  Hand,
  Keyboard,
  ListChecks,
  Loader2,
  MessageSquarePlus,
  Monitor,
  MoreHorizontal,
  RefreshCw,
  RotateCw,
  Send,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiErrorMessage } from "../../lib/api";
import type { ContainerWebAnnotation } from "../../lib/containerPreview";
import { type SitePreviewSession, sitesApi } from "../../lib/sitesApi";
import type { AuthSession, UserSiteItem } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Modal, useConfirm } from "../ui";

const SITE_PREVIEW_MESSAGE_SOURCE = "oc-site-preview-v1";
const MAX_ANNOTATIONS = 20;
const READY_TIMEOUT_MS = 12_000;
const CONTROLS_AUTO_HIDE_MS = 3_000;
const TOUCH_DRAG_SLOP = 8;
const TOUCH_SCROLL_GAIN = 2;
const MOUSE_REVEAL_THROTTLE_MS = 250;
const HOVER_THROTTLE_MS = 60;

type ToolMode = "interact" | "comment";
type PreviewSurface = "none" | "textComposer" | "commentsDrawer" | "draftEditor";
type PreviewDevice = "desktop" | "mobile";
type PreviewPhase = "ticket" | "loading" | "ready" | "error";

type CommentDraft = {
  target: ContainerPreviewElementTarget;
  comment: string;
  editingId: string | null;
  targetMissing: boolean;
};

type PointerGesture = {
  id: number;
  x: number;
  y: number;
  type: string;
  lastX: number;
  lastY: number;
  dragging: boolean;
};

type AccessProfile = {
  slug: string;
  device: PreviewDevice;
  viewport: ContainerPreviewViewport;
};

function readAccessProfile(slug: string): AccessProfile {
  if (typeof window === "undefined") {
    return {
      slug,
      device: "desktop",
      viewport: CONTAINER_PREVIEW_DESKTOP_VIEWPORT,
    };
  }
  const mobile =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 767px)").matches
      : window.innerWidth <= 767;
  const visualViewport = window.visualViewport;
  return {
    slug,
    device: mobile ? "mobile" : "desktop",
    viewport: normalizeContainerPreviewViewport({
      width: visualViewport?.width ?? window.innerWidth,
      height: visualViewport?.height ?? window.innerHeight,
      deviceScaleFactor: mobile ? window.devicePixelRatio : 1,
      isMobile: mobile,
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseElementTarget(value: unknown): ContainerPreviewElementTarget | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.selector !== "string" ||
    value.selector.length < 1 ||
    value.selector.length > 512 ||
    typeof value.tag !== "string" ||
    value.tag.length < 1 ||
    value.tag.length > 64 ||
    !isRecord(value.bounds)
  ) {
    return null;
  }
  const { x, y, width, height } = value.bounds;
  if (![x, y, width, height].every((item) => typeof item === "number" && Number.isFinite(item))) {
    return null;
  }
  if (Number(width) < 0 || Number(height) < 0) return null;
  const optional = (key: "role" | "ariaLabel" | "text", max: number): string | undefined => {
    const field = value[key];
    return typeof field === "string" && field.length <= max ? field : undefined;
  };
  return {
    selector: value.selector,
    tag: value.tag,
    ...(optional("role", 128) ? { role: optional("role", 128) } : {}),
    ...(optional("ariaLabel", 256) ? { ariaLabel: optional("ariaLabel", 256) } : {}),
    ...(optional("text", 512) ? { text: optional("text", 512) } : {}),
    bounds: { x: Number(x), y: Number(y), width: Number(width), height: Number(height) },
  };
}

function oneLine(value: string | undefined, max: number): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function buildSiteLiveEditPrompt({
  site,
  currentUrl,
  title,
  viewport,
  annotations,
}: {
  site: UserSiteItem;
  currentUrl: string;
  title: string;
  viewport: ContainerPreviewViewport;
  annotations: readonly ContainerWebAnnotation[];
}): string {
  const mode = viewport.isMobile ? "移动端" : "桌面端";
  const isCollaborator = (site.accessRole ?? "owner") !== "owner";
  const lines = [
    isCollaborator
      ? `请按下面的站点页面元素标注修改协同站点「${site.title}」（slug: ${site.slug}）。如果当前工作区尚未拉取该站点代码，请先运行 \`oc-site pull ${site.slug} ./${site.slug}\` 拉取线上文件，完成修改并核验后运行 \`oc-site publish ./${site.slug} --slug ${site.slug}\` 重新发布；不要只描述方案。`
      : `请按下面的站点页面元素标注修改已发布站点「${site.title}」（slug: ${site.slug}）。先定位对应源码（若当前工作区没有本地源码可先运行 \`oc-site pull ${site.slug} ./${site.slug}\`），完成修改后重新构建并用 \`oc-site publish <目录> --slug ${site.slug}\` 发布上线；不要只描述方案。`,
    `站点地址：${site.url}`,
    `当前页面：${currentUrl}`,
    `页面标题：${oneLine(title, 200) || site.title}`,
    `检查视口：${mode} ${viewport.width} × ${viewport.height} CSS px（DPR ${viewport.deviceScaleFactor}）`,
    "",
  ];
  annotations.forEach((annotation, index) => {
    const target = annotation.target;
    const label = oneLine(target.ariaLabel || target.text, 160);
    lines.push(`${index + 1}. ${annotation.comment.trim().slice(0, 2_000)}`);
    lines.push(`   - 标注页面：${annotation.pageUrl}`);
    lines.push(`   - CSS 选择器：${JSON.stringify(target.selector)}`);
    lines.push(
      `   - 元素：<${target.tag}>${target.role ? `，role=${target.role}` : ""}${label ? `，内容=${JSON.stringify(label)}` : ""}`,
    );
    lines.push(
      `   - 位置：x=${Math.round(target.bounds.x)}，y=${Math.round(target.bounds.y)}，宽=${Math.round(target.bounds.width)}，高=${Math.round(target.bounds.height)} CSS px`,
    );
    if (annotation.missing) {
      lines.push("   - 注意：页面滚动或刷新后该选择器暂时未重新匹配，请结合源码确认。");
    }
  });
  return lines.join("\n");
}

export function SiteLiveEditModal({
  open,
  site,
  auth,
  onClose,
  onApplyPrompt,
}: {
  open: boolean;
  site: UserSiteItem;
  auth: AuthSession;
  onClose: () => void;
  onApplyPrompt: (prompt: string) => void;
}) {
  const [accessProfile, setAccessProfile] = useState<AccessProfile>(() =>
    readAccessProfile(site.slug),
  );
  const [device, setDevice] = useState<PreviewDevice>(accessProfile.device);
  const [mode, setMode] = useState<ToolMode>("interact");
  const [surface, setSurface] = useState<PreviewSurface>("none");
  const [phase, setPhase] = useState<PreviewPhase>("ticket");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [session, setSession] = useState<SitePreviewSession | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [navState, setNavState] = useState<{ url: string; title: string }>({
    url: site.url,
    title: site.title,
  });
  const [annotations, setAnnotations] = useState<ContainerWebAnnotation[]>([]);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [hoverTarget, setHoverTarget] = useState<ContainerPreviewElementTarget | null>(null);
  const [selectionHint, setSelectionHint] = useState<string | null>(null);
  const [textInput, setTextInput] = useState("");
  const [controlsVisible, setControlsVisible] = useState(true);
  const [directScale, setDirectScale] = useState({ x: 1, y: 1 });
  const [confirm, confirmEl] = useConfirm();

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const topControlsRef = useRef<HTMLElement>(null);
  const bottomControlsRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerStartRef = useRef<PointerGesture | null>(null);
  const lastPointerMoveAtRef = useRef(0);
  const lastHoverAtRef = useRef(0);
  const lastMouseRevealAtRef = useRef(0);
  const closeConfirmPendingRef = useRef(false);
  const textComposingRef = useRef(false);

  const sessionRef = useRef(session);
  const annotationsRef = useRef(annotations);
  const draftRef = useRef(draft);
  const modeRef = useRef(mode);
  const surfaceRef = useRef(surface);
  sessionRef.current = session;
  annotationsRef.current = annotations;
  draftRef.current = draft;
  modeRef.current = mode;
  surfaceRef.current = surface;

  const viewport = useMemo<ContainerPreviewViewport>(
    () =>
      device === accessProfile.device
        ? accessProfile.viewport
        : device === "mobile"
          ? CONTAINER_PREVIEW_MOBILE_VIEWPORT
          : CONTAINER_PREVIEW_DESKTOP_VIEWPORT,
    [accessProfile, device],
  );
  const fillsClientViewport =
    accessProfile.slug === site.slug && device === accessProfile.device;

  const sendToIframe = useCallback((message: Record<string, unknown>): boolean => {
    const cur = sessionRef.current;
    const frame = iframeRef.current?.contentWindow;
    if (!cur || !frame) return false;
    frame.postMessage({ source: SITE_PREVIEW_MESSAGE_SOURCE, message }, cur.siteOrigin);
    return true;
  }, []);

  const resolveAllTracked = useCallback(() => {
    const selectors = new Set(annotationsRef.current.map((a) => a.target.selector));
    if (draftRef.current) selectors.add(draftRef.current.target.selector);
    for (const selector of selectors) {
      sendToIframe({ type: "preview.resolve", selector });
    }
  }, [sendToIframe]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    setPhase("ticket");
    setErrorMsg(null);
    setSession(null);
    setHoverTarget(null);
    setNavState({ url: site.url, title: site.title });

    void sitesApi
      .createSitePreviewSession(auth, site.slug)
      .then((res) => {
        if (!alive) return;
        setSession(res.preview);
        setPhase("loading");
        readyTimer = setTimeout(() => {
          if (!alive) return;
          setPhase((cur) => {
            if (cur === "ready") return cur;
            setErrorMsg(
              "实时预览通道连接超时。请确认站点可访问，或检查浏览器是否拦截了跨站 iframe Cookie（可尝试允许第三方 Cookie 或关闭隐私拦截后重试）。",
            );
            return "error";
          });
        }, READY_TIMEOUT_MS);
      })
      .catch((e) => {
        if (!alive) return;
        setErrorMsg(apiErrorMessage(e, "无法启动站点实时编辑会话"));
        setPhase("error");
      });

    const onMessage = (event: MessageEvent) => {
      if (!alive) return;
      const curSession = sessionRef.current;
      if (
        !curSession ||
        event.origin !== curSession.siteOrigin ||
        event.source !== iframeRef.current?.contentWindow
      ) {
        return;
      }
      const data = event.data;
      if (!isRecord(data) || data.source !== SITE_PREVIEW_MESSAGE_SOURCE || typeof data.type !== "string") {
        return;
      }
      switch (data.type) {
        case "preview.ready": {
          if (readyTimer) {
            clearTimeout(readyTimer);
            readyTimer = null;
          }
          const url = typeof data.url === "string" ? data.url : site.url;
          const title = typeof data.title === "string" && data.title ? data.title : site.title;
          setNavState({ url, title });
          setPhase("ready");
          setErrorMsg(null);
          resolveAllTracked();
          return;
        }
        case "preview.navigation": {
          const url = typeof data.url === "string" ? data.url : site.url;
          const title = typeof data.title === "string" && data.title ? data.title : site.title;
          setNavState({ url, title });
          resolveAllTracked();
          return;
        }
        case "preview.scroll": {
          if (modeRef.current === "comment") {
            resolveAllTracked();
          }
          return;
        }
        case "preview.hover": {
          if (modeRef.current !== "comment" || surfaceRef.current === "commentsDrawer") {
            setHoverTarget(null);
            return;
          }
          setHoverTarget(parseElementTarget(data.target));
          return;
        }
        case "preview.selection": {
          if (modeRef.current !== "comment" || surfaceRef.current === "commentsDrawer") return;
          const target = parseElementTarget(data.target);
          if (!target) {
            setSelectionHint("这里没有可标注的网页元素，请换个位置再点一次");
            return;
          }
          const curDraft = draftRef.current;
          if (!curDraft && annotationsRef.current.length >= MAX_ANNOTATIONS) {
            setSelectionHint(`已达到 ${MAX_ANNOTATIONS} 条修改意见上限，请先编辑或删除已有条`);
            return;
          }
          setSelectionHint(null);
          setHoverTarget(null);
          setDraft(
            curDraft
              ? { ...curDraft, target, targetMissing: false }
              : { target, comment: "", editingId: null, targetMissing: false },
          );
          setSurface("draftEditor");
          return;
        }
        case "preview.resolved": {
          if (typeof data.selector !== "string") return;
          const target = parseElementTarget(data.target);
          setAnnotations((items) =>
            items.map((a) =>
              a.target.selector === data.selector
                ? target
                  ? { ...a, target, missing: false }
                  : { ...a, missing: true }
                : a,
            ),
          );
          setDraft((cur) => {
            if (!cur || cur.target.selector !== data.selector) return cur;
            return target
              ? { ...cur, target, targetMissing: false }
              : { ...cur, targetMissing: true };
          });
          return;
        }
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      alive = false;
      if (readyTimer) clearTimeout(readyTimer);
      window.removeEventListener("message", onMessage);
    };
  }, [auth, open, reconnectKey, resolveAllTracked, site.slug, site.title, site.url]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const update = () => {
      const { width, height } = node.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      const next = { x: width / viewport.width, y: height / viewport.height };
      setDirectScale((cur) => (cur.x === next.x && cur.y === next.y ? cur : next));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [viewport.height, viewport.width]);

  const ready = phase === "ready";
  const controlsAutoHideEligible =
    open && fillsClientViewport && ready && mode === "interact" && surface === "none";

  const clearControlsTimer = useCallback(() => {
    if (!controlsTimerRef.current) return;
    clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = null;
  }, []);

  const controlsContainFocus = useCallback(() => {
    const active = document.activeElement;
    return (
      active instanceof HTMLElement &&
      (topControlsRef.current?.contains(active) || bottomControlsRef.current?.contains(active))
    );
  }, []);

  const scheduleControlsHide = useCallback(() => {
    clearControlsTimer();
    if (!controlsAutoHideEligible) return;
    controlsTimerRef.current = setTimeout(() => {
      controlsTimerRef.current = null;
      if (controlsContainFocus()) return;
      setControlsVisible(false);
    }, CONTROLS_AUTO_HIDE_MS);
  }, [clearControlsTimer, controlsAutoHideEligible, controlsContainFocus]);

  const keepControlsVisible = useCallback(() => {
    setControlsVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide]);

  useEffect(() => {
    clearControlsTimer();
    if (!controlsAutoHideEligible) {
      setControlsVisible(true);
      return;
    }
    if (controlsVisible) scheduleControlsHide();
    return clearControlsTimer;
  }, [clearControlsTimer, controlsAutoHideEligible, controlsVisible, scheduleControlsHide]);

  useEffect(() => {
    if (surface !== "textComposer") return;
    const frame = requestAnimationFrame(() => textInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [surface]);

  const pointFromPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
    const contentWidth = scale > 0 ? viewport.width * scale : rect.width;
    const contentHeight = scale > 0 ? viewport.height * scale : rect.height;
    const offsetX = rect.left + (rect.width - contentWidth) / 2;
    const offsetY = rect.top + (rect.height - contentHeight) / 2;
    return {
      x: Math.max(0, Math.min(viewport.width, ((event.clientX - offsetX) / contentWidth) * viewport.width)),
      y: Math.max(0, Math.min(viewport.height, ((event.clientY - offsetY) / contentHeight) * viewport.height)),
    };
  };

  const selectAt = (point: { x: number; y: number }) => {
    sendToIframe({ type: "preview.select", ...point });
    setSelectionHint("正在识别网页元素…");
  };

  const onOverlayPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!ready) return;
    const point = pointFromPointer(event);
    pointerStartRef.current = {
      id: event.pointerId,
      ...point,
      type: event.pointerType,
      lastX: point.x,
      lastY: point.y,
      dragging: false,
    };
  };

  const onOverlayPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!ready) return;
    if (event.pointerType === "touch") {
      const gesture = pointerStartRef.current;
      if (!gesture || gesture.id !== event.pointerId) return;
      const point = pointFromPointer(event);
      if (!gesture.dragging) {
        if (Math.hypot(point.x - gesture.x, point.y - gesture.y) <= TOUCH_DRAG_SLOP) return;
        gesture.dragging = true;
      }
      const now = performance.now();
      if (now - lastPointerMoveAtRef.current < 50) return;
      lastPointerMoveAtRef.current = now;
      const dx = point.x - gesture.lastX;
      const dy = point.y - gesture.lastY;
      gesture.lastX = point.x;
      gesture.lastY = point.y;
      sendToIframe({
        type: "preview.wheel",
        deltaX: -dx * TOUCH_SCROLL_GAIN,
        deltaY: -dy * TOUCH_SCROLL_GAIN,
      });
      return;
    }
    const now = performance.now();
    if (now - lastHoverAtRef.current < HOVER_THROTTLE_MS) return;
    lastHoverAtRef.current = now;
    sendToIframe({ type: "preview.hover", ...pointFromPointer(event) });
  };

  const onOverlayPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!ready) return;
    const point = pointFromPointer(event);
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (event.pointerType === "touch" && start) {
      const moved = start.dragging || Math.hypot(point.x - start.x, point.y - start.y) > TOUCH_DRAG_SLOP;
      if (moved) {
        const dx = point.x - start.lastX;
        const dy = point.y - start.lastY;
        if (dx !== 0 || dy !== 0) {
          sendToIframe({
            type: "preview.wheel",
            deltaX: -dx * TOUCH_SCROLL_GAIN,
            deltaY: -dy * TOUCH_SCROLL_GAIN,
          });
        }
        return;
      }
    }
    selectAt(point);
  };

  const onOverlayWheel = (event: ReactWheelEvent<HTMLElement>) => {
    if (!ready) return;
    event.preventDefault();
    sendToIframe({ type: "preview.wheel", deltaX: event.deltaX, deltaY: event.deltaY });
  };

  const enterCommentMode = () => {
    if (!ready) return;
    setMode("comment");
    setSurface(draftRef.current ? "draftEditor" : "none");
    resolveAllTracked();
  };

  const leaveCommentMode = () => {
    setSurface("none");
    setMode("interact");
    setHoverTarget(null);
    setSelectionHint(null);
  };

  const saveDraft = () => {
    const cur = draftRef.current;
    const comment = cur?.comment.trim() ?? "";
    if (!cur || !comment || cur.targetMissing) return;
    const savedId = cur.editingId ?? crypto.randomUUID();
    if (cur.editingId) {
      setAnnotations((items) =>
        items.map((a) =>
          a.id === cur.editingId
            ? {
                ...a,
                target: cur.target,
                comment,
                pageUrl: navState.url,
                pageTitle: navState.title,
                missing: false,
              }
            : a,
        ),
      );
    } else {
      setAnnotations((items) => [
        ...items,
        {
          id: savedId,
          target: cur.target,
          comment,
          pageUrl: navState.url,
          pageTitle: navState.title,
        },
      ]);
    }
    setDraft(null);
    setSurface("none");
  };

  const editAnnotation = (annotation: ContainerWebAnnotation) => {
    setMode("comment");
    setDraft({
      target: annotation.target,
      comment: annotation.comment,
      editingId: annotation.id,
      targetMissing: Boolean(annotation.missing),
    });
    setSurface("draftEditor");
  };

  const deleteAnnotation = (id: string) => {
    setAnnotations((items) => items.filter((a) => a.id !== id));
    if (draftRef.current?.editingId === id) {
      setDraft(null);
      setSurface("none");
    }
  };

  const submitReview = () => {
    if (annotations.length === 0) return;
    const prompt = buildSiteLiveEditPrompt({
      site,
      currentUrl: navState.url,
      title: navState.title,
      viewport,
      annotations,
    });
    onApplyPrompt(prompt);
    onClose();
  };

  const requestClose = () => {
    const count = annotationsRef.current.length;
    const hasDraft = Boolean(draftRef.current?.comment.trim());
    if (count === 0 && !hasDraft) {
      onClose();
      return;
    }
    if (closeConfirmPendingRef.current) return;
    closeConfirmPendingRef.current = true;
    const what =
      count > 0 ? `已写的 ${count} 条修改意见${hasDraft ? "和未保存的草稿" : ""}` : "未保存的草稿";
    void confirm({
      title: "关闭站点实时编辑？",
      body: `${what}不会保留。想交给 AI 修改，请先点「加入输入框」。`,
      confirmText: "仍然关闭",
      cancelText: "继续标注",
      danger: true,
    }).then((choice) => {
      closeConfirmPendingRef.current = false;
      if (choice === true) onClose();
    });
  };

  const switchDevice = (next: PreviewDevice) => {
    keepControlsVisible();
    if (next === device) return;
    setAccessProfile(readAccessProfile(site.slug));
    setDevice(next);
  };

  const visibleTargets = useMemo(() => {
    if (mode !== "comment") return [];
    const items: Array<{
      key: string;
      target: ContainerPreviewElementTarget;
      label: number;
      active: boolean;
      missing: boolean;
      annotation: ContainerWebAnnotation | null;
    }> = annotations.map((annotation, index) => {
      const activeDraft = draft?.editingId === annotation.id ? draft : null;
      return {
        key: annotation.id,
        target: activeDraft?.target ?? annotation.target,
        label: index + 1,
        active: Boolean(activeDraft),
        missing: activeDraft ? activeDraft.targetMissing : Boolean(annotation.missing),
        annotation,
      };
    });
    if (draft && !draft.editingId) {
      items.push({
        key: "draft",
        target: draft.target,
        label: annotations.length + 1,
        active: true,
        missing: draft.targetMissing,
        annotation: null,
      });
    }
    return items;
  }, [annotations, draft, mode]);

  const aspect = viewport.width / viewport.height;
  const previewWidth = `min(${device === "mobile" ? "430px" : "1280px"}, 100%, calc((100dvh - 168px) * ${aspect}))`;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && requestClose()}
      onEscapeKeyDown={(event) => {
        if (surfaceRef.current !== "none") {
          event.preventDefault();
          setSurface("none");
          return;
        }
        if (modeRef.current === "comment") {
          event.preventDefault();
          leaveCommentMode();
          return;
        }
      }}
      srTitle={`站点实时编辑：${site.title}`}
      hideClose
      mobile="none"
      className="left-0 top-[var(--oc-visual-offset-top,0px)] h-[var(--oc-visual-height,100dvh)] max-h-[var(--oc-visual-height,100dvh)] w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0 bg-bg"
      bodyClassName="overflow-hidden p-0"
    >
      <div
        className="preview-shell relative flex h-full min-h-0 flex-col overflow-hidden"
        data-testid="site-live-edit-modal"
        data-controls-visible={controlsVisible}
        onPointerMove={(event) => {
          if (event.pointerType !== "mouse" || !controlsAutoHideEligible) return;
          const now = performance.now();
          if (now - lastMouseRevealAtRef.current < MOUSE_REVEAL_THROTTLE_MS) return;
          lastMouseRevealAtRef.current = now;
          keepControlsVisible();
        }}
      >
        <div className="preview-ambient pointer-events-none absolute inset-0" />

        {mode === "interact" && controlsVisible && (
          <header
            ref={topControlsRef}
            className="preview-floating-header preview-controls-enter"
            onPointerDownCapture={keepControlsVisible}
            onKeyDownCapture={keepControlsVisible}
          >
            <div className="preview-header-row mx-auto flex w-full max-w-[1600px] items-center gap-2 px-2 sm:px-4">
              <button
                ref={closeButtonRef}
                type="button"
                onClick={requestClose}
                aria-label="关闭站点实时编辑"
                title="关闭 (Esc)"
                className="preview-icon-button"
              >
                <X size={19} />
              </button>
              <div className="hidden items-center gap-1 sm:flex">
                <button
                  type="button"
                  disabled={!ready}
                  onClick={() => sendToIframe({ type: "preview.navigate", action: "back" })}
                  aria-label="后退"
                  className="preview-icon-button"
                >
                  <ArrowLeft size={18} />
                </button>
                <button
                  type="button"
                  disabled={!ready}
                  onClick={() => sendToIframe({ type: "preview.navigate", action: "forward" })}
                  aria-label="前进"
                  className="preview-icon-button"
                >
                  <ArrowRight size={18} />
                </button>
                <button
                  type="button"
                  disabled={!ready}
                  onClick={() => sendToIframe({ type: "preview.navigate", action: "reload" })}
                  aria-label="刷新网页"
                  className="preview-icon-button"
                >
                  <RotateCw size={17} />
                </button>
              </div>
              <div
                className="preview-address-pill min-w-0 flex-1"
                title={`${navState.title}\n${navState.url}`}
              >
                <Globe2
                  className="preview-accent-text hidden shrink-0 min-[430px]:block"
                  size={16}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-meta font-semibold text-white/90">
                    {navState.title}
                  </span>
                  <span className="block truncate text-micro text-white/45">{navState.url}</span>
                </span>
              </div>
              <a
                href={site.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="在新标签页打开站点"
                title="在新标签页打开"
                className="preview-icon-button"
              >
                <ExternalLink size={16} />
              </a>
              <div className="preview-device-switch" aria-label="预览设备">
                <DeviceBtn active={device === "desktop"} label="桌面" onClick={() => switchDevice("desktop")}>
                  <Monitor size={17} />
                </DeviceBtn>
                <DeviceBtn active={device === "mobile"} label="移动" onClick={() => switchDevice("mobile")}>
                  <Smartphone size={17} />
                </DeviceBtn>
              </div>
            </div>
          </header>
        )}

        {mode === "comment" && (
          <header className="preview-floating-header">
            <div className="preview-header-row mx-auto grid w-full max-w-[1100px] grid-cols-[auto_1fr_auto] items-center gap-2 px-2 sm:px-4">
              <button
                type="button"
                onClick={leaveCommentMode}
                aria-label="返回操作网页"
                className="preview-icon-button"
              >
                <ArrowLeft size={19} />
              </button>
              <button
                type="button"
                onClick={() => setSurface("commentsDrawer")}
                aria-haspopup="dialog"
                aria-expanded={surface === "commentsDrawer"}
                className="preview-comment-count"
              >
                <ListChecks size={16} />
                <span>{annotations.length} 条评论</span>
              </button>
              <button
                type="button"
                disabled={annotations.length === 0}
                onClick={submitReview}
                title="把标注加入对话输入框，交给 AI 修改并重新发布"
                className="preview-primary-button"
              >
                <span className="hidden min-[430px]:inline">加入输入框</span>
                <span className="min-[430px]:hidden">加入</span>
                <Send size={15} />
              </button>
            </div>
          </header>
        )}

        {mode === "interact" && surface === "none" && !controlsVisible && (
          <div className="preview-controls-reveal">
            <button
              type="button"
              aria-label="显示预览控制"
              onClick={keepControlsVisible}
              className="preview-icon-button"
            >
              <MoreHorizontal size={20} />
            </button>
          </div>
        )}

        <main
          className={cn(
            "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-2 pb-[calc(88px+env(safe-area-inset-bottom))] pt-[calc(76px+env(safe-area-inset-top))] sm:px-6 sm:pb-24 sm:pt-20",
            fillsClientViewport && "absolute inset-0 p-0 sm:p-0",
          )}
        >
          <div
            ref={viewportRef}
            data-testid="site-live-edit-viewport"
            className={cn(
              "preview-viewport relative max-h-full max-w-full overflow-hidden",
              !fillsClientViewport && (device === "mobile" ? "rounded-3xl" : "rounded-xl"),
              fillsClientViewport && "size-full max-h-none max-w-none rounded-none border-0",
              mode === "comment" && ready && "preview-viewport-selecting",
              phase === "error" && "preview-viewport-error",
            )}
            style={
              fillsClientViewport
                ? { width: "100%", height: "100%" }
                : { aspectRatio: `${viewport.width} / ${viewport.height}`, width: previewWidth }
            }
          >
            {session && (
              <iframe
                ref={iframeRef}
                src={session.bootstrapUrl}
                title={`站点实时编辑预览：${site.title}`}
                sandbox="allow-scripts allow-forms allow-same-origin allow-modals allow-popups"
                referrerPolicy="no-referrer"
                className={cn(
                  "absolute left-0 top-0 border-0 bg-white outline-none",
                  mode === "comment" && "pointer-events-none",
                )}
                style={{
                  width: `${viewport.width}px`,
                  height: `${viewport.height}px`,
                  transform: `scale(${directScale.x}, ${directScale.y})`,
                  transformOrigin: "top left",
                }}
              />
            )}

            {mode === "comment" && ready && (
              <div
                tabIndex={0}
                role="application"
                aria-label="网页画面，点按选择要修改的元素"
                className="absolute inset-0 z-[5] touch-none cursor-crosshair outline-none"
                onPointerDown={onOverlayPointerDown}
                onPointerMove={onOverlayPointerMove}
                onPointerUp={onOverlayPointerUp}
                onPointerLeave={() => setHoverTarget(null)}
                onPointerCancel={() => {
                  pointerStartRef.current = null;
                }}
                onContextMenu={(event) => event.preventDefault()}
                onWheel={onOverlayWheel}
              />
            )}

            {mode === "comment" && hoverTarget && (
              <div
                style={targetOverlayStyle(hoverTarget, viewport)}
                className="pointer-events-none absolute z-[8] rounded border border-dashed border-info bg-info-soft"
              />
            )}

            {visibleTargets.map(({ key, target, label, active, missing, annotation }) => (
              <div
                key={key}
                style={targetOverlayStyle(target, viewport)}
                className={cn(
                  "preview-target-box pointer-events-none absolute z-10",
                  active && "preview-target-box-active",
                  missing && "preview-target-box-missing",
                )}
              >
                <button
                  type="button"
                  aria-label={
                    annotation
                      ? `编辑网页评论 ${label}：${annotation.comment.slice(0, 80)}`
                      : "继续编辑未保存的网页评论"
                  }
                  onClick={() => {
                    if (annotation) editAnnotation(annotation);
                    else setSurface("draftEditor");
                  }}
                  className="preview-anchor-hit pointer-events-auto"
                >
                  <span
                    className={cn("preview-anchor-dot", missing && "preview-anchor-dot-missing")}
                  >
                    {label}
                  </span>
                </button>
              </div>
            ))}

            {(phase === "ticket" || phase === "loading") && (
              <output
                aria-live="polite"
                className="preview-loading-state absolute inset-0 flex flex-col items-center justify-center text-center"
              >
                <span className="preview-state-icon">
                  <Loader2 className="animate-spin" size={21} />
                </span>
                <span className="preview-state-title">
                  {phase === "ticket" ? "正在建立站点实时编辑授权" : "正在加载站点页面"}
                </span>
                <span className="preview-state-copy">
                  加载完成后即可直接点选任意页面元素写修改意见
                </span>
              </output>
            )}

            {phase === "error" && (
              <div role="alert" className="preview-error-state absolute inset-0">
                <div className="preview-error-content">
                  <span className="preview-error-icon">
                    <CircleAlert size={21} />
                  </span>
                  <h2 className="preview-error-title">无法连接站点实时编辑</h2>
                  <p className="preview-error-copy">{errorMsg || "站点加载失败，请重试。"}</p>
                  <button
                    type="button"
                    onClick={() => setReconnectKey((v) => v + 1)}
                    className="preview-primary-button mx-auto mt-3.5"
                  >
                    <RefreshCw size={16} />
                    重试
                  </button>
                </div>
              </div>
            )}
          </div>

          {selectionHint && (
            <output
              aria-live="polite"
              className="preview-toast pointer-events-none absolute bottom-[calc(92px+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2"
            >
              {selectionHint}
            </output>
          )}
        </main>

        {mode === "interact" && surface === "none" && controlsVisible && (
          <div
            ref={bottomControlsRef}
            className="preview-bottom-layer preview-controls-enter"
            onPointerDownCapture={keepControlsVisible}
          >
            <div className="preview-action-dock" aria-label="站点实时编辑工具">
              <ActionBtn active label="操作" icon={<Hand size={20} />} onClick={keepControlsVisible} />
              <ActionBtn
                disabled={!ready}
                label="评论"
                icon={<MessageSquarePlus size={20} />}
                onClick={enterCommentMode}
              />
              <ActionBtn
                disabled={!ready}
                label="输入"
                icon={<Keyboard size={20} />}
                onClick={() => setSurface("textComposer")}
              />
            </div>
          </div>
        )}

        {mode === "interact" && surface === "textComposer" && (
          <form
            className="preview-bottom-layer"
            onSubmit={(event) => {
              event.preventDefault();
              if (textComposingRef.current || !textInput) return;
              if (!sendToIframe({ type: "preview.text", text: textInput })) return;
              setTextInput("");
              setSurface("none");
            }}
          >
            <div className="preview-composer">
              <button
                type="button"
                aria-label="关闭文字输入"
                onClick={() => setSurface("none")}
                className="preview-icon-button"
              >
                <X size={18} />
              </button>
              <input
                ref={textInputRef}
                value={textInput}
                onChange={(event) => setTextInput(event.target.value.slice(0, 2_000))}
                onCompositionStart={() => {
                  textComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  textComposingRef.current = false;
                }}
                aria-label="输入网页文字"
                placeholder="输入到网页当前焦点…"
                className="min-w-0 flex-1 bg-transparent px-1 text-base text-white outline-none placeholder:text-white/35"
              />
              <button
                type="submit"
                disabled={!ready || !textInput}
                aria-label="确认输入网页文字"
                className="preview-composer-submit"
              >
                <Send size={17} />
              </button>
            </div>
          </form>
        )}

        {mode === "comment" && surface === "draftEditor" && draft && (
          <SiteCommentEditor
            key={`${draft.editingId ?? "new"}:${draft.target.selector}`}
            draft={draft}
            annotationIndex={
              draft.editingId
                ? annotations.findIndex((a) => a.id === draft.editingId)
                : annotations.length
            }
            onChange={(comment) => setDraft((cur) => (cur ? { ...cur, comment } : null))}
            onHide={() => setSurface("none")}
            onCancel={() => {
              setDraft(null);
              setSurface("none");
            }}
            onSave={saveDraft}
            onDelete={draft.editingId ? () => deleteAnnotation(draft.editingId!) : undefined}
          />
        )}

        {mode === "comment" && surface === "none" && (
          <div className="preview-bottom-layer pointer-events-none">
            <div className="preview-comment-hint pointer-events-auto">
              {draft ? (
                <>
                  <span>有一条未保存的修改意见</span>
                  <button type="button" onClick={() => setSurface("draftEditor")}>
                    继续编辑
                  </button>
                </>
              ) : (
                <>
                  <MessageSquarePlus size={16} />
                  <span>点按任意页面元素添加修改意见，完成后点右上角「加入输入框」</span>
                </>
              )}
            </div>
          </div>
        )}

        {mode === "comment" && surface === "commentsDrawer" && (
          <Modal
            open
            onOpenChange={(next) => !next && setSurface("none")}
            srTitle="站点修改意见列表"
            hideClose
            mobile="none"
            className="preview-comments-modal"
            bodyClassName="overflow-hidden p-0"
          >
            <SiteCommentsDrawer
              annotations={annotations}
              onClose={() => setSurface("none")}
              onEdit={editAnnotation}
              onDelete={deleteAnnotation}
            />
          </Modal>
        )}
      </div>
      {confirmEl}
    </Modal>
  );
}

function ActionBtn({
  active = false,
  disabled = false,
  label,
  icon,
  onClick,
}: {
  active?: boolean;
  disabled?: boolean;
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={label === "操作" || label === "评论" ? active : undefined}
      onClick={onClick}
      className={cn("preview-action-button", active && "preview-action-button-active")}
    >
      <span className="preview-action-icon">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function DeviceBtn({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={`${label}预览`}
      aria-pressed={active}
      onClick={onClick}
      className={cn("preview-device-button", active && "preview-device-button-active")}
    >
      {children}
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

function SiteCommentEditor({
  draft,
  annotationIndex,
  onChange,
  onHide,
  onCancel,
  onSave,
  onDelete,
}: {
  draft: CommentDraft;
  annotationIndex: number;
  onChange: (value: string) => void;
  onHide: () => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete?: () => void;
}) {
  const textareaRef: RefObject<HTMLTextAreaElement | null> = useRef(null);
  const canSave = Boolean(draft.comment.trim()) && !draft.targetMissing;

  useEffect(() => {
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const label = draft.target.ariaLabel || draft.target.text;
  return (
    <div className="preview-bottom-layer">
      <section className="preview-comment-editor" aria-label="编辑站点修改意见">
        <div className="flex min-w-0 items-start gap-3">
          <span className="preview-anchor-dot static mt-0.5 shrink-0 translate-x-0 translate-y-0">
            {annotationIndex + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="preview-accent-text truncate text-xs font-semibold">
              {draft.target.selector}
            </div>
            <div className="mt-1 flex flex-wrap gap-1 text-micro text-white/45">
              <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5">
                &lt;{draft.target.tag}&gt;
              </span>
              {draft.target.role && (
                <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5">
                  role={draft.target.role}
                </span>
              )}
              {label && <span className="line-clamp-1">{label}</span>}
            </div>
          </div>
          <button
            type="button"
            aria-label="收起评论编辑器"
            onClick={onHide}
            className="preview-icon-button -mr-1 -mt-1"
          >
            <X size={17} />
          </button>
        </div>
        <textarea
          ref={textareaRef}
          value={draft.comment}
          maxLength={2_000}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (canSave) onSave();
          }}
          aria-label="描述网页修改"
          placeholder="例如：主标题字号调大一些，按钮改成圆角绿色并居中。"
          className="mt-3 min-h-20 w-full resize-none bg-transparent text-sm leading-6 text-white outline-none placeholder:text-white/30"
        />
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/10 pt-2">
          <div className="flex items-center gap-1">
            {onDelete && (
              <button
                type="button"
                aria-label="删除该评论"
                onClick={onDelete}
                className="preview-secondary-button preview-destructive-button"
              >
                <Trash2 size={15} />
                删除
              </button>
            )}
            <button type="button" onClick={onCancel} className="preview-secondary-button">
              {draft.editingId ? "取消修改" : "取消草稿"}
            </button>
          </div>
          <button
            type="button"
            disabled={!canSave}
            onClick={onSave}
            title="⌘/Ctrl + Enter"
            className="preview-primary-button"
          >
            <Check size={15} />
            {draft.editingId ? "保存" : "添加评论"}
          </button>
        </div>
      </section>
    </div>
  );
}

function SiteCommentsDrawer({
  annotations,
  onClose,
  onEdit,
  onDelete,
}: {
  annotations: ContainerWebAnnotation[];
  onClose: () => void;
  onEdit: (annotation: ContainerWebAnnotation) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <section className="preview-comments-drawer">
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">站点修改意见</h2>
          <p className="mt-0.5 text-xs text-white/40">
            {annotations.length}/{MAX_ANNOTATIONS} 条
          </p>
        </div>
        <button
          type="button"
          aria-label="关闭评论列表"
          onClick={onClose}
          className="preview-icon-button"
        >
          <X size={18} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {annotations.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-6 text-center text-white/45">
            <MessageSquarePlus size={24} />
            <p className="text-sm leading-6">还没有修改意见，关闭列表后点按页面元素即可添加。</p>
          </div>
        ) : (
          <div className="space-y-2">
            {annotations.map((annotation, index) => (
              <div
                key={annotation.id}
                className="flex items-start gap-1 rounded-2xl border border-white/10 bg-white/[0.035] p-2"
              >
                <button
                  type="button"
                  onClick={() => onEdit(annotation)}
                  className="preview-comment-item flex min-h-11 min-w-0 flex-1 items-start gap-3 rounded-xl p-2 text-left hover:bg-white/[0.05]"
                >
                  <span
                    className={cn(
                      "preview-anchor-dot static shrink-0 translate-x-0 translate-y-0",
                      annotation.missing && "preview-anchor-dot-missing",
                    )}
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="preview-accent-text block truncate text-xs font-medium">
                      {annotation.target.selector}
                    </span>
                    <span className="mt-1 line-clamp-3 block text-sm leading-5 text-white/70">
                      {annotation.comment}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`删除评论 ${index + 1}`}
                  onClick={() => onDelete(annotation.id)}
                  className="preview-icon-button preview-delete-button"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="border-t border-white/10 px-4 py-3 text-xs leading-5 text-white/35">
        点击条目可修改内容；点击右上角「加入输入框」即可带回对话让 AI 改码并重新发布。
      </p>
    </section>
  );
}

function targetOverlayStyle(
  target: ContainerPreviewElementTarget,
  viewport: ContainerPreviewViewport,
) {
  const left = Math.max(0, Math.min(100, (target.bounds.x / viewport.width) * 100));
  const top = Math.max(0, Math.min(100, (target.bounds.y / viewport.height) * 100));
  const width = Math.max(1.5, Math.min(100 - left, (target.bounds.width / viewport.width) * 100));
  const height = Math.max(1.5, Math.min(100 - top, (target.bounds.height / viewport.height) * 100));
  return { left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` };
}
