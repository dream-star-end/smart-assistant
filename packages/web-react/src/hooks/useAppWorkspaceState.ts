import { useCallback, useState } from "react";
import type { AuthMode } from "../components/AuthGate";
import { TASKBOARD_ENABLED } from "../lib/taskboardFeature";
import type { Session, UserSiteItem } from "../lib/types";
import {
  readLocationRoute,
  parseSessionPath,
  parseProjectPath,
  parseSitesPath,
  parseBoardView,
  preferredBoardView,
  parseBoardTicket,
  parseBoardTicketType,
  type BoardViewParam,
  type ProjectRoute,
} from "./useAppRoute";

/** Route-derived workspace state; read location on every render, not just mount. */
export function useAppWorkspaceState() {
  // P7 最小路由（无路由库）：特判页（demo / reset-password / desktop/enroll）与启动深链
  // （会话 /s/<id> + 面板 ?panel=）的解析见 readLocationRoute；此后 URL 是状态的 replaceState 单向镜像。
  const urlRoute = readLocationRoute(location);
  const { params, demo, resetToken, desktopEnroll, studio, routingEnabled } = urlRoute;
  // 会话深链恢复未决标记：resolve 前 useSessionList 暂停"自动选中上次会话"
  // （URL 指定 > 最近会话）；resolve/放弃后置 null。
  const [pendingRouteSession, setPendingRouteSession] = useState<string | null>(() =>
    routingEnabled ? parseSessionPath(location.pathname) : null,
  );
  // 任务面板是并列工作区（整段替换 <main>），不是管理中心 Tab。boot 自 /board。
  const [boardOpen, setBoardOpenState] = useState(
    () => TASKBOARD_ENABLED && routingEnabled && location.pathname === "/board",
  );
  const hasSiteInvite = Boolean(params.get("siteInvite")?.trim());
  // 站点工作区（/sites 或 /sites/<slug>）：并列工作区，取代原 ManageCenter 弹窗 Tab。
  const [sitesOpen, setSitesOpenState] = useState(
    () => routingEnabled && (parseSitesPath(location.pathname) !== null || hasSiteInvite),
  );
  const [activeSiteSlug, setActiveSiteSlug] = useState<string | null>(() =>
    routingEnabled ? (parseSitesPath(location.pathname)?.slug ?? null) : null,
  );
  // 项目主页(/p/<id>[/<tab>])：第三个并列工作区。null = 不在项目主页。
  const [projectHome, setProjectHome] = useState<ProjectRoute | null>(null);
  // 启动深链 /p/<id> 的未决目标：等项目列表到达再打开(useAppRoute),不存在则回 /。
  const [pendingRouteProject, setPendingRouteProject] = useState<ProjectRoute | null>(() =>
    routingEnabled ? parseProjectPath(location.pathname) : null,
  );
  // 所有「去对话 / 去任务面板 / 去站点」的入口都经这里：切工作区即离开其余并列工作区。
  // 用户主动导航也作废未决的 /p/<id> 深链恢复(否则列表迟到后会把人拽回项目主页)。
  const setBoardOpen = useCallback((open: boolean) => {
    setBoardOpenState(open);
    setSitesOpenState(false);
    setActiveSiteSlug(null);
    setProjectHome(null);
    setPendingRouteProject(null);
  }, []);
  const openSites = useCallback((slug: string | null = null) => {
    setSitesOpenState(true);
    setActiveSiteSlug(slug);
    setBoardOpenState(false);
    setProjectHome(null);
    setPendingRouteProject(null);
  }, []);
  const [boardView, setBoardView] = useState<BoardViewParam>(() =>
    routingEnabled ? parseBoardView(params, preferredBoardView()) : preferredBoardView(),
  );
  const [boardTicketId, setBoardTicketId] = useState<string | null>(() =>
    routingEnabled ? parseBoardTicket(params) : null,
  );
  const [boardTicketType, setBoardTicketType] = useState(() =>
    routingEnabled ? parseBoardTicketType(params) : null,
  );
  // 视图态：home=营销首页,app=登录页/工作区。启动静默续期成功（useAuth onBootAuthed）
  // 直接置 app,失败停在 home。
  const [view, setView] = useState<"home" | "app">(
    resetToken || desktopEnroll || hasSiteInvite ? "app" : "home",
  );
  // AuthGate 初始模式：「免费开始」=register，顶栏「登录」=login，重置链接=reset。
  const [authMode, setAuthMode] = useState<AuthMode>(resetToken ? "reset" : "login");
  return {
    urlRoute, params, demo, resetToken, desktopEnroll, studio, routingEnabled,
    pendingRouteSession, setPendingRouteSession, boardOpen, setBoardOpen, setBoardOpenState,
    sitesOpen, setSitesOpenState, activeSiteSlug, setActiveSiteSlug, openSites,
    projectHome, setProjectHome, pendingRouteProject, setPendingRouteProject, boardView, setBoardView,
    boardTicketId, setBoardTicketId, boardTicketType, setBoardTicketType, view,
    setView, authMode, setAuthMode,
  };
}

export function resolveSiteEditTarget(
  site: UserSiteItem,
  sessions: readonly Session[],
  customPrompt?: string,
): { sessionId: string | null; prompt: string } {
  const isOwner = (site.accessRole ?? "owner") === "owner";
  const rawOrigin = isOwner ? (site.originSessionId ?? "") : "";
  const peerId = rawOrigin.includes(":dm:") ? rawOrigin.split(":dm:").pop()! : rawOrigin;
  const match = peerId
    ? sessions.find((s) => s.id === peerId || s.id === rawOrigin)
    : undefined;
  if (customPrompt) {
    return {
      sessionId: match?.id ?? null,
      prompt: customPrompt,
    };
  }
  if (!isOwner) {
    return {
      sessionId: null,
      prompt: `请协同开发站点「${site.title}」（slug: ${site.slug}）。如当前工作区尚未拉取该站点文件，请先运行 \`oc-site pull ${site.slug} ./${site.slug}\` 获取最新线上代码，完成修改后运行 \`oc-site publish ./${site.slug} --slug ${site.slug}\` 重新发布：`,
    };
  }
  return {
    sessionId: match?.id ?? null,
    prompt: match
      ? `请继续修改已部署的站点「${site.title}」（${site.slug}）：`
      : `请修改并重新发布已部署的站点「${site.title}」（slug: ${site.slug}，如需先拉取线上文件可运行 \`oc-site pull ${site.slug} ./${site.slug}\`）：`,
  };
}
