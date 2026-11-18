import { useCallback, useState } from "react";
import type { AuthMode } from "../components/AuthGate";
import { TASKBOARD_ENABLED } from "../lib/taskboardFeature";
import { readLocationRoute, parseSessionPath, parseProjectPath, parseBoardView, preferredBoardView, parseBoardTicket, parseBoardTicketType, type BoardViewParam, type ProjectRoute } from "./useAppRoute";

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
  // 项目主页(/p/<id>[/<tab>])：第三个并列工作区。null = 不在项目主页。
  const [projectHome, setProjectHome] = useState<ProjectRoute | null>(null);
  // 启动深链 /p/<id> 的未决目标：等项目列表到达再打开(useAppRoute),不存在则回 /。
  const [pendingRouteProject, setPendingRouteProject] = useState<ProjectRoute | null>(() =>
    routingEnabled ? parseProjectPath(location.pathname) : null,
  );
  // 所有「去对话 / 去任务面板」的入口都经这里：切工作区即离开项目主页。
  // 用户主动导航也作废未决的 /p/<id> 深链恢复(否则列表迟到后会把人拽回项目主页)。
  const setBoardOpen = useCallback((open: boolean) => {
    setBoardOpenState(open);
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
  const [view, setView] = useState<"home" | "app">(resetToken || desktopEnroll ? "app" : "home");
  // AuthGate 初始模式：「免费开始」=register，顶栏「登录」=login，重置链接=reset。
  const [authMode, setAuthMode] = useState<AuthMode>(resetToken ? "reset" : "login");
  return {
    urlRoute, params, demo, resetToken, desktopEnroll, studio, routingEnabled,
    pendingRouteSession, setPendingRouteSession, boardOpen, setBoardOpen, setBoardOpenState, projectHome,
    setProjectHome, pendingRouteProject, setPendingRouteProject, boardView, setBoardView,
    boardTicketId, setBoardTicketId, boardTicketType, setBoardTicketType, view,
    setView, authMode, setAuthMode,
  };
}
