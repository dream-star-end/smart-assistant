import { describe, test, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { SWARM_BOARD_TOOL_NAME, type SwarmSnapshot } from "@openclaude/protocol/browser";
import { api, AuthEpochStaleError } from "../lib/api";
import { createMemoryAuthSession } from "../lib/authSession";
import type { ChatMessage } from "../lib/chat/model";
import { EMPTY_COLLAB_UI } from "../lib/collaborationConfig";
import type { PrefsView } from "../lib/modelPreferences";
import { captureIdentityAttempt, resolveIdentity, type ResolvedIdentity } from "../lib/resolvedIdentity";
import {
  clearSessionSwarmMode,
  readDefaultSwarmMode,
  readSessionSwarmMode,
  swarmModeDefaultKey,
  swarmModeSessionKey,
  writeDefaultSwarmMode,
  writeSessionSwarmMode,
} from "../lib/sessionSwarmMode";
import type { AuthSession, Session, User } from "../lib/types";
import { useComposerSend } from "./useComposerSend";
import { usePersistDefaultSwarmMode, useSwarmMode } from "./useSwarmUi";

const MODELS = [
  { id: "antigravity-gemini-4-neon", engine: "antigravity", name: "Gemini 4 Neon" },
  { id: "gpt-6.2-astra", engine: "codex", name: "GPT 6.2 Astra" },
] as const;

function makeSwarmMsg(phase: SwarmSnapshot["phase"] = "running"): ChatMessage {
  const snapshot: SwarmSnapshot = {
    swarmId: "7474cf40-399d-415c-a951-6713ce671aef",
    title: "Wave 4 蜂群",
    phase,
    revision: 10,
    updatedAt: 1_700_000_000_000,
    members: [{ name: "coordinator", role: "coordinator", status: phase === "running" ? "working" : "waiting", stepCount: 5, unreadCount: 0 }],
    channels: [{ name: "main", memberCount: 1, postCount: 1 }],
    posts: [{ seq: 1, agent: "coordinator", text: "启动", channel: "main", mentions: [] }],
    totalPosts: 1,
  };
  return {
    id: "m-swarm-1",
    role: "tool",
    text: SWARM_BOARD_TOOL_NAME,
    ts: 1_700_000_000_000,
    toolName: SWARM_BOARD_TOOL_NAME,
    _swarmSnapshot: snapshot,
  };
}

describe("OCV5-837: sessionSwarmMode persistence & useSwarmMode", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("persists explicit toggle across remount/reload and clears on session delete", () => {
    const { result, unmount } = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "s-persist",
        activeSessionId: "s-persist",
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    expect(result.current.swarmSupported).toBe(true);
    expect(result.current.swarmMode).toBe(false);

    act(() => result.current.toggleSwarmMode());
    expect(result.current.swarmMode).toBe(true);
    expect(localStorage.getItem(swarmModeSessionKey("s-persist"))).toBe("1");
    expect(readSessionSwarmMode("s-persist")).toBe(true);

    // Simulate reload / returning from mobile background with fresh hook mount
    unmount();
    const remounted = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "s-persist",
        activeSessionId: "s-persist",
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    expect(remounted.result.current.swarmMode).toBe(true);

    // Deleting session clears key and resets to default false
    act(() => clearSessionSwarmMode("s-persist"));
    expect(localStorage.getItem(swarmModeSessionKey("s-persist"))).toBeNull();
    expect(remounted.result.current.swarmMode).toBe(false);
    remounted.unmount();
  });

  test("auto-enables for sessions that already have a SwarmBoard card unless user explicitly toggled off", () => {
    const swarmMessages = [makeSwarmMsg()];
    const { result, unmount } = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "s-active-swarm",
        activeSessionId: "s-active-swarm",
        wsMessages: swarmMessages,
        messagesVersion: 1,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    // No localStorage key yet, but session has SwarmBoard -> button stays active!
    expect(readSessionSwarmMode("s-active-swarm")).toBeUndefined();
    expect(result.current.swarmMode).toBe(true);

    // Explicit off writes "0" and stays off even after reload with SwarmBoard still in history
    act(() => result.current.toggleSwarmMode());
    expect(result.current.swarmMode).toBe(false);
    expect(readSessionSwarmMode("s-active-swarm")).toBe(false);

    unmount();
    const remounted = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "s-active-swarm",
        activeSessionId: "s-active-swarm",
        wsMessages: swarmMessages,
        messagesVersion: 1,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    expect(remounted.result.current.swarmMode).toBe(false);
    remounted.unmount();
  });

  test("syncs same-tab writeSessionSwarmMode (e.g. /swarm slash send) and keeps drafts out of localStorage", () => {
    const draft = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "draft-1",
        activeSessionId: undefined,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    act(() => draft.result.current.toggleSwarmMode());
    expect(draft.result.current.swarmMode).toBe(true);
    expect(localStorage.length).toBe(0);
    draft.unmount();

    const active = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "s-slash",
        activeSessionId: "s-slash",
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    expect(active.result.current.swarmMode).toBe(false);
    act(() => writeSessionSwarmMode("s-slash", true));
    expect(active.result.current.swarmMode).toBe(true);
    active.unmount();
  });

  test("preserves draft swarm toggle when the same draftSessionId is materialized before first send (Goal/GitHub)", () => {
    const { result, rerender, unmount } = renderHook(
      ({ activeSessionId }: { activeSessionId?: string }) =>
        useSwarmMode({
          demo: false,
          sessionKey: activeSessionId ?? "draft-mat-1",
          activeSessionId,
          modelId: "antigravity-gemini-4-neon",
          models: [...MODELS],
        }),
      { initialProps: { activeSessionId: undefined as string | undefined } },
    );
    act(() => result.current.toggleSwarmMode());
    expect(result.current.swarmMode).toBe(true);
    expect(localStorage.length).toBe(0);

    // Goal/GitHub binding materializes the draft under the same id before first send
    rerender({ activeSessionId: "draft-mat-1" });
    expect(result.current.swarmMode).toBe(true);
    expect(readSessionSwarmMode("draft-mat-1")).toBe(true);
    unmount();
  });

  test("OCV5-843: setSwarmMode sets explicit boolean for both persisted sessions and drafts", () => {
    const persisted = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "s-explicit",
        activeSessionId: "s-explicit",
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    act(() => persisted.result.current.setSwarmMode(true));
    expect(persisted.result.current.swarmMode).toBe(true);
    expect(readSessionSwarmMode("s-explicit")).toBe(true);
    act(() => persisted.result.current.setSwarmMode(true));
    expect(persisted.result.current.swarmMode).toBe(true);
    act(() => persisted.result.current.setSwarmMode(false));
    expect(persisted.result.current.swarmMode).toBe(false);
    expect(readSessionSwarmMode("s-explicit")).toBe(false);
    persisted.unmount();

    const draft = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "draft-explicit",
        activeSessionId: undefined,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    act(() => draft.result.current.setSwarmMode(true));
    expect(draft.result.current.swarmMode).toBe(true);
    act(() => draft.result.current.setSwarmMode(false));
    expect(draft.result.current.swarmMode).toBe(false);
    draft.unmount();
  });

  test("does NOT auto-enable swarmMode for historical terminal SwarmBoard cards across devices", () => {
    for (const phase of ["completed", "interrupted", "error"] as const) {
      const { result, unmount } = renderHook(() =>
        useSwarmMode({
          demo: false,
          sessionKey: `s-hist-${phase}`,
          activeSessionId: `s-hist-${phase}`,
          wsMessages: [makeSwarmMsg(phase)],
          messagesVersion: 1,
          modelId: "antigravity-gemini-4-neon",
          models: [...MODELS],
        }),
      );
      expect(readSessionSwarmMode(`s-hist-${phase}`)).toBeUndefined();
      expect(result.current.swarmMode).toBe(false);
      unmount();
    }
  });
});

describe("OCV5-927: account-scoped & server-synced swarmMode default persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  test("persists draft selection across reload, draftSessionId regeneration, and new sessions for authenticated user", () => {
    const onPersist = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ sessionKey }: { sessionKey: string }) =>
        useSwarmMode({
          demo: false,
          sessionKey,
          activeSessionId: undefined,
          userId: "u3",
          onPersistDefaultSwarmMode: onPersist,
          modelId: "antigravity-gemini-4-neon",
          models: [...MODELS],
        }),
      { initialProps: { sessionKey: "draft-a" } },
    );

    expect(result.current.swarmMode).toBe(false);
    act(() => result.current.setSwarmMode(true));
    expect(result.current.swarmMode).toBe(true);
    expect(localStorage.getItem(swarmModeDefaultKey("u3"))).toBe("1");
    expect(onPersist).toHaveBeenCalledWith(true);

    // Regenerating draftSessionId (e.g. userId/agentId change) preserves swarmMode
    rerender({ sessionKey: "draft-b" });
    expect(result.current.swarmMode).toBe(true);

    // Full page reload / opening a fresh new session inherits true immediately
    unmount();
    const fresh = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "draft-c",
        activeSessionId: undefined,
        userId: "u3",
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    expect(fresh.result.current.swarmMode).toBe(true);

    // Explicitly toggling back to solo updates account default to false
    act(() => fresh.result.current.setSwarmMode(false));
    expect(fresh.result.current.swarmMode).toBe(false);
    expect(readDefaultSwarmMode("u3")).toBe(false);
    fresh.unmount();
  });

  test("hydrates from server defaultSwarmMode across devices/origins and protects fresh local clicks from stale GET", () => {
    // Device B / fresh trycloudflare origin: empty localStorage, server returns default_swarm_mode=true
    const { result, rerender, unmount } = renderHook(
      ({ defaultSwarmMode }: { defaultSwarmMode?: boolean }) =>
        useSwarmMode({
          demo: false,
          sessionKey: "draft-remote",
          activeSessionId: undefined,
          userId: "u3",
          defaultSwarmMode,
          modelId: "antigravity-gemini-4-neon",
          models: [...MODELS],
        }),
      { initialProps: { defaultSwarmMode: undefined as boolean | undefined } },
    );
    expect(result.current.swarmMode).toBe(false);

    rerender({ defaultSwarmMode: true });
    expect(result.current.swarmMode).toBe(true);
    expect(readDefaultSwarmMode("u3")).toBe(true);
    unmount();

    // Fresh local click before stale boot GET finishes must NOT be overwritten
    localStorage.clear();
    const race = renderHook(
      ({ defaultSwarmMode }: { defaultSwarmMode?: boolean }) =>
        useSwarmMode({
          demo: false,
          sessionKey: "draft-race",
          activeSessionId: undefined,
          userId: "u3",
          defaultSwarmMode,
          modelId: "antigravity-gemini-4-neon",
          models: [...MODELS],
        }),
      { initialProps: { defaultSwarmMode: undefined as boolean | undefined } },
    );
    act(() => race.result.current.setSwarmMode(true));
    expect(race.result.current.swarmMode).toBe(true);
    // Late stale GET returns false
    race.rerender({ defaultSwarmMode: false });
    expect(race.result.current.swarmMode).toBe(true);
    expect(readDefaultSwarmMode("u3")).toBe(true);
    race.unmount();
  });

  test("isolates account defaults across different userIds and preserves per-session explicit overrides", () => {
    writeDefaultSwarmMode("u1", true);
    const u2 = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "draft-u2",
        activeSessionId: undefined,
        userId: "u2",
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    expect(u2.result.current.swarmMode).toBe(false);
    u2.unmount();

    // Explicit per-session "0" overrides account default "1"
    writeSessionSwarmMode("s-explicit-solo", false);
    const solo = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "s-explicit-solo",
        activeSessionId: "s-explicit-solo",
        userId: "u1",
        defaultSwarmMode: true,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    expect(solo.result.current.swarmMode).toBe(false);
    solo.unmount();
  });

  test("persistDefault: false (auto-disable on non-Antigravity switch) only disables current session without clearing account default", () => {
    const onPersist = vi.fn();
    writeDefaultSwarmMode("u3", true);
    const { result, unmount } = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "s-auto-off",
        activeSessionId: "s-auto-off",
        userId: "u3",
        defaultSwarmMode: true,
        onPersistDefaultSwarmMode: onPersist,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    expect(result.current.swarmMode).toBe(true);

    act(() => result.current.setSwarmMode(false, { persistDefault: false }));
    expect(result.current.swarmMode).toBe(false);
    expect(readSessionSwarmMode("s-auto-off")).toBe(false);
    expect(readDefaultSwarmMode("u3")).toBe(true);
    expect(onPersist).not.toHaveBeenCalled();
    unmount();
  });

  test("usePersistDefaultSwarmMode coalesces rapid toggles and cancels queued in-flight writes on identity change", async () => {
    let resolveFirst!: () => void;
    let resolveThird!: () => void;
    const calls: Array<{ auth: AuthSession; patch: Record<string, unknown>; identity?: ResolvedIdentity }> = [];
    vi.spyOn(api, "patchPreferences").mockImplementation((auth, patch, identity) => {
      calls.push({ auth, patch, identity });
      if (calls.length === 1) {
        return new Promise((res) => {
          resolveFirst = () => res({ prefs: patch });
        });
      }
      if (calls.length === 3) {
        return new Promise((res) => {
          resolveThird = () => res({ prefs: patch });
        });
      }
      return Promise.resolve({ prefs: patch });
    });

    const makeAuth = (token: string, epoch: number): AuthSession =>
      ({
        snapshot: () => ({ token, epoch }),
        getAccessGeneration: () => 0,
        subscribeAccessGeneration: () => () => {},
      }) as unknown as AuthSession;
    const auth1 = makeAuth("t1", 1);
    const auth2 = makeAuth("t2", 2);
    const id1: ResolvedIdentity = resolveIdentity(captureIdentityAttempt(auth1, "t1"), "u1");
    const id2: ResolvedIdentity = resolveIdentity(captureIdentityAttempt(auth2, "t2"), "u2");
    const authRef = { current: auth1 };
    let prefsState: PrefsView = {};
    const setModelPrefs = (updater: PrefsView | ((p: PrefsView) => PrefsView)) => {
      prefsState = typeof updater === "function" ? updater(prefsState) : updater;
    };

    const { result, rerender, unmount } = renderHook(
      ({ auth, identity }: { auth: AuthSession; identity: ResolvedIdentity }) =>
        usePersistDefaultSwarmMode({
          demo: false,
          auth,
          authRef,
          resolvedIdentity: identity,
          setModelPrefs,
        }),
      { initialProps: { auth: auth1, identity: id1 } },
    );

    // Rapid clicks true -> false -> true coalesce into first PATCH(true) + single trailing PATCH(true)
    act(() => {
      result.current(true);
      result.current(false);
      result.current(true);
    });
    expect(prefsState.default_swarm_mode).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.patch).toEqual({ default_swarm_mode: true });
    expect(calls[0]?.identity).toBe(id1);

    await act(async () => {
      resolveFirst();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.patch).toEqual({ default_swarm_mode: true });
    expect(calls[1]?.identity).toBe(id1);

    // Start a third PATCH(false) and queue a trailing PATCH(true) while in-flight,
    // then switch identity to u2 BEFORE releasing the third PATCH: queued u1 write must be cancelled.
    act(() => {
      result.current(false);
      result.current(true);
    });
    expect(calls).toHaveLength(3);
    expect(calls[2]?.auth).toBe(auth1);
    expect(calls[2]?.patch).toEqual({ default_swarm_mode: false });

    authRef.current = auth2;
    rerender({ auth: auth2, identity: id2 });
    await act(async () => {
      resolveThird();
      await Promise.resolve();
      await Promise.resolve();
    });
    // No 4th call from u1's cancelled trailing queue
    expect(calls).toHaveLength(3);

    // u2's own toggle proceeds immediately on its fresh queue
    await act(async () => {
      result.current(false);
      await Promise.resolve();
    });
    expect(calls).toHaveLength(4);
    expect(calls[3]?.auth).toBe(auth2);
    expect(calls[3]?.identity).toBe(id2);
    expect(calls[3]?.patch).toEqual({ default_swarm_mode: false });
    unmount();
  });

  test("Blocker 1: api.patchPreferences with identity aborts before sending PATCH if 401 refresh rotates to another account token in same epoch", async () => {
    const auth = createMemoryAuthSession(() => {}, "token-account-A");
    const idA = resolveIdentity(captureIdentityAttempt(auth, "token-account-A"), "uA");
    const sentAuthHeaders: string[] = [];

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/auth/refresh")) {
        return new Response(
          JSON.stringify({
            access_token: "token-account-B",
            access_exp: Math.floor(Date.now() / 1000) + 900,
            remember: true,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.includes("/api/me/preferences")) {
        const hdrs = new Headers(init?.headers);
        sentAuthHeaders.push(hdrs.get("authorization") ?? "");
        return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "expired" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      await expect(
        api.patchPreferences(auth, { default_swarm_mode: true }, idA),
      ).rejects.toThrow(AuthEpochStaleError);
      // Initial attempt used A's verified token; post-refresh replay with B's token was blocked before fetch
      expect(sentAuthHeaders).toEqual(["Bearer token-account-A"]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("Blocker 2: cross-tab storage toggle to solo overrides hydrated server defaultSwarmMode and sends solo frame", async () => {
    writeDefaultSwarmMode("u3", true);
    const sentFrames: Array<Record<string, unknown>> = [];
    const auth = createMemoryAuthSession(() => {}, "tok-u3");
    const authRef = { current: auth };
    const sockRef = {
      current: {
        ensureSession: vi.fn(),
        setSessionModel: vi.fn(),
        send: vi.fn(async (frame: Record<string, unknown>) => {
          sentFrames.push(frame);
          return true;
        }),
        getMessages: vi.fn(() => []),
      },
    };
    const user: User = { id: "u3", email: "u3@test.local", role: "user" } as User;

    const { result, unmount } = renderHook(() => {
      const swarm = useSwarmMode({
        demo: false,
        sessionKey: "draft-tab-b",
        activeSessionId: undefined,
        userId: "u3",
        defaultSwarmMode: true,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      });
      const composer = useComposerSend({
        activeId: undefined,
        agent: { id: "main", name: "Main", avatarEmoji: "🤖", description: "" },
        applyCollabDoc: vi.fn(),
        auth,
        authRef,
        boardOpen: false,
        collabAsDefault: false,
        collabEpochRef: { current: 0 },
        collabUi: EMPTY_COLLAB_UI,
        contextTier: "300k",
        demo: false,
        draftProjectId: null,
        draftProjectRef: { current: null },
        draftSessionId: "draft-tab-b",
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
        newSessionInProject: vi.fn(),
        preferenceEffort: undefined,
        projectHome: null,
        promoteDraftCollab: vi.fn(),
        publicCfg: null,
        queueModelPatch: vi.fn(),
        selectedSessionIdRef: { current: undefined },
        sendImplicitRatingRef: { current: null },
        serviceTier: null,
        sessionEffort: undefined,
        sessions: [],
        setActiveId: vi.fn(),
        setBoardOpen: vi.fn(),
        setBusy: vi.fn(),
        setChatError: vi.fn(),
        setCollabSaveError: vi.fn(),
        setCollabUi: vi.fn(),
        setDraftProject: vi.fn(),
        setImageAnnotationSource: vi.fn(),
        setMessages: vi.fn(),
        setSessions: vi.fn(),
        setStreamText: vi.fn(),
        sockRef: sockRef as never,
        stopPreparing: vi.fn(),
        stopRef: { current: false },
        swarmMode: swarm.swarmMode,
        getSwarmMode: () => swarm.swarmMode,
        toast: vi.fn(),
        user,
      });
      return { swarm, composer };
    });

    expect(result.current.swarm.swarmMode).toBe(true);

    // Tab A switches back to solo -> storage event arrives in Tab B while defaultSwarmMode prop is still true
    act(() => {
      localStorage.setItem(swarmModeDefaultKey("u3"), "0");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: swarmModeDefaultKey("u3"),
          newValue: "0",
          oldValue: "1",
        }),
      );
    });
    expect(result.current.swarm.swarmMode).toBe(false);

    await act(async () => {
      await result.current.composer.send("hello solo");
    });
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]?.swarmMode).toBeUndefined();
    unmount();
  });

  test("Blocker 3: materialized draft (Goal/GitHub before first send) pins first-send solo/swarm mode per-session", async () => {
    const auth = createMemoryAuthSession(() => {}, "tok-mat");
    const authRef = { current: auth };
    const user: User = { id: "u3", email: "u3@test.local", role: "user" } as User;
    const sockRef = {
      current: {
        ensureSession: vi.fn(),
        setSessionModel: vi.fn(),
        renameSession: vi.fn(),
        send: vi.fn(async () => true),
        getMessages: vi.fn(() => []),
      },
    };
    vi.spyOn(api, "patchSessionTitle").mockResolvedValue(undefined as never);

    const makeMaterializedSend = (sessionId: string, swarmOn: boolean) => {
      const matSession: Session = {
        id: sessionId,
        title: "新对话",
        ownerUserId: "u3",
        updatedAt: new Date().toISOString(),
        messageCount: 0,
        modelId: "antigravity-gemini-4-neon",
      };
      return renderHook(() =>
        useComposerSend({
          activeId: sessionId,
          agent: { id: "main", name: "Main", avatarEmoji: "🤖", description: "" },
          applyCollabDoc: vi.fn(),
          auth,
          authRef,
          boardOpen: false,
          collabAsDefault: false,
          collabEpochRef: { current: 0 },
          collabUi: EMPTY_COLLAB_UI,
          contextTier: "300k",
          demo: false,
          draftProjectId: null,
          draftProjectRef: { current: null },
          draftSessionId: "unused",
          modelId: "antigravity-gemini-4-neon",
          models: [...MODELS],
          newSessionInProject: vi.fn(),
          preferenceEffort: undefined,
          projectHome: null,
          promoteDraftCollab: vi.fn(),
          publicCfg: null,
          queueModelPatch: vi.fn(),
          selectedSessionIdRef: { current: sessionId },
          sendImplicitRatingRef: { current: null },
          serviceTier: null,
          sessionEffort: undefined,
          sessions: [matSession],
          setActiveId: vi.fn(),
          setBoardOpen: vi.fn(),
          setBusy: vi.fn(),
          setChatError: vi.fn(),
          setCollabSaveError: vi.fn(),
          setCollabUi: vi.fn(),
          setDraftProject: vi.fn(),
          setImageAnnotationSource: vi.fn(),
          setMessages: vi.fn(),
          setSessions: vi.fn(),
          setStreamText: vi.fn(),
          sockRef: sockRef as never,
          stopPreparing: vi.fn(),
          stopRef: { current: false },
          swarmMode: swarmOn,
          getSwarmMode: () => swarmOn,
          toast: vi.fn(),
          user,
        }),
      );
    };

    // 1. Solo first send on materialized draft writes "0", so enabling account default later won't flip it to swarm
    const soloHook = makeMaterializedSend("s-mat-solo", false);
    await act(async () => {
      await soloHook.result.current.send("first solo message");
    });
    expect(readSessionSwarmMode("s-mat-solo")).toBe(false);
    soloHook.unmount();

    writeDefaultSwarmMode("u3", true);
    const revisitedSolo = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "s-mat-solo",
        activeSessionId: "s-mat-solo",
        userId: "u3",
        defaultSwarmMode: true,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    expect(revisitedSolo.result.current.swarmMode).toBe(false);
    revisitedSolo.unmount();

    // 2. Swarm first send on materialized draft writes "1", so disabling account default later won't flip it to solo
    const swarmHook = makeMaterializedSend("s-mat-swarm", true);
    await act(async () => {
      await swarmHook.result.current.send("first swarm message");
    });
    expect(readSessionSwarmMode("s-mat-swarm")).toBe(true);
    swarmHook.unmount();

    writeDefaultSwarmMode("u3", false);
    const revisitedSwarm = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "s-mat-swarm",
        activeSessionId: "s-mat-swarm",
        userId: "u3",
        defaultSwarmMode: false,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    expect(revisitedSwarm.result.current.swarmMode).toBe(true);
    revisitedSwarm.unmount();
  });

  test("Blocker 4: toggleSwarmMode({ persistDefault: false }) for playbook templates does not alter account default", () => {
    const onPersist = vi.fn();
    const { result, unmount } = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "draft-playbook",
        activeSessionId: undefined,
        userId: "u3",
        defaultSwarmMode: false,
        onPersistDefaultSwarmMode: onPersist,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    expect(result.current.swarmMode).toBe(false);

    act(() => result.current.toggleSwarmMode({ persistDefault: false }));
    expect(result.current.swarmMode).toBe(true);
    expect(readDefaultSwarmMode("u3")).toBe(false);
    expect(onPersist).not.toHaveBeenCalled();
    unmount();

    // Opening a fresh new chat remains solo because playbook never changed account default
    const nextChat = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "draft-after-playbook",
        activeSessionId: undefined,
        userId: "u3",
        defaultSwarmMode: false,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    expect(nextChat.result.current.swarmMode).toBe(false);
    nextChat.unmount();
  });

  test("R2-1: same-account token refresh replays deferred default_swarm_mode PATCH after re-verification, while cross-account switch drops it", async () => {
    const calls: Array<{ patch: Record<string, unknown>; identity?: ResolvedIdentity }> = [];
    vi.spyOn(api, "patchPreferences").mockImplementation((_auth, patch, identity) => {
      calls.push({ patch, identity });
      if (calls.length === 1) {
        return Promise.reject(new AuthEpochStaleError());
      }
      return Promise.resolve({ prefs: patch });
    });

    const auth = createMemoryAuthSession(() => {}, "tok-u1-old");
    const id1Old = resolveIdentity(captureIdentityAttempt(auth, "tok-u1-old"), "u1");
    const authRef = { current: auth };
    let prefsState: PrefsView = { default_swarm_mode: true };
    const setModelPrefs = (updater: PrefsView | ((p: PrefsView) => PrefsView)) => {
      prefsState = typeof updater === "function" ? updater(prefsState) : updater;
    };

    const { result, rerender, unmount } = renderHook(
      ({ identity }: { identity: ResolvedIdentity }) =>
        usePersistDefaultSwarmMode({
          demo: false,
          auth,
          authRef,
          resolvedIdentity: identity,
          setModelPrefs,
        }),
      { initialProps: { identity: id1Old } },
    );

    // User toggles solo (false) right as token refresh invalidates id1Old
    await act(async () => {
      result.current(false);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(prefsState.default_swarm_mode).toBe(false);
    expect(calls).toHaveLength(1);

    // Same account finishes /me re-verification with refreshed token -> deferred PATCH(false) replays!
    auth.commitToken(auth.snapshot().epoch, "tok-u1-refreshed");
    const id1Refreshed = resolveIdentity(captureIdentityAttempt(auth, "tok-u1-refreshed"), "u1");
    await act(async () => {
      rerender({ identity: id1Refreshed });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.patch).toEqual({ default_swarm_mode: false });
    expect(calls[1]?.identity).toBe(id1Refreshed);

    // Now test cross-account switch drops deferred retry instead of writing to account B
    vi.spyOn(api, "patchPreferences").mockImplementationOnce(() => Promise.reject(new AuthEpochStaleError()));
    await act(async () => {
      result.current(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    const nextEpoch = auth.beginIdentity();
    auth.commitToken(nextEpoch, "tok-u2");
    const id2 = resolveIdentity(captureIdentityAttempt(auth, "tok-u2"), "u2");
    await act(async () => {
      rerender({ identity: id2 });
      await Promise.resolve();
      await Promise.resolve();
    });
    // Still only 2 calls on the original spy (plus 1 rejected once-mock); u2 never received u1's deferred true
    expect(calls).toHaveLength(2);
    unmount();
  });

  test("R2-2: sibling tab stale boot GET(true) never overwrites Tab A's fresh solo click or flips Tab A's send frame to swarm", async () => {
    // Tab A starts hydrated with true, then user clicks solo (false) while PATCH is still in-flight
    writeDefaultSwarmMode("u3", true);
    const sentFrames: Array<Record<string, unknown>> = [];
    const auth = createMemoryAuthSession(() => {}, "tok-tab-a");
    const authRef = { current: auth };
    const sockRef = {
      current: {
        ensureSession: vi.fn(),
        setSessionModel: vi.fn(),
        send: vi.fn(async (frame: Record<string, unknown>) => {
          sentFrames.push(frame);
          return true;
        }),
        getMessages: vi.fn(() => []),
      },
    };
    const user: User = { id: "u3", email: "u3@test.local", role: "user" } as User;

    const tabA = renderHook(() => {
      const swarm = useSwarmMode({
        demo: false,
        sessionKey: "draft-tab-a",
        activeSessionId: undefined,
        userId: "u3",
        defaultSwarmMode: true,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      });
      const composer = useComposerSend({
        activeId: undefined,
        agent: { id: "main", name: "Main", avatarEmoji: "🤖", description: "" },
        applyCollabDoc: vi.fn(),
        auth,
        authRef,
        boardOpen: false,
        collabAsDefault: false,
        collabEpochRef: { current: 0 },
        collabUi: EMPTY_COLLAB_UI,
        contextTier: "300k",
        demo: false,
        draftProjectId: null,
        draftProjectRef: { current: null },
        draftSessionId: "draft-tab-a",
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
        newSessionInProject: vi.fn(),
        preferenceEffort: undefined,
        projectHome: null,
        promoteDraftCollab: vi.fn(),
        publicCfg: null,
        queueModelPatch: vi.fn(),
        selectedSessionIdRef: { current: undefined },
        sendImplicitRatingRef: { current: null },
        serviceTier: null,
        sessionEffort: undefined,
        sessions: [],
        setActiveId: vi.fn(),
        setBoardOpen: vi.fn(),
        setBusy: vi.fn(),
        setChatError: vi.fn(),
        setCollabSaveError: vi.fn(),
        setCollabUi: vi.fn(),
        setDraftProject: vi.fn(),
        setImageAnnotationSource: vi.fn(),
        setMessages: vi.fn(),
        setSessions: vi.fn(),
        setStreamText: vi.fn(),
        sockRef: sockRef as never,
        stopPreparing: vi.fn(),
        stopRef: { current: false },
        swarmMode: swarm.swarmMode,
        getSwarmMode: () => swarm.swarmMode,
        toast: vi.fn(),
        user,
      });
      return { swarm, composer };
    });

    act(() => tabA.result.current.swarm.setSwarmMode(false));
    expect(tabA.result.current.swarm.swarmMode).toBe(false);
    expect(readDefaultSwarmMode("u3")).toBe(false);

    // Tab B opens while Tab A's PATCH is still in-flight and boots with stale GET defaultSwarmMode=true
    const tabB = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "draft-tab-b-stale",
        activeSessionId: undefined,
        userId: "u3",
        defaultSwarmMode: true,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );

    // Shared localStorage must remain "0" (Tab B did NOT overwrite it with stale server true),
    // and Tab A must still be solo and send a solo frame!
    expect(readDefaultSwarmMode("u3")).toBe(false);
    expect(tabA.result.current.swarm.swarmMode).toBe(false);

    await act(async () => {
      await tabA.result.current.composer.send("must be solo");
    });
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]?.swarmMode).toBeUndefined();
    tabB.unmount();
    tabA.unmount();
  });

  test("Steward P1: old -> null -> same-account new replays unconfirmed solo PATCH under both failure orders and stays solo after reload", async () => {
    for (const order of ["fail-before-null", "null-before-fail"] as const) {
      localStorage.clear();
      let serverDefaultSwarm = true;
      let rejectFirst!: (err: unknown) => void;
      const calls: Array<{ patch: Record<string, unknown>; identity?: ResolvedIdentity }> = [];
      const spy = vi.spyOn(api, "patchPreferences").mockImplementation((_auth, patch, identity) => {
        calls.push({ patch, identity });
        if (calls.length === 1) {
          if (order === "fail-before-null") {
            return Promise.reject(new AuthEpochStaleError());
          }
          return new Promise((_, reject) => {
            rejectFirst = reject;
          });
        }
        if (typeof patch.default_swarm_mode === "boolean") {
          serverDefaultSwarm = patch.default_swarm_mode;
        }
        return Promise.resolve({ prefs: { default_swarm_mode: serverDefaultSwarm } });
      });

      const auth = createMemoryAuthSession(() => {}, "tok-u1-v1");
      const idOld = resolveIdentity(captureIdentityAttempt(auth, "tok-u1-v1"), "u1");
      const authRef = { current: auth };
      let prefsState: PrefsView = { default_swarm_mode: serverDefaultSwarm };
      const setModelPrefs = (updater: PrefsView | ((p: PrefsView) => PrefsView)) => {
        prefsState = typeof updater === "function" ? updater(prefsState) : updater;
      };

      const { result, rerender, unmount } = renderHook(
        ({ curAuth, identity }: { curAuth: typeof auth | null; identity: ResolvedIdentity | null }) =>
          usePersistDefaultSwarmMode({
            demo: false,
            auth: curAuth,
            authRef,
            resolvedIdentity: identity,
            setModelPrefs,
          }),
        { initialProps: { curAuth: auth as typeof auth | null, identity: idOld as ResolvedIdentity | null } },
      );

      // User turns OFF swarm (high-cost mode -> solo)
      await act(async () => {
        result.current(false);
        await Promise.resolve();
      });
      expect(prefsState.default_swarm_mode).toBe(false);
      expect(calls).toHaveLength(1);

      // Same-account token refresh updates token without bumping epoch; /me hasn't finished so resolvedIdentity becomes null
      auth.commitToken(auth.snapshot().epoch, "tok-u1-v2");
      await act(async () => {
        rerender({ curAuth: auth, identity: null });
        await Promise.resolve();
      });

      if (order === "null-before-fail") {
        await act(async () => {
          rejectFirst(new AuthEpochStaleError());
          await Promise.resolve();
          await Promise.resolve();
        });
      }

      // While resolvedIdentity is null, no PATCH may be dispatched
      expect(calls).toHaveLength(1);
      expect(serverDefaultSwarm).toBe(true);

      // /me completes for the exact same account & epoch -> deferred solo PATCH replays
      const idNew = resolveIdentity(captureIdentityAttempt(auth, "tok-u1-v2"), "u1");
      await act(async () => {
        rerender({ curAuth: auth, identity: idNew });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(calls).toHaveLength(2);
      expect(calls[1]?.patch).toEqual({ default_swarm_mode: false });
      expect(calls[1]?.identity).toBe(idNew);
      expect(serverDefaultSwarm).toBe(false);
      unmount();

      // Simulate full page reload (even on fresh origin with empty localStorage reading server preferences)
      localStorage.clear();
      const reloaded = renderHook(() =>
        useSwarmMode({
          demo: false,
          sessionKey: `draft-reload-${order}`,
          activeSessionId: undefined,
          userId: "u1",
          defaultSwarmMode: serverDefaultSwarm,
          modelId: "antigravity-gemini-4-neon",
          models: [...MODELS],
        }),
      );
      expect(reloaded.result.current.swarmMode).toBe(false);
      reloaded.unmount();
      spy.mockRestore();
    }
  });

  test("Steward P1: toggle during null re-verification window holds latest intent without sending, while logout/account-switch/new-AuthSession drop it", async () => {
    const calls: Array<{ patch: Record<string, unknown>; identity?: ResolvedIdentity }> = [];
    vi.spyOn(api, "patchPreferences").mockImplementation((_auth, patch, identity) => {
      calls.push({ patch, identity });
      return Promise.resolve({ prefs: patch });
    });

    // 1. Toggle during temporary null re-verification window -> held, not dispatched while null, flushed on re-verify
    const auth = createMemoryAuthSession(() => {}, "tok-a1");
    const idA1 = resolveIdentity(captureIdentityAttempt(auth, "tok-a1"), "u1");
    const authRef = { current: auth };
    const setModelPrefs = vi.fn();

    const hook = renderHook(
      ({ curAuth, identity }: { curAuth: typeof auth | null; identity: ResolvedIdentity | null }) =>
        usePersistDefaultSwarmMode({
          demo: false,
          auth: curAuth,
          authRef,
          resolvedIdentity: identity,
          setModelPrefs,
        }),
      { initialProps: { curAuth: auth as typeof auth | null, identity: idA1 as ResolvedIdentity | null } },
    );

    auth.commitToken(auth.snapshot().epoch, "tok-a2");
    await act(async () => {
      hook.rerender({ curAuth: auth, identity: null });
      await Promise.resolve();
    });
    await act(async () => {
      hook.result.current(true);
      hook.result.current(false);
      await Promise.resolve();
    });
    expect(calls).toHaveLength(0);

    const idA2 = resolveIdentity(captureIdentityAttempt(auth, "tok-a2"), "u1");
    await act(async () => {
      hook.rerender({ curAuth: auth, identity: idA2 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.patch).toEqual({ default_swarm_mode: false });
    expect(calls[0]?.identity).toBe(idA2);

    // 2. Explicit logout drops pending intent even if the same userId logs back in with a new epoch
    auth.commitToken(auth.snapshot().epoch, "tok-a3");
    await act(async () => {
      hook.rerender({ curAuth: auth, identity: null });
      hook.result.current(true);
      await Promise.resolve();
    });
    const reloginEpoch = auth.beginIdentity();
    await act(async () => {
      hook.rerender({ curAuth: null, identity: null });
      await Promise.resolve();
    });
    auth.commitToken(reloginEpoch, "tok-a-relogin");
    const idARelogin = resolveIdentity(captureIdentityAttempt(auth, "tok-a-relogin"), "u1");
    await act(async () => {
      hook.rerender({ curAuth: auth, identity: idARelogin });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls).toHaveLength(1);

    // 3. Cross-account switch through null drops pending intent (never leaks to account B)
    auth.commitToken(auth.snapshot().epoch, "tok-a-stale");
    await act(async () => {
      hook.rerender({ curAuth: auth, identity: null });
      hook.result.current(true);
      await Promise.resolve();
    });
    const switchEpoch = auth.beginIdentity();
    auth.commitToken(switchEpoch, "tok-u2");
    const idB = resolveIdentity(captureIdentityAttempt(auth, "tok-u2"), "u2");
    await act(async () => {
      hook.rerender({ curAuth: auth, identity: idB });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls).toHaveLength(1);

    // 4. Replacing AuthSession instance drops pending intent even if userId/epoch happen to match
    auth.commitToken(auth.snapshot().epoch, "tok-u2-refresh");
    await act(async () => {
      hook.rerender({ curAuth: auth, identity: null });
      hook.result.current(true);
      await Promise.resolve();
    });
    const auth2 = createMemoryAuthSession(() => {}, "tok-u2-other-session");
    authRef.current = auth2;
    const idB2 = resolveIdentity(captureIdentityAttempt(auth2, "tok-u2-other-session"), "u2");
    await act(async () => {
      hook.rerender({ curAuth: auth2, identity: idB2 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls).toHaveLength(1);
    hook.unmount();
  });

  test("Steward P1 R2: late-resolving old PATCH(true) across same-account old -> null -> new never overlaps with PATCH(false) and preserves false on server & reload", async () => {
    localStorage.clear();
    let serverDefaultSwarm = false;
    let inFlightCount = 0;
    let maxConcurrent = 0;
    let resolveFirst!: () => void;
    const calls: Array<{ patch: Record<string, unknown>; identity?: ResolvedIdentity }> = [];

    const spy = vi.spyOn(api, "patchPreferences").mockImplementation((_auth, patch, identity) => {
      calls.push({ patch, identity });
      inFlightCount += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlightCount);
      if (calls.length === 1) {
        return new Promise((resolve) => {
          resolveFirst = () => {
            if (typeof patch.default_swarm_mode === "boolean") {
              serverDefaultSwarm = patch.default_swarm_mode;
            }
            inFlightCount -= 1;
            resolve({ prefs: { default_swarm_mode: serverDefaultSwarm } });
          };
        });
      }
      if (typeof patch.default_swarm_mode === "boolean") {
        serverDefaultSwarm = patch.default_swarm_mode;
      }
      inFlightCount -= 1;
      return Promise.resolve({ prefs: { default_swarm_mode: serverDefaultSwarm } });
    });

    const auth = createMemoryAuthSession(() => {}, "tok-serial-1");
    const idOld = resolveIdentity(captureIdentityAttempt(auth, "tok-serial-1"), "u1");
    const authRef = { current: auth };
    let prefsState: PrefsView = { default_swarm_mode: false };
    const setModelPrefs = (updater: PrefsView | ((p: PrefsView) => PrefsView)) => {
      prefsState = typeof updater === "function" ? updater(prefsState) : updater;
    };

    const { result, rerender, unmount } = renderHook(
      ({ curAuth, identity }: { curAuth: typeof auth | null; identity: ResolvedIdentity | null }) =>
        usePersistDefaultSwarmMode({
          demo: false,
          auth: curAuth,
          authRef,
          resolvedIdentity: identity,
          setModelPrefs,
        }),
      { initialProps: { curAuth: auth as typeof auth | null, identity: idOld as ResolvedIdentity | null } },
    );

    // 1. User enables swarm -> PATCH(true) is in-flight; then user immediately disables swarm (false)
    await act(async () => {
      result.current(true);
      result.current(false);
      await Promise.resolve();
    });
    expect(prefsState.default_swarm_mode).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.patch).toEqual({ default_swarm_mode: true });
    expect(inFlightCount).toBe(1);

    // 2. Same-account token refresh transitions resolvedIdentity: idOld -> null -> idNew while PATCH(true) is still in-flight!
    auth.commitToken(auth.snapshot().epoch, "tok-serial-2");
    await act(async () => {
      rerender({ curAuth: auth, identity: null });
      await Promise.resolve();
    });
    const idNew = resolveIdentity(captureIdentityAttempt(auth, "tok-serial-2"), "u1");
    await act(async () => {
      rerender({ curAuth: auth, identity: idNew });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Single-writer barrier MUST hold: PATCH(false) must NOT fire concurrently with in-flight PATCH(true)
    expect(calls).toHaveLength(1);
    expect(maxConcurrent).toBe(1);

    // 3. Old PATCH(true) resolves LATE and writes true to server -> queue immediately serializes PATCH(false) with idNew
    await act(async () => {
      resolveFirst();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(maxConcurrent).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.patch).toEqual({ default_swarm_mode: false });
    expect(calls[1]?.identity).toBe(idNew);
    expect(serverDefaultSwarm).toBe(false);
    unmount();

    // 4. Rehydrate after page reload (empty localStorage reading server prefs) -> stays false
    localStorage.clear();
    const reloaded = renderHook(() =>
      useSwarmMode({
        demo: false,
        sessionKey: "draft-reload-serial",
        activeSessionId: undefined,
        userId: "u1",
        defaultSwarmMode: serverDefaultSwarm,
        modelId: "antigravity-gemini-4-neon",
        models: [...MODELS],
      }),
    );
    expect(reloaded.result.current.swarmMode).toBe(false);
    reloaded.unmount();
    spy.mockRestore();
  });
});
