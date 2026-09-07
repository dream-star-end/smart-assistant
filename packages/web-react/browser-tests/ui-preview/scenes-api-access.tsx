import { SettingsCenter } from "../../src/components/SettingsCenter";
import { createMemoryAuthSession } from "../../src/lib/authSession";
import type { ApiKeySummary, ApiKeyUsageReport } from "../../src/lib/types";
import type { Scene } from "./types";

const auth = createMemoryAuthSession(() => {}, "preview-only");
const keys: ApiKeySummary[] = [
  {
    id: "preview-key",
    label: "MacBook · Claude Code",
    keyPrefix: "abcd1234",
    createdAt: "2026-09-01T09:00:00Z",
    lastUsedAt: "2026-09-07T08:00:00Z",
    disabledAt: null,
    creditLimit: "10000",
    spentCredits: "1234",
  },
];
const report: ApiKeyUsageReport = {
  window: "7d",
  key_id: null,
  summary: {
    requests: "42",
    input_tokens: "120000",
    output_tokens: "8000",
    cache_read_tokens: "0",
    cache_write_tokens: "0",
    credits: "1234",
  },
  trend: [
    { bucket: "2026-09-05", requests: "20", credits: "600" },
    { bucket: "2026-09-06", requests: "22", credits: "634" },
  ],
  by_key: [],
  by_model: [],
  recent: [],
};

export const apiAccessScenes: Scene[] = [
  {
    id: "settings-api-access",
    label: "API 接入 · 一键导入与密钥管理",
    group: "工作区",
    viewports: ["desktop", "mobile"],
    api: {
      listApiKeys: async () => keys,
      getApiKeyUsage: async () => report,
      getPublicModels: async () => ({
        models: [
          { id: "cursor-fable-5.1-high", engine: "cursor" },
          { id: "cursor-sonnet-5-high", engine: "cursor" },
          { id: "cursor-gemini-3.8-flash-low", engine: "cursor" },
        ],
      }),
      createApiKey: async (_auth, label) => ({
        id: "preview-created",
        label,
        keyPrefix: "1234abcd",
        plaintext: `oc-cc.1234abcd.${"ab".repeat(24)}`,
        createdAt: "2026-09-07T09:00:00Z",
      }),
    },
    render: () => (
      <SettingsCenter
        open
        auth={auth}
        user={{ id: "preview", displayName: "预览", role: "admin", roles: ["admin"] }}
        theme="light"
        onClose={() => {}}
        onSetTheme={() => {}}
        onOpenMemory={() => {}}
        initialSection="api-access"
      />
    ),
  },
];
