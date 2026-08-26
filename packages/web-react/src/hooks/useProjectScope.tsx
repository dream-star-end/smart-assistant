import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { taskboardApi, type Project } from "../lib/taskboard";
import {
  parseProjectScopeToken,
  preferredScopeToken,
  projectScopeSelectOptions,
  projectScopeStorageKey,
  resolveProjectScope,
  withProjectParam,
  type ChatProjectLike,
  type ProjectScopeToken,
  type ResolvedProjectScope,
  type WorkProjectLike,
} from "../lib/projectScope";
import type { AuthSession } from "../lib/types";

type ProjectScopeContextValue = {
  scope: ResolvedProjectScope;
  token: ProjectScopeToken;
  setToken: (token: ProjectScopeToken) => void;
  workProjects: WorkProjectLike[];
  chatProjects: ChatProjectLike[];
  selectOptions: { value: string; label: string; disabled?: boolean }[];
  loading: boolean;
  refreshWorkProjects: () => Promise<WorkProjectLike[]>;
};

const ProjectScopeContext = createContext<ProjectScopeContextValue | null>(null);

function readStoredToken(userId: string | undefined): ProjectScopeToken | null {
  if (!userId || typeof localStorage === "undefined") return null;
  try {
    return parseProjectScopeToken(localStorage.getItem(projectScopeStorageKey(userId)));
  } catch {
    return null;
  }
}

function writeStoredToken(userId: string | undefined, token: ProjectScopeToken): void {
  if (!userId || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(projectScopeStorageKey(userId), token);
  } catch {
    /* quota / private mode */
  }
}

function tokenFromLocation(): ProjectScopeToken | null {
  if (typeof window === "undefined") return null;
  return parseProjectScopeToken(new URLSearchParams(window.location.search).get("project"));
}

function replaceProjectQuery(token: ProjectScopeToken): void {
  if (typeof window === "undefined") return;
  const next = withProjectParam(new URLSearchParams(window.location.search), token);
  const q = next.toString();
  const href = `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`;
  if (href !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    history.replaceState({}, "", href);
  }
}

export function ProjectScopeProvider({
  auth,
  chatProjects,
  userId,
  children,
}: {
  auth: AuthSession | null;
  chatProjects: readonly ChatProjectLike[];
  userId?: string;
  children: ReactNode;
}) {
  const [workProjects, setWorkProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [token, setTokenState] = useState<ProjectScopeToken>(() => tokenFromLocation() ?? "all");
  const refreshEpoch = useRef(0);

  const refreshWorkProjects = useCallback(async (): Promise<Project[]> => {
    const request = (refreshEpoch.current += 1);
    if (!auth) {
      setWorkProjects([]);
      setLoading(false);
      return [];
    }
    setLoading(true);
    try {
      const rows = await taskboardApi.listProjects(auth);
      if (refreshEpoch.current === request) setWorkProjects(rows);
      return rows;
    } catch {
      if (refreshEpoch.current === request) setWorkProjects([]);
      return [];
    } finally {
      if (refreshEpoch.current === request) setLoading(false);
    }
  }, [auth]);

  useEffect(() => {
    void refreshWorkProjects();
    return () => {
      refreshEpoch.current += 1;
    };
  }, [refreshWorkProjects]);

  useEffect(() => {
    const fromUrl = tokenFromLocation();
    if (fromUrl) {
      setTokenState(fromUrl);
      return;
    }
    const stored = readStoredToken(userId);
    if (stored) setTokenState(stored);
  }, [userId]);

  useEffect(() => {
    const onPop = () => {
      const fromUrl = tokenFromLocation();
      if (fromUrl) setTokenState(fromUrl);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const scope = useMemo(
    () =>
      resolveProjectScope({
        token,
        chatProjects,
        workProjects,
      }),
    [token, chatProjects, workProjects],
  );

  const setToken = useCallback(
    (next: ProjectScopeToken) => {
      setTokenState(next);
      writeStoredToken(userId, next);
      replaceProjectQuery(next);
    },
    [userId],
  );

  useEffect(() => {
    const preferred = preferredScopeToken(scope);
    if (scope.invalid && token !== "all") {
      setToken("all");
      return;
    }
    if (preferred !== token && scope.kind === "work") {
      setTokenState(preferred);
      replaceProjectQuery(preferred);
    }
  }, [scope, token, setToken]);

  const selectOptions = useMemo(
    () => projectScopeSelectOptions({ chatProjects, workProjects }),
    [chatProjects, workProjects],
  );

  const value = useMemo<ProjectScopeContextValue>(
    () => ({
      scope,
      token: preferredScopeToken(scope),
      setToken,
      workProjects,
      chatProjects: [...chatProjects],
      selectOptions,
      loading,
      refreshWorkProjects,
    }),
    [scope, setToken, workProjects, chatProjects, selectOptions, loading, refreshWorkProjects],
  );

  return <ProjectScopeContext.Provider value={value}>{children}</ProjectScopeContext.Provider>;
}

export function useProjectScope(): ProjectScopeContextValue {
  const ctx = useContext(ProjectScopeContext);
  if (!ctx) {
    return {
      scope: resolveProjectScope({ token: "all", chatProjects: [], workProjects: [] }),
      token: "all",
      setToken: () => {},
      workProjects: [],
      chatProjects: [],
      selectOptions: projectScopeSelectOptions({ chatProjects: [], workProjects: [] }),
      loading: false,
      refreshWorkProjects: async () => [],
    };
  }
  return ctx;
}
