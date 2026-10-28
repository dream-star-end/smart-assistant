// OCV5-622 browser proof harness: the real refreshAuth (api/http.ts) with the real cross-tab lock.
import { refreshAuth } from "../src/lib/api/http";
import { createMemoryAuthSession } from "../src/lib/authSession";

const auth = createMemoryAuthSession(() => {});
(window as unknown as { __refresh: () => Promise<string> }).__refresh = async () => (await refreshAuth(auth)).kind;
