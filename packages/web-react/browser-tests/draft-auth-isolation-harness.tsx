// Real useAuth.login/logout + real Composer + production accountDraftKey.
// Network is stubbed only at fetch for synthetic identities. No live credentials.
import { createRoot } from "react-dom/client";
import { Composer } from "../src/components/Composer";
import { ToastProvider, TooltipProvider } from "../src/components/ui";
import { useAuth } from "../src/hooks/useAuth";
import * as composerDraft from "../src/lib/composerDraft";

const PREFIX = "oc_v5_composer_draft:";
const NEW_KEY = composerDraft.NEW_COMPOSER_DRAFT_KEY;

type DraftModule = typeof composerDraft & {
  accountDraftKey?: (sessionKey: string, accountId?: string | null) => string;
};

/** Use production namespacing when exported; 87d has none, so session keys stay unscoped. */
function accountDraftKey(sessionKey: string, accountId?: string | null): string {
  const fn = (composerDraft as DraftModule).accountDraftKey;
  if (typeof fn === "function") return fn(sessionKey, accountId);
  return sessionKey;
}

type AuthFetch = { url: string; method: string; email?: string };

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function installAuthFetchStub(): void {
  const fetches: AuthFetch[] = [];
  (window as unknown as { __authFetches: AuthFetch[] }).__authFetches = fetches;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/api/auth/login")) {
      const body = init?.body ? JSON.parse(String(init.body)) as { email?: string } : {};
      const email = body.email ?? "";
      fetches.push({ url, method, email });
      const id = email.startsWith("a@") ? "user-a" : email.startsWith("b@") ? "user-b" : "user-unknown";
      return new Response(
        JSON.stringify({
          user: {
            id,
            email,
            display_name: email,
            role: "user",
            email_verified: true,
            credits: "0",
          },
          access_token: `synthetic-access-${id}`,
          access_exp: Math.floor(Date.now() / 1000) + 3600,
          refresh_exp: Math.floor(Date.now() / 1000) + 86400,
          remember: true,
          lane: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/auth/logout")) {
      fetches.push({ url, method });
      return new Response(null, { status: 204 });
    }
    fetches.push({ url, method });
    return new Response(`unexpected fetch ${method} ${url}`, { status: 599 });
  };
}

installAuthFetchStub();

(window as unknown as { __draftAuthProbe: object }).__draftAuthProbe = {
  readDraft: composerDraft.readDraft,
  accountDraftKey,
  newKey: NEW_KEY,
  prefix: PREFIX,
  sessionItem(key: string): string | null {
    try {
      return sessionStorage.getItem(PREFIX + key);
    } catch {
      return null;
    }
  },
  allDraftStorageKeys(): string[] {
    const keys: string[] = [];
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k?.startsWith(PREFIX)) keys.push(k);
      }
    } catch {
      /* ignore */
    }
    return keys.sort();
  },
};

function Harness() {
  const auth = useAuth({
    demo: false,
    initialUser: null,
    onClearAuth: () => {
      /* chat-domain only; must not call teardownComposerDrafts or setAccount */
    },
  });
  const draftKey = auth.authed && auth.user
    ? accountDraftKey(NEW_KEY, auth.user.id)
    : undefined;

  return (
    <TooltipProvider>
      <ToastProvider>
        <button
          type="button"
          onClick={() => {
            void auth.login("a@example.test", "synthetic-password-a", "bypass");
          }}
        >
          login A
        </button>
        <button
          type="button"
          onClick={() => {
            void auth.login("b@example.test", "synthetic-password-b", "bypass");
          }}
        >
          login B
        </button>
        <button type="button" onClick={() => auth.logout()}>
          logout
        </button>
        <output data-testid="account">{auth.user?.id ?? ""}</output>
        <output data-testid="authed">{auth.authed ? "1" : "0"}</output>
        <output data-testid="draft-key">{draftKey ?? ""}</output>
        <output data-testid="auth-error">{auth.authError ?? ""}</output>
        {auth.authed && auth.user ? (
          <Composer draftKey={draftKey} onSend={() => {}} />
        ) : null}
      </ToastProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
